// A room may momentarily hold more than one peer announcing itself as the audio
// aggregator — a spawn race, or a lingering container from a redeploy. Only ONE
// may ever be honored: two active aggregators each solo the other (see
// presenceLevelFor in latency-instrument) and each taps + re-emits the other's
// published master, so the two mixes feed back into each other and both collapse
// to silence — exactly the "more than one aggregator and they both mute" failure.
//
// This is the single, deterministic election that every client AND every
// aggregator bot runs against the shared sidecar roster, so they all agree on
// the one winner with no extra coordination. The clients solo only the winner's
// master; the winning bot streams while every other aggregator bot stands down.
//
// Aggregators carry the reserved non-numeric room index (`pi`, see
// latency-instrument/room-indices.js), so they all sort as index-less
// (Infinity) and the deterministic jitsiId tiebreak picks the winner. The
// numeric comparison below still governs any aggregator that somehow holds an
// integer index (a legacy record), keeping the choice total either way:
// stable and identical on every client, re-run whenever the roster changes,
// so losing the winner promotes another announcer automatically.
//
// `peers` is any roster array of `{ isAggregator, jitsiId, roomIndex, ... }`
// records (e.g. peer-state's getAllPeers()). Returns the winning peer object, or
// null when the room has no aggregator.
export function electAggregator(peers) {
  let best = null;
  let bestIdx = Infinity;
  for (const p of peers || []) {
    if (!p || !p.isAggregator || !p.jitsiId) continue;
    // Guard the coercion: Number(null) and Number('') are 0, which would sort an
    // unindexed aggregator AHEAD of a real one. Treat any absent/blank/non-
    // numeric index as Infinity so it can only win when no indexed aggregator is
    // present.
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
