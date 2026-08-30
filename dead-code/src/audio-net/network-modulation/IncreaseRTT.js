// ARCHIVED 2026-08-29 — moved out of src/audio-net/network-modulation/ when
// WCRTT was removed from Net Cycles entirely (metric keyword, worst-case
// computation, CRDT modulation channel, studio readout, room's cascaded-lowpass
// cutoff). Revive by restoring the file here, re-adding `wcrtt` to EFFECT_METRICS
// / CRUSH_METRICS / ECHO_METRICS in MetaprogrammerParser.js and the av-effects
// metric maps, re-adding the `wcrtt: IncreaseRTT` entry to INDUCTIONS in
// WorstCaseCalculationUtils.js, and restoring Room.js's `wcrtt`-driven cutoff
// (it was repointed to `wcl` on removal).
//
// Artificial round-trip-time induction — upward-only floor under measured
// WCRTT (ms).

export const IncreaseRTT = Object.freeze({
  key: 'wcrtt',
  label: 'Induce RTT',
  unit: 'ms',
  min: 0,
  max: 10000,
  step: 10,
  clamp(value) {
    const v = Number(value);
    if (!isFinite(v)) return 0;
    return Math.min(this.max, Math.max(this.min, v));
  },
  applyTo(measured, induced) {
    return Math.max(measured || 0, this.clamp(induced));
  }
});
