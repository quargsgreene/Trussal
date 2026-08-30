// ARCHIVED 2026-08-29 — moved out of src/audio-net/network-modulation/ when WCJ
// was removed from Net Cycles entirely (metric keyword, worst-case computation,
// CRDT modulation channel, studio readout). Revive by restoring the file here,
// re-adding `wcj` to TIMING_METRICS / EFFECT_METRICS / CRUSH_METRICS / ECHO_*
// in MetaprogrammerParser.js and the av-effects metric maps, and re-adding the
// `wcj: IncreaseJitter` entry to INDUCTIONS in WorstCaseCalculationUtils.js.
//
// Artificial jitter induction — upward-only floor under measured WCJ (ms).

export const IncreaseJitter = Object.freeze({
  key: 'wcj',
  label: 'Induce jitter',
  unit: 'ms',
  min: 0,
  max: 1000,
  step: 1,
  clamp(value) {
    const v = Number(value);
    if (!isFinite(v)) return 0;
    return Math.min(this.max, Math.max(this.min, v));
  },
  applyTo(measured, induced) {
    return Math.max(measured || 0, this.clamp(induced));
  }
});
