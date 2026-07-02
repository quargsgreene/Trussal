// Worst-case network metric calculation for Net Cycles.
//
// Every client computes WCL/WCJ/WCRTT/WCPL from the same peer metrics
// broadcast over the peer-state bus, so all browsers derive identical cycle
// lengths and effect parameters from identical inputs. Pure module — no DOM,
// no WebAudio — so it runs under node:test as-is.
//
// `percentile` is ported from bots/src/shared/stats.js (R-7 linear
// interpolation, the numpy/Excel default) so fleet-side and room-side
// statistics agree.

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('percentile() requires a non-empty array');
  }
  if (p < 0 || p > 100) throw new RangeError('p must be in [0, 100]');
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

// Max over finite samples; null when nothing usable was supplied. The room's
// "worst case" is always the slowest/lossiest link, matching
// worstCaseLatency() in bots/src/shared/stats.js.
export function worstCase(values) {
  if (!Array.isArray(values)) return null;
  const finite = values.filter(v => typeof v === 'number' && isFinite(v));
  if (finite.length === 0) return null;
  return Math.max(...finite);
}

function peerRtt(peer) {
  // Prefer the RTCStats round-trip (media path) over the WS ping/pong
  // fallback (signalling path) when both are known.
  if (typeof peer.rtcRtt === 'number' && isFinite(peer.rtcRtt)) return peer.rtcRtt;
  if (typeof peer.rtt === 'number' && isFinite(peer.rtt)) return peer.rtt;
  return null;
}

// Worst-case metrics over the whole roster:
//   wcl   worst-case latency, ms (one-way estimate: rtt / 2)
//   wcj   worst-case jitter, ms
//   wcrtt worst-case round-trip time, ms
//   wcpl  worst-case packet loss, fraction in [0, 1]
//
// Peers with no usable sample for a given metric simply don't contribute to
// it. An empty roster (or all-null metrics) yields zeros so downstream cycle
// math degenerates to the minimum cycle length instead of NaN.
export function computeWorstCaseMetrics(peers) {
  const list = Array.isArray(peers) ? peers : [];
  const rtts = [];
  const jitters = [];
  const losses = [];
  for (const peer of list) {
    if (!peer) continue;
    const rtt = peerRtt(peer);
    if (rtt != null) rtts.push(rtt);
    if (typeof peer.jitter === 'number' && isFinite(peer.jitter)) jitters.push(peer.jitter);
    if (typeof peer.packetLoss === 'number' && isFinite(peer.packetLoss)) {
      losses.push(Math.min(1, Math.max(0, peer.packetLoss)));
    }
  }
  const wcrtt = worstCase(rtts) ?? 0;
  return {
    wcl: wcrtt / 2,
    wcj: worstCase(jitters) ?? 0,
    wcrtt,
    wcpl: worstCase(losses) ?? 0,
    sampleCount: rtts.length
  };
}
