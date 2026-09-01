// Artificial round-trip-time induction — upward-only floor under measured
// WCRTT (ms). Effective WCRTT = max(measured, induced), matching
// IncreaseLatency/IncreasePacketLoss.

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
