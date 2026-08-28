// ARCHIVED 2026-08-28 — moved out of src/latency-instrument.js as dead code.
//
// Three unused accessors. `getRoutedPeerIds` had no callers anywhere;
// `isAudioRoutedFor` and `isJamulusMode` were imported by src/studio.js but
// never called there.
//
// Module-private state they read (stayed in src/latency-instrument.js):
//   const audioRouted = new Set();   // jitsiIds whose remote audio is chained
//   let jamulusMode = false;         // toggled by setJamulusMode()

export function getRoutedPeerIds() {
  return Array.from(audioRouted);
}

export function isAudioRoutedFor(jitsiId) {
  return audioRouted.has(jitsiId);
}

export function isJamulusMode() { return jamulusMode; }
