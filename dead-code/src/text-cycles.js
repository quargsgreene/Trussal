// ARCHIVED 2026-08-28 — moved out of src/text-cycles.js as dead code.
//
// Exported but never imported. Text Cycles' active state is consulted internally
// via the module `active` flag and, for the turn gate, via peer-state's
// isPeerNetCyclesTurn.
//
// Module-private state (stayed in src/text-cycles.js):
//   let active = false;

export function isTextCyclesActive() { return active; }
