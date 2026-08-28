// ARCHIVED 2026-08-28 — moved out of src/strudel.js as dead code.
//
// Neither had a caller. `syncStrudelFromPeers` was an eager-rebuild entry point
// superseded by the internal re-evaluate on every peer-state change;
// `isStrudelPlaying` a getter nothing read.
//
// Module-private it touched (stayed in src/strudel.js):
//   let strudelBoot = null;          // resolves once the engine has booted
//   let anyPlaying  = false;         // any peer currently playing
//   async function rebuildAndEvaluate() { ... }

export async function syncStrudelFromPeers() {
  // Don't auto-boot; rebuild eagerly so the program is fresh when a user does
  // hit Play. If Strudel is already booted, evaluate immediately.
  if (!strudelBoot) return;
  await rebuildAndEvaluate();
}

export function isStrudelPlaying() { return anyPlaying; }
