// lib-jitsi-loader.js — bring in the lib-jitsi-meet bundle when the page does
// not already provide it.
//
// Inside the Jitsi Meet web app page, /libs/lib-jitsi-meet.min.js has already
// run by the time custom-config.js is evaluated, so window.JitsiMeetJS exists
// and this module is a no-op. A standalone Trussal deployment (no Jitsi web
// app) has to bring the library itself; the migration flag says to use it, so
// load it from a configured URL and wait for the global.
//
// URL resolution, in order:
//   1. an explicit `url` option (tests / callers that already resolved one);
//   2. window.__TRUSSAL_LIB_JITSI_URL — an operator override, e.g. a CDN;
//   3. window.config.libJitsiUrl (also accepts libJitsiMeetUrl);
//   4. 'libs/lib-jitsi-meet.min.js' relative to THIS bundle's URL, so a
//      deployment that ships the file beside custom-config.js — including one
//      served from a subdirectory — works with no configuration;
//   5. '/libs/lib-jitsi-meet.min.js', where the Jitsi web image exposes it.
//
// There is deliberately no cross-origin default. A multi-megabyte,
// security-relevant library should only ever come from a host the operator
// named, so a CDN is opt-in via (2)/(3) rather than a hard-coded fallback.

const DEFAULT_LIB_PATH = 'libs/lib-jitsi-meet.min.js';
const ROOT_LIB_PATH = '/libs/lib-jitsi-meet.min.js';
const DEFAULT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 50;

function currentWindow() {
  try {
    return typeof window !== 'undefined' ? window : null;
  } catch (e) {
    return null;
  }
}

/** The library global, or null. Mirrors lib-jitsi-bootstrap's getLibJitsi. */
export function getLibJitsi(win = currentWindow()) {
  try {
    return (win && win.JitsiMeetJS) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Where to load lib-jitsi-meet from, honouring the override chain above.
 * Always absolute, or the bare root path when no base is known.
 */
export function getLibJitsiUrl({ url, win = currentWindow(), bundleUrl } = {}) {
  if (url) return url;
  try {
    if (win && win.__TRUSSAL_LIB_JITSI_URL) return win.__TRUSSAL_LIB_JITSI_URL;
  } catch (e) { /* ignore */ }
  try {
    const cfg = win && win.config;
    const configured = cfg && (cfg.libJitsiUrl || cfg.libJitsiMeetUrl);
    if (configured) return configured;
  } catch (e) { /* ignore */ }
  // __TRUSSAL_BUNDLE_URL is captured by build.mjs's banner from the bundle's
  // own <script src>; typeof-guarded so this module also runs under node:test.
  const base = bundleUrl
    || (typeof __TRUSSAL_BUNDLE_URL !== 'undefined' ? __TRUSSAL_BUNDLE_URL : '');
  if (base) {
    try {
      return new URL(DEFAULT_LIB_PATH, base).href;
    } catch (e) { /* fall through to the root path */ }
  }
  return ROOT_LIB_PATH;
}

function resolveAgainst(base, value) {
  try {
    return base ? new URL(value, base).href : value;
  } catch (e) {
    return value;
  }
}

function hasScriptFor(doc, url, base) {
  try {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    const target = resolveAgainst(base, url);
    const scripts = doc.querySelectorAll('script');
    for (const script of (scripts || [])) {
      const raw = (script && (script.src || (typeof script.getAttribute === 'function'
        ? script.getAttribute('src') : ''))) || '';
      if (raw && resolveAgainst(base, raw) === target) return true;
    }
  } catch (e) { /* a stub without querySelectorAll just reports "not found" */ }
  return false;
}

function injectScript(url, doc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let script = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (script) {
        script.onload = null;
        script.onerror = null;
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out loading ${url}`));
    }, timeoutMs);

    try {
      script = doc.createElement('script');
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }
    script.src = url;
    script.async = true;
    script.onload = () => { cleanup(); resolve(); };
    script.onerror = () => { cleanup(); reject(new Error(`failed to load ${url}`)); };

    const parent = doc.head || doc.documentElement || doc.body;
    if (!parent || typeof parent.appendChild !== 'function') {
      cleanup();
      reject(new Error('no document head to append the lib-jitsi-meet script to'));
      return;
    }
    try {
      parent.appendChild(script);
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLibJitsi(win, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const lib = getLibJitsi(win);
    if (lib) return lib;
    if (Date.now() - startedAt >= timeoutMs) return null;
    await wait(POLL_INTERVAL_MS);
  }
}

// One in-flight load shared by concurrent callers, so a page load never adds
// two <script> tags for the same library.
let loading = null;

/**
 * Resolve the lib-jitsi-meet global, loading the bundle first if the page does
 * not already have it. Resolves to window.JitsiMeetJS, or null when the library
 * is unavailable (no DOM, load failure, or the script loaded without defining
 * the global).
 */
export async function ensureLibJitsi(options = {}) {
  const win = options.window || currentWindow();
  const existing = getLibJitsi(win);
  if (existing) return existing;
  if (!win) return null;
  if (loading) return loading;

  const url = getLibJitsiUrl({ url: options.url, win, bundleUrl: options.bundleUrl });
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const doc = options.document
    || (win && win.document)
    || (typeof document !== 'undefined' ? document : null);

  loading = (async () => {
    try {
      if (!doc) {
        console.warn('[lib-jitsi-loader] no document available to load', url);
        return null;
      }
      // The page may already be fetching the bundle with its own <script> tag
      // (the Jitsi web page does); appending a second one would download the
      // multi-MB file twice, so just wait for the global.
      const base = (doc && doc.baseURI)
        || (win && win.location && win.location.href)
        || '';
      if (!hasScriptFor(doc, url, base)) {
        console.log('[lib-jitsi-loader] loading', url);
        await injectScript(url, doc, timeoutMs);
      }
      const lib = await waitForLibJitsi(win, timeoutMs);
      if (!lib) {
        console.warn('[lib-jitsi-loader] script loaded but window.JitsiMeetJS never appeared:', url);
      }
      return lib;
    } catch (e) {
      console.warn('[lib-jitsi-loader] could not load the lib-jitsi-meet bundle', url, e);
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** Test seam: forget the in-flight load so a suite can start clean. */
export function resetLibJitsiLoader() {
  loading = null;
}
