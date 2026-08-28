// ARCHIVED 2026-08-28 — moved out of src/peer-state.js as dead code.
//
// No callers. `myPeerId` is the id the sidecar hands back in its `welcome`
// message; internal code that needs it reads the module variable directly.
//
// Module-private state (stayed in src/peer-state.js):
//   let myPeerId = null;   // set from the sidecar `welcome` frame

export function getMyPeerId() { return myPeerId; }
