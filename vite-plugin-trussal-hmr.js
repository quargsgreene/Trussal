// vite-plugin-trussal-hmr.js — dev-only hot-update boundaries.
//
// Vite's HMR API is module-local: only the module being replaced can accept its
// own update. Putting those accept blocks in the UI modules spreads dev-only
// plumbing through app code and leaves it in the production bundle (esbuild
// only replaces import.meta, it does not remove the branches). This plugin
// injects the wiring while Vite serves the modules instead:
//
//   * every project module that imports a .css file as raw text gets a mutable
//     binding for that import and an accept callback that rewrites whichever
//     <style> element holds the previous text. The module keeps calling its own
//     upsertStyle() injector; it never mentions HMR.
//   * true leaves (SELF_ACCEPTING below) get a self-accepting boundary, so an
//     edit to them does not re-run the app graph, plus a dispose hook that
//     releases the observers/timers they keep at module scope.
//   * stable-state.js gets its import.meta.hot.data hand-off, so its singleton
//     (and every socket, map and timer it holds) survives its own updates.
//
// Everything here is serve-only, and production uses build.mjs (esbuild), so no
// injected line can reach dist/custom-config.js.

import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Leaves whose edits stop at the module. `rerender` is invoked on the *new*
// module namespace: Vite runs the accept callback in the previous instance's
// closure, so the local function bindings would still be the old code.
// `dispose` lists the module-scope handles to release before re-evaluation.
const SELF_ACCEPTING = {
  'src/welcome-page.js': {
    rerender: [
      'renderWelcomeOverlay',
      'renderRecentListText',
      'renderPrejoinScreen',
      'renderHideStartMeetingButton',
    ],
    // renderWelcomeOverlay()/renderTrussalWelcomeOverlay() is deliberately
    // idempotent — the boot poll calls it every 250ms and it returns early if
    // the overlay already exists. That also made it a no-op for HMR: the accept
    // callback reran it, saw the old overlay, and left the old markup in place.
    // Drop the overlay in dispose (the new module's rerender rebuilds it) and
    // carry the half-typed room name across so a save doesn't clear the field.
    dispose: [
      ['interval', 'overlayPoll'],
      ['observer', 'prejoinObserver'],
      ['observer', 'recentObserver'],
      ['observer', 'hideObserver'],
      ['element', 'trussal-welcome-overlay'],
    ],
    preserveInput: 'trussal-room-input',
  },
  'src/docs-about.js': {
    rerender: [],
    // The corner is built once per module evaluation and _ensureDOM() returns
    // early while it exists. Remove the old corner in dispose so the freshly
    // evaluated module's init() rebuilds it from the new markup.
    dispose: [['interval', 'bootTimer'], ['element', 'trussal-da-corner']],
  },
};

const STABLE_STATE = 'src/stable-state.js';
const STABLE_STATE_INITIAL = 'const state = createState();';

// Default imports of raw-text stylesheets. The modules all use the plain
// `import styles from './x.css'` form; anything else (side-effect imports,
// ?raw/?url queries, CSS modules) is deliberately left to Vite.
const CSS_IMPORT_RE = /^([ \t]*)import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+\.css)\3;?[ \t]*$/gm;

const relPath = (id) => relative(ROOT, id.split('?')[0]).split(sep).join('/');

function cssWiring(code) {
  let n = 0;
  const accepts = [];

  code = code.replace(CSS_IMPORT_RE, (_match, indent, local, quote, spec) => {
    const initial = `__trussalHmrCss${n++}`;
    accepts.push({ local, spec });
    return `${indent}import ${initial} from ${quote}${spec}${quote};\n${indent}let ${local} = ${initial};`;
  });

  const wiring = accepts.map(({ local, spec }) => `  import.meta.hot.accept(${JSON.stringify(spec)}, (mod) => {
    const previous = ${local};
    ${local} = mod.default;
    for (const el of document.querySelectorAll('style')) {
      if (el.textContent === previous) el.textContent = mod.default;
    }
  });`);

  return { code, wiring };
}

function selfAcceptWiring(cfg, rel) {
  const wiring = [];
  const inputId = cfg.preserveInput;
  // The dispose hook (below) stashes the field value in import.meta.hot.data;
  // Vite runs dispose before the accept callback, so the callback can restore
  // it after the rerender has rebuilt the overlay.
  const readPreserved = inputId
    ? '    const __trussalInput = import.meta.hot.data.__trussalInput;'
    : '';
  const restoreInput = inputId
    ? `
      const input = document.getElementById(${JSON.stringify(inputId)});
      if (input && typeof __trussalInput === 'string') input.value = __trussalInput;`
    : '';

  if (cfg.rerender.length === 0) {
    wiring.push('  import.meta.hot.accept();');
  } else {
    const calls = cfg.rerender.map((name) => `      mod.${name}();`).join('\n');
    wiring.push(`  import.meta.hot.accept((mod) => {
${readPreserved}
    if (!mod) return;
    try {
${calls}${restoreInput}
    } catch (e) {
      console.warn('[hmr] ${rel} update failed', e);
    }
  });`);
  }

  if (cfg.dispose.length > 0) {
    const lines = cfg.dispose.map(([kind, name]) => {
      if (kind === 'interval') return `    if (${name}) clearInterval(${name});`;
      if (kind === 'observer') return `    if (${name}) ${name}.disconnect();`;
      if (kind === 'element') return `    document.getElementById(${JSON.stringify(name)})?.remove();`;
      throw new Error(`[trussal-hmr] unknown dispose kind: ${kind}`);
    }).join('\n');
    const saveInput = inputId
      ? `    import.meta.hot.data.__trussalInput = document.getElementById(${JSON.stringify(inputId)})?.value ?? null;\n`
      : '';
    wiring.push(`  import.meta.hot.dispose(() => {\n${saveInput}${lines}\n  });`);
  }

  return wiring;
}

export function trussalHmr() {
  return {
    name: 'trussal-hmr-boundaries',
    apply: 'serve',
    // Run before Vite's import analysis so the injected accept() dependencies
    // are rewritten to module URLs exactly like hand-written ones.
    enforce: 'pre',

    transform(code, id) {
      const rel = relPath(id);
      if (!rel.endsWith('.js')) return null;
      if (!rel.startsWith('src/') && !rel.startsWith('components/')) return null;

      let changed = false;

      if (rel === STABLE_STATE) {
        if (!code.includes(STABLE_STATE_INITIAL)) {
          this.error(`[trussal-hmr] expected "${STABLE_STATE_INITIAL}" in ${rel}`);
        }
        code = code.replace(
          STABLE_STATE_INITIAL,
          'const state = (import.meta.hot && import.meta.hot.data.state) || createState();\n' +
          'if (import.meta.hot) import.meta.hot.data.state = state;',
        );
        changed = true;
      }

      const css = cssWiring(code);
      code = css.code;
      if (css.wiring.length > 0) changed = true;

      const self = SELF_ACCEPTING[rel];
      const wiring = self ? [...css.wiring, ...selfAcceptWiring(self, rel)] : css.wiring;

      if (wiring.length > 0) {
        code += `\n// injected by vite-plugin-trussal-hmr (dev only)\nif (import.meta.hot) {\n${wiring.join('\n\n')}\n}\n`;
        changed = true;
      }

      return changed ? { code, map: null } : null;
    },
  };
}
