// Core O2lite serialization for the browser bundle.
//
// The actual wire-format implementation is the CommonJS module at
// latency-instrument/o2lite-format.js — the O2 relay runs inside the CJS
// sidecar container and must require() it, while the browser bundle
// interops it through this ESM facade. Both sides serialize identically by
// construction. See that file for the message layout.
//
// The facade imports the default binding and re-exports the names: in the
// prod bundle esbuild's CJS interop makes the default `module.exports`, and
// the dev server serves the same shape (vite.config.js "trussal-latency-cjs").
import o2liteFormat from '../../latency-instrument/o2lite-format.js';

export const {
  O2L_FLAG_TCP,
  serializeMessage,
  deserializeMessage,
  CS_GET,
  CS_REPLY
} = o2liteFormat;
