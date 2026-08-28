// ARCHIVED 2026-08-28 — moved out of src/facial-gesture.js as dead code.
//
// Leftovers from an earlier gesture/cooldown implementation. The live code
// debounces with the `_latch` object + `LATCH_RESET`, and reads blink/jaw off
// the MediaPipe blendshapes directly, so these constants and the per-action
// timestamp map had no remaining reader.

// Detection thresholds — identical to strudel-fork's useFacialGestures.jsx.
const BLINK_THRESHOLD      = 0.8;
const JAW_OPEN_THRESHOLD   = 0.5;
const COOLDOWN_MS          = 1500;

// Last time each action fired, for a fixed-interval cooldown.
const _lastFired  = { play: 0, stop: 0 };
