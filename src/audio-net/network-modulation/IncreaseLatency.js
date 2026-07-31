// Artificial latency induction: an upward-only floor under the measured
// worst-case latency. Effective WCL = max(measured WCL, induced) — inducing
// below what the network truly does is a no-op, never an improvement.

export const IncreaseLatency = Object.freeze({
  key: 'wcl',
  label: 'Induce latency',
  unit: 'ms',
  min: 0,
  max: 5000,
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
