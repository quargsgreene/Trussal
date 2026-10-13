export function electAggregator(peers) {
  let best = null;
  let bestIdx = Infinity;
  for (const p of peers || []) {
    if (!p || !p.isAggregator || !p.jitsiId) continue;
    const raw = p.roomIndex;
    const parsed = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    const idx = Number.isFinite(parsed) ? parsed : Infinity;
    if (
      best === null ||
      idx < bestIdx ||
      (idx === bestIdx && String(p.jitsiId) < String(best.jitsiId))
    ) {
      best = p;
      bestIdx = idx;
    }
  }
  return best;
}
