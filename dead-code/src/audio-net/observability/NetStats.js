// ARCHIVED 2026-08-28 — moved out of src/audio-net/observability/NetStats.js as
// dead code.
//
// Teardown counterpart to startNetStatsPolling(). The RTCStats poll runs for
// the page lifetime; nothing stopped it.
//
// Module-private state (stayed in NetStats.js):
//   let pollTimer = null;   // setInterval handle for pollOnce()

export function stopNetStatsPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
