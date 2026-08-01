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

import { IncreaseLatency } from './IncreaseLatency.js';
import { IncreaseJitter } from './IncreaseJitter.js';
import { IncreaseRTT } from './IncreaseRTT.js';
import { IncreasePacketLoss } from './IncreasePacketLoss.js';

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

// Fixed allowance for the parts of the audio pipeline WebRTC does not expose:
// Opus encode + decode, and the capture/playout device buffers at each end.
// getStats reports the de-jitter buffer but nothing either side of it, so this
// is an explicit ESTIMATE rather than a measurement — named and separate so it
// is obvious in the readout what is measured and what is assumed.
export const PIPELINE_ALLOWANCE_MS = 40;

// Worst-case one-way MOUTH-TO-EAR latency between two performers, in ms.
//
// Every client holds one PeerConnection to the JVB (P2P is off), so the audio
// path is sender -> JVB -> receiver and the network part of one-way latency is
//     rtt(sender)/2 + rtt(receiver)/2
// i.e. the two worst legs halved and summed — NOT max(rtt)/2, which halves a
// figure that was already a single leg and so under-reported the network by
// about 2x. With one peer we have no partner leg to measure and assume a
// symmetric one, which makes the network term simply that peer's rtt.
//
// On top of the network path sit the terms that actually dominate: the
// receive-side de-jitter buffer (measured, tens of ms) and PIPELINE_ALLOWANCE_MS
// (assumed). On a LAN the network is single-digit ms while the buffer alone is
// an order of magnitude more, which is why a network-only figure read as
// implausibly small for anything a musician can hear.
export function worstCaseOneWayLatency(rtts, jitterBufferMs) {
  const sorted = [...rtts].sort((a, b) => b - a);
  if (!sorted.length) return 0;
  const worst = sorted[0];
  // Second leg: the next-worst peer, or a symmetric partner when alone.
  const partner = sorted.length > 1 ? sorted[1] : worst;
  const network = worst / 2 + partner / 2;
  return network + (jitterBufferMs || 0) + PIPELINE_ALLOWANCE_MS;
}

// Worst-case metrics over the whole roster:
//   wcl   worst-case one-way mouth-to-ear latency, ms (see above)
//   wcj   worst-case jitter, ms
//   wcrtt worst-case round-trip time, ms
//   wcpl  worst-case packet loss, fraction in [0, 1]
//
// Peers with no usable sample for a given metric simply don't contribute to
// it. An empty roster (or all-null metrics) yields zeros so downstream cycle
// math degenerates to the minimum cycle length instead of NaN.
//
// wcl models what a performer HEARS, not the network leg alone. The scale
// factor in `# cycles wcl <n>` carries the musical inflation (the default
// program's `# cycles wcl 20`), so the studio readout and av-effects see a
// real, physically meaningful latency in the tens of milliseconds.
export function computeWorstCaseMetrics(peers) {
  const list = Array.isArray(peers) ? peers : [];
  const rtts = [];
  const jitters = [];
  const losses = [];
  const jitterBuffers = [];
  for (const peer of list) {
    if (!peer) continue;
    const rtt = peerRtt(peer);
    if (rtt != null) rtts.push(rtt);
    if (typeof peer.jitter === 'number' && isFinite(peer.jitter)) jitters.push(peer.jitter);
    if (typeof peer.jitterBufferMs === 'number' && isFinite(peer.jitterBufferMs)) {
      jitterBuffers.push(peer.jitterBufferMs);
    }
    if (typeof peer.packetLoss === 'number' && isFinite(peer.packetLoss)) {
      losses.push(Math.min(1, Math.max(0, peer.packetLoss)));
    }
  }
  const wcrtt = worstCase(rtts) ?? 0;
  return {
    wcl: worstCaseOneWayLatency(rtts, worstCase(jitterBuffers) ?? 0),
    wcj: worstCase(jitters) ?? 0,
    wcrtt,
    wcjb: worstCase(jitterBuffers) ?? 0,
    wcpl: worstCase(losses) ?? 0,
    sampleCount: rtts.length
  };
}

export const INDUCTIONS = Object.freeze({
  wcl: IncreaseLatency,
  wcj: IncreaseJitter,
  wcrtt: IncreaseRTT,
  wcpl: IncreasePacketLoss
});

// Layer artificially induced conditions onto measured worst-case values.
// Strictly upward: effective = max(measured, induced) per metric, so an
// induced value below the network's truth is a no-op. Shared via CRDT, so
// every client computes identical effective values from identical inputs.
export function mergeInducedMetrics(measured, induced) {
  const m = measured || {};
  const i = induced || {};
  const out = { ...m };
  for (const [key, mod] of Object.entries(INDUCTIONS)) {
    out[key] = mod.applyTo(m[key] || 0, i[key] || 0);
  }
  return out;
}

// Worst-case metrics for one VLAN: computed over its member peers only,
// merged with the VLAN's own induced conditions. `vlan` is
// { members: [roomIndex, …], induced: { wcl, … } }.
export function computeVlanWorstCase(peers, vlan) {
  const memberSet = new Set((vlan && vlan.members) || []);
  const members = (peers || []).filter(p => p.roomIndex != null && memberSet.has(String(p.roomIndex)));
  return mergeInducedMetrics(computeWorstCaseMetrics(members), vlan && vlan.induced);
}

// Equal-power mix-down gains: all VLANs sum to one master bus without
// clipping as VLAN count grows. Empty input degenerates to the single
// mutual VLAN at unity.
export function vlanMixGains(vlanNames) {
  const names = (vlanNames && vlanNames.length) ? vlanNames : ['default'];
  const g = 1 / Math.sqrt(names.length);
  return Object.fromEntries(names.map(n => [n, g]));
}
