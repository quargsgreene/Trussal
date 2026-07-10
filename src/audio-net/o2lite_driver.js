// Core O2lite serialization for the browser bundle.
//
// The actual wire-format implementation is the CommonJS module at
// latency-instrument/o2lite-format.js — the O2 relay runs inside the CJS
// sidecar container and must require() it, while esbuild interops it into
// the bundle through this ESM facade. Both sides serialize identically by
// construction. See that file for the message layout.

export {
  O2L_FLAG_TCP,
  serializeMessage,
  deserializeMessage,
  CS_GET,
  CS_REPLY
} from '../../latency-instrument/o2lite-format.js';
