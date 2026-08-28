// ARCHIVED 2026-08-28 — moved out of
// src/audio-net/observability/PipelineLatency.js as dead code.
//
// Teardown counterpart to startPipelineLatencyMeasurement(). The loopback
// re-measure runs for the page lifetime; nothing stopped it.
//
// Module-private state (stayed in PipelineLatency.js):
//   let measureTimer = null;   // setInterval handle for the re-measure loop

export function stopPipelineLatencyMeasurement() {
  if (measureTimer) { clearInterval(measureTimer); measureTimer = null; }
}
