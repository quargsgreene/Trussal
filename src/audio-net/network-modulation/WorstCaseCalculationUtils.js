// Worst-case network metric calculation for Net Cycles.
//
// Every client computes WCL/WCPL from the same peer metrics broadcast over the
// peer-state bus, so all browsers derive identical cycle lengths and effect
// parameters from identical inputs. Pure module — no DOM, no WebAudio — so it
// runs under node:test as-is.
//
// `percentile` is ported from bots/src/shared/stats.js (R-7 linear
// interpolation, the numpy/Excel default) so fleet-side and room-side
// statistics agree.

import { IncreaseLatency } from './IncreaseLatency.js';
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
  // fallback (signalling path) when both are known. Feeds WCL's two network
  // legs (worstCaseOneWayLatency); it is no longer exposed on its own.
  if (typeof peer.rtcRtt === 'number' && isFinite(peer.rtcRtt)) return peer.rtcRtt;
  if (typeof peer.rtt === 'number' && isFinite(peer.rtt)) return peer.rtt;
  return null;
}

// Fallback for a rig that has not reported a measured pipeline latency yet —
// a peer that just joined, or a client too old to run the loopback. Rigs
// MEASURE this for real (see observability/PipelineLatency.js: a local
// RTCPeerConnection loopback through Opus, plus the platform's device-buffer
// report), so this constant is a placeholder for the first few seconds, not
// the model's answer. It is deliberately mid-range: a typical laptop with
// default devices, so an unmeasured peer neither flatters nor panics the room.
export const PIPELINE_ALLOWANCE_MS = 40;

// Worst-case one-way MOUTH-TO-EAR latency between two performers, in ms — an
// UPPER BOUND over every path in the room, built from each rig's own numbers.
//
// Every client holds one PeerConnection to the JVB (P2P is off), so the audio
// path for a pair is sender -> JVB -> receiver:
//
//     pipeline(sender) + rtt(sender)/2 + rtt(receiver)/2
//         + jitterBuffer(receiver) + pipeline(receiver)
//
// Each term is taken at its worst across the roster INDEPENDENTLY, which is
// what makes the result a bound rather than a specific pair's latency: no real
// path can exceed it, and it is monotone — one rig getting worse can only push
// it up. The two network legs are the two worst legs halved and summed, NOT
// max(rtt)/2, which halves a figure that was already a single leg and so
// under-reported the network by about 2x.
//
// `pipeline` is each rig's MEASURED local latency (capture, Opus encode/decode,
// playout — see PipelineLatency.js); it is counted once at the worst rig rather
// than twice, since a bound built from the worst sender and the worst receiver
// already dominates any real pair. Alone in a room there is no partner leg to
// measure, so a symmetric one is assumed.
//
// On a LAN the network is single-digit ms while the buffer and the rig pipeline
// are each an order of magnitude more — which is why a network-only figure read
// as implausibly small for anything a musician can hear.
export function worstCaseOneWayLatency(rtts, jitterBufferMs, pipelineMs) {
  const sorted = [...rtts].sort((a, b) => b - a);
  if (!sorted.length) return 0;
  const worst = sorted[0];
  const partner = sorted.length > 1 ? sorted[1] : worst;
  const network = worst / 2 + partner / 2;
  const pipeline = (typeof pipelineMs === 'number' && isFinite(pipelineMs))
    ? pipelineMs : PIPELINE_ALLOWANCE_MS;
  return network + (jitterBufferMs || 0) + pipeline;
}

// Worst-case metrics over the whole roster:
//   wcl   worst-case one-way mouth-to-ear latency, ms (see above)
//   wcpl  worst-case packet loss, fraction in [0, 1]
//
// wcjb / wcpipe are wcl's own broken-out terms (de-jitter buffer, rig
// pipeline), kept for the studio's "WCL = net + buffer + rig" readout.
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
  const losses = [];
  const jitterBuffers = [];
  const pipelines = [];
  for (const peer of list) {
    if (!peer) continue;
    const rtt = peerRtt(peer);
    if (rtt != null) rtts.push(rtt);
    if (typeof peer.jitterBufferMs === 'number' && isFinite(peer.jitterBufferMs)) {
      jitterBuffers.push(peer.jitterBufferMs);
    }
    // A rig that has not measured itself yet contributes the fallback, so a
    // fresh joiner cannot drag the room's bound BELOW what is already known.
    pipelines.push(
      typeof peer.pipelineMs === 'number' && isFinite(peer.pipelineMs)
        ? peer.pipelineMs : PIPELINE_ALLOWANCE_MS,
    );
    if (typeof peer.packetLoss === 'number' && isFinite(peer.packetLoss)) {
      losses.push(Math.min(1, Math.max(0, peer.packetLoss)));
    }
  }
  const wcjb = worstCase(jitterBuffers) ?? 0;
  const wcpipe = worstCase(pipelines) ?? PIPELINE_ALLOWANCE_MS;
  return {
    wcl: worstCaseOneWayLatency(rtts, wcjb, wcpipe),
    wcjb,
    wcpipe,
    // How many rigs actually measured their own pipeline, so a readout can say
    // whether the bound rests on measurement or on the fallback.
    pipelineMeasured: list.filter(p => p && typeof p.pipelineMs === 'number' && isFinite(p.pipelineMs)).length,
    wcpl: worstCase(losses) ?? 0,
    sampleCount: rtts.length
  };
}

export const INDUCTIONS = Object.freeze({
  wcl: IncreaseLatency,
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
