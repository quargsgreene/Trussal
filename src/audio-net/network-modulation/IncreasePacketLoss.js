// Artificial packet-loss induction — upward-only floor under measured WCPL,
// as a fraction in [0, 1].

export const IncreasePacketLoss = Object.freeze({
  key: 'wcpl',
  label: 'Induce packet loss',
  unit: 'fraction',
  min: 0,
  max: 1,
  step: 0.01,
  clamp(value) {
    const v = Number(value);
    if (!isFinite(v)) return 0;
    return Math.min(this.max, Math.max(this.min, v));
  },
  applyTo(measured, induced) {
    return Math.max(measured || 0, this.clamp(induced));
  }
});
