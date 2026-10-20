// entry-hmr.js — development entry (served at /custom-config.js by Vite,
// see vite.config.js "trussal-custom-config").
//
// This module is the fallback HMR boundary for the app graph. It statically
// imports index.js, which does two jobs:
//
//   * the import edge is recorded in Vite's module graph, so an edit to
//     anything below index.js is routed here as a hot update instead of a
//     full page reload;
//   * when Vite re-transforms this module for an update it rewrites the
//     index.js import with a fresh ?t= cache-buster (Vite does that for every
//     import of an invalidated module), so the new instance's import really
//     downloads and executes the new code.
//
// Modules with an injected boundary (see vite-plugin-trussal-hmr.js) never
// reach this fallback: welcome-page.js and docs-about.js self-accept in dev,
// and every module that imports a raw-text stylesheet accepts that CSS, so a
// CSS-only edit just swaps the <style> text. Everything else is handled here,
// re-running the app graph without a reload.
//
// Update sequence for the fallback path, no reload, no WebRTC teardown:
//
//   1. the client runs the dispose hook below first, draining the previous
//      pass's subscriptions/timers (see hmr-runtime.js) before the new
//      index.js has run;
//   2. the fresh instance of this module executes, and its static import
//      pulls in the new index.js — top-level initialization runs again
//      against the surviving stable state (WebSocket, peers, Yjs docs,
//      timers: see stable-state.js).
//
// index.js itself stays free of `import.meta.hot` (it is also the production
// bundle entry). The dev-only accept/dispose blocks are injected by
// vite-plugin-trussal-hmr.js, and stable-state.js receives its live WebSocket,
// peer maps, Yjs docs and timers from the same plugin through
// `import.meta.hot.data`.

import './index.js';
import { drainDisposes } from './hmr-runtime.js';

function runDisposes() {
  for (const fn of drainDisposes()) {
    try { fn(); } catch (e) { console.warn('[HMR] dispose failed', e); }
  }
}

if (import.meta.hot) {
  // Runs before the updated instance is fetched (the client awaits dispose
  // hooks before importing the new module): old subscriptions are gone before
  // the new pass subscribes.
  import.meta.hot.dispose(runDisposes);
  // Self-accepting: updates below this module stop here (no full reload).
  import.meta.hot.accept();
}
