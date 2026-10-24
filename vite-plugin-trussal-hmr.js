// vite-plugin-trussal-hmr.js — dev-only hot-update boundaries.
//
// Vite's HMR API is module-local: only the module being replaced can accept its
// own update. Putting those accept blocks in the UI modules spreads dev-only
// plumbing through app code and leaves it in the production bundle (esbuild
// only replaces import.meta, it does not remove the branches). This plugin
// injects the wiring while Vite serves the modules instead:
//
//   * src/styles.css is the single stylesheet entry. Vite's own CSS HMR owns
//     it (and its @imports), so nothing CSS-related is injected here.
//   * true leaves (SELF_ACCEPTING below) get a self-accepting boundary, so an
//     edit to them does not re-run the app graph, plus a dispose hook that
//     releases the observers/timers they keep at module scope.
//   * stable-state.js gets its import.meta.hot.data hand-off, so its singleton
//     (and every socket, map and timer it holds) survives its own updates.
//   * the app-level fallback disposers in index.js / conductor-settings.js are
//     injected as native import.meta.hot.dispose hooks, so Vite runs each one
//     only when that module is actually being re-evaluated. An unrelated
//     fallback no longer tears down a module that will stay cached. The HMR
//     verification probes are injected for the same reason: production source
//     carries no test counters or dev runtime.
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

// Cleanup for modules whose top-level work outlives their evaluation
// (subscriptions, timers, window listeners). Vite does not call a module's
// dispose hook when that module is re-evaluated incidentally as a dependency of
// a fallback, so the new instance also runs the previous cleanup stored in
// hot.data. The guard makes the direct-dispose and re-entry paths idempotent.
// An unrelated index-only edit therefore leaves conductor-settings untouched.
const DEV_DISPOSE = {
  'src/index.js': `  let __trussalDisposed = false;
  const __trussalDispose = () => {
    if (__trussalDisposed) return;
    __trussalDisposed = true;
    unsubMapperSync();
    unsubReannounce();
  };
  import.meta.hot.data.trussalDispose?.();
  import.meta.hot.data.trussalDispose = __trussalDispose;
  import.meta.hot.dispose(__trussalDispose);`,
  'src/conductor-settings.js': `  let __trussalDisposed = false;
  const __trussalDispose = () => {
    if (__trussalDisposed) return;
    __trussalDisposed = true;
    clearInterval(tickTimer);
    unsubscribeFleet();
    window.removeEventListener('pagehide', onPageHide);
    closePanel();
  };
  import.meta.hot.data.trussalDispose?.();
  import.meta.hot.data.trussalDispose = __trussalDispose;
  import.meta.hot.dispose(__trussalDispose);`,
};

// Counters the HMR verification scripts read. Injected so they aren't test
// scaffolding in the production bundle.
const DEV_PROBES = {
  'src/index.js': 'window.__hmrProbe = (window.__hmrProbe || 0) + 1;',
  'src/docs-about.js': 'window.__hmrDepProbe = (window.__hmrDepProbe || 0) + 1;',
};

const relPath = (id) => relative(ROOT, id.split('?')[0]).split(sep).join('/');

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

      const self = SELF_ACCEPTING[rel];
      const wiring = self ? selfAcceptWiring(self, rel) : [];

      if (wiring.length > 0) {
        code += `\n// injected by vite-plugin-trussal-hmr (dev only)\nif (import.meta.hot) {\n${wiring.join('\n\n')}\n}\n`;
        changed = true;
      }

      const devDispose = DEV_DISPOSE[rel];
      const probe = DEV_PROBES[rel];
      if (devDispose) {
        code += `\n// injected by vite-plugin-trussal-hmr (dev only)\nif (import.meta.hot) {\n${devDispose}\n}\n`;
        changed = true;
      }
      if (probe) {
        code += `\n${probe}\n`;
        changed = true;
      }

      return changed ? { code, map: null } : null;
    },
  };
}
