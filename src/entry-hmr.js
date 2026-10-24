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
// reach this fallback: welcome-page.js and docs-about.js self-accept in dev.
// src/styles.css is a normal Vite CSS import, so a CSS-only edit is handled by
// Vite's CSS HMR and never reaches this fallback either. Everything else is
// handled here, re-running the app graph without a reload.
//
// Update sequence for the fallback path, no reload, no WebRTC teardown:
//
//   1. each re-evaluated module first runs its previous instance's cleanup
//      (stored in hot.data, with a native dispose hook as the direct-update
//      path). A module that is not invalidated keeps its timer and
//      subscriptions instead of being torn down and never restarted;
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

if (import.meta.hot) {
  // Self-accepting: updates below this module stop here (no full reload).
  // Each invalidated module's own injected dispose hook has already run.
  import.meta.hot.accept();
}
