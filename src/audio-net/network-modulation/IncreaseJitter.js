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
