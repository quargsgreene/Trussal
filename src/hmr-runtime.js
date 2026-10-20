// hmr-runtime.js — HMR glue shared by the dev entry and the stable state.
//
// Deliberately contains no direct `import.meta.hot` access: this file is part
// of the production bundle too, and is importable from plain Node (the bots).
// The hot API stays in the dev entry (entry-hmr.js) and in the serve-only Vite
// plugin (vite-plugin-trussal-hmr.js).

// Callbacks the current app pass wants run before the next pass re-initializes
// (event subscriptions and the like). entry-hmr.js drains these.
let disposeCallbacks = [];

// Register a dispose callback. No-op semantics in production: nothing drains
// the list and holding a few closures is harmless — but keep the call sites
// (index.js) shared between dev and prod so behavior can't drift.
export function onHmrDispose(fn) {
  disposeCallbacks.push(fn);
}

// Hand over the pending dispose callbacks and clear the list.
export function drainDisposes() {
  const fns = disposeCallbacks;
  disposeCallbacks = [];
  return fns;
}

// State that must survive a hot re-init but lives in modules that are
// re-executed (index.js): keep it here, where the module instance is stable.
export const hmrState = {
  lastAnnouncedPattern: null,
};

// State registries. stable-state.js owns the live WebSocket, peer maps, Yjs
// docs and Strudel instances, so it never needs these to cross an update
// boundary; they remain as the shared hook for future modules that do.
export function registerYjsDoc() {}
export function registerStrudelInstance() {}
export function registerPeerStateSubscriber() {}
