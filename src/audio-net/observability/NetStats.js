// RTCStatsReport polling for the Network Metrics service.
//
// Walks the same lib-jitsi-meet peer-connection map latency-instrument.js
// uses for mic propagation (conf._room.rtc.peerConnections), calls
// getStats() on each underlying RTCPeerConnection, and derives the local
// link's RTT / jitter / packet-loss. The derived sample is broadcast on the
// peer-state bus (extended `metrics` message) so every browser sees every
// peer's own network truth; WS ping/pong stays as the fallback when no
// RTCStats are available (e.g. alone in the room, or before media flows).
//
// The stats-report → sample derivation is a pure function so it runs under
// node:test against captured JSON fixtures. The module deliberately does not
// import peer-state.js — the poller takes the broadcast function as an
// argument (studio.js passes sendLocalNetStats) so the pure parts stay
// importable outside the browser.

const POLL_INTERVAL_MS = 2000;

// Derive one network sample from an RTCStatsReport (as an array of stats
// entries — `Array.from(report.values())`).
//
//   rtcRtt     ms — selected candidate-pair currentRoundTripTime, falling
//              back to remote-inbound-rtp roundTripTime (both arrive in s).
//   rtcJitter  ms — worst AUDIO-only inbound/remote-inbound-rtp jitter
//              (arrives in s). Audio-only because this is what WCJ is built
//              from, and video jitter on the same connection would otherwise
//              dominate the max. Note jitterBufferMs below is NOT filtered
//              this way — it still sums every kind.
//   jitterBufferMs ms — receive-side de-jitter buffer delay, measured as the
//              DELTA of inbound-rtp jitterBufferDelay / jitterBufferEmittedCount
//              since prevTotals. This is normally the single largest term in
//              mouth-to-ear latency (tens of ms, far above the network leg on
//              a LAN), and it is the only part of the receive pipeline WebRTC
//              actually exposes — encode, decode and device buffering are not
//              measurable from getStats and are carried as a constant
//              allowance in the worst-case model instead.
//   packetLoss fraction [0,1] — the WORSE of two directions, since either one
//              can be the bottleneck a performer's audio actually suffers:
//                downlink (what we received): lost / (lost + received) over
//                  the delta since `prevTotals`, from our own inbound-rtp.
//                  First call (no prev) uses lifetime totals.
//                uplink (what the far end told us it received of OUR audio):
//                  remote-inbound-rtp's `fractionLost`, an RTCP-receiver-report
//                  ratio the browser already normalizes per report interval —
//                  no delta bookkeeping needed. This is the direction a
//                  cellular/mobile sender typically struggles on (constrained
//                  uplink), and downlink-only accounting was blind to it.
//
// Returns { sample: { rtcRtt, rtcJitter, packetLoss } | null, totals } where
// each field may be null when the report had nothing usable for it.
export function deriveNetSample(statsEntries, prevTotals = null) {
  const entries = Array.isArray(statsEntries) ? statsEntries : [];

  let rtcRtt = null;
  let rtcJitter = null;
  let uplinkLoss = null;
  let lost = 0;
  let received = 0;
  let jbDelay = 0;      // cumulative seconds, summed over emitted samples
  let jbEmitted = 0;    // cumulative emitted sample/frame count
  let sawInbound = false;

  // Selected candidate pair is the authoritative RTT for the media path.
  const pairs = entries.filter(s => s && s.type === 'candidate-pair');
  const selected = pairs.find(s => s.selected === true || s.nominated === true) ||
    pairs.find(s => s.state === 'succeeded');
  if (selected && typeof selected.currentRoundTripTime === 'number') {
    rtcRtt = selected.currentRoundTripTime * 1000;
  }

  // rtcJitter drives WCJ, which paces turns and tunes the echo — musical
  // timing, so it must describe the AUDIO a performer hears. Video streams
  // routinely jitter an order of magnitude more than Opus on the same
  // connection, and unfiltered they win the max: WCJ would then track whether
  // cameras are on. `kind` is the modern field, `mediaType` the legacy alias;
  // a stat carrying neither is not assumed to be audio.
  const isAudio = (s) => (s.kind ?? s.mediaType) === 'audio';

  for (const s of entries) {
    if (!s) continue;
    if (s.type === 'remote-inbound-rtp') {
      // What the far end measured about our outbound stream.
      if (rtcRtt == null && typeof s.roundTripTime === 'number') {
        rtcRtt = s.roundTripTime * 1000;
      }
      if (typeof s.jitter === 'number' && isAudio(s)) {
        rtcJitter = Math.max(rtcJitter ?? 0, s.jitter * 1000);
      }
      if (typeof s.fractionLost === 'number' && isAudio(s)) {
        uplinkLoss = Math.max(uplinkLoss ?? 0, s.fractionLost);
      }
    } else if (s.type === 'inbound-rtp') {
      sawInbound = true;
      if (typeof s.jitter === 'number' && isAudio(s)) {
        rtcJitter = Math.max(rtcJitter ?? 0, s.jitter * 1000);
      }
      if (typeof s.packetsLost === 'number') lost += s.packetsLost;
      if (typeof s.packetsReceived === 'number') received += s.packetsReceived;
      if (typeof s.jitterBufferDelay === 'number') jbDelay += s.jitterBufferDelay;
      if (typeof s.jitterBufferEmittedCount === 'number') jbEmitted += s.jitterBufferEmittedCount;
    }
  }

  const totals = { lost, received, jbDelay, jbEmitted };
  let packetLoss = null;
  if (sawInbound) {
    const dLost = prevTotals ? lost - prevTotals.lost : lost;
    const dReceived = prevTotals ? received - prevTotals.received : received;
    const denom = dLost + dReceived;
    if (denom > 0 && dLost >= 0 && dReceived >= 0) {
      packetLoss = Math.min(1, Math.max(0, dLost / denom));
    } else if (denom === 0 && prevTotals) {
      // No packets moved this interval — carry nothing rather than invent 0%.
      packetLoss = null;
    } else {
      packetLoss = 0;
    }
  }
  if (uplinkLoss != null) {
    const clamped = Math.min(1, Math.max(0, uplinkLoss));
    packetLoss = packetLoss == null ? clamped : Math.max(packetLoss, clamped);
  }

  // Average buffer delay over THIS interval: both fields are cumulative, so
  // the delta ratio tracks the buffer's current depth rather than its
  // lifetime average (which barely moves once a call has been up a while).
  let jitterBufferMs = null;
  const dDelay = prevTotals ? jbDelay - prevTotals.jbDelay : jbDelay;
  const dEmitted = prevTotals ? jbEmitted - prevTotals.jbEmitted : jbEmitted;
  if (dEmitted > 0 && dDelay >= 0) jitterBufferMs = (dDelay / dEmitted) * 1000;

  const sample = (rtcRtt != null || rtcJitter != null || packetLoss != null || jitterBufferMs != null)
    ? { rtcRtt, rtcJitter, packetLoss, jitterBufferMs }
    : null;
  return { sample, totals };
}

// Merge samples from several peer connections into the single "my link"
// sample we broadcast: worst RTT/jitter/loss across connections (with the
// JVB there is normally exactly one).
export function mergeSamples(samples) {
  const usable = (samples || []).filter(Boolean);
  if (usable.length === 0) return null;
  const pick = (key) => {
    const vals = usable.map(s => s[key]).filter(v => typeof v === 'number' && isFinite(v));
    return vals.length ? Math.max(...vals) : null;
  };
  return {
    rtcRtt: pick('rtcRtt'), rtcJitter: pick('rtcJitter'),
    packetLoss: pick('packetLoss'), jitterBufferMs: pick('jitterBufferMs')
  };
}

// --- Browser wiring ---------------------------------------------------------

function listPeerConnections() {
  const out = [];
  try {
    const conf = window.APP && window.APP.conference;
    const pcWrapper = conf?._room?.rtc?.peerConnections;
    if (pcWrapper) {
      // peerConnections is a Map in lib-jitsi-meet.
      const iter = (pcWrapper.values && pcWrapper.values()) || pcWrapper;
      for (const tpc of iter) {
        const pc = tpc?.peerconnection;
        if (pc && typeof pc.getStats === 'function') out.push(pc);
      }
    }
  } catch (e) { /* conference not up yet */ }
  return out;
}

let pollTimer = null;
// Cumulative packet totals per RTCPeerConnection so loss is a delta, not a
// lifetime average. WeakMap: entries die with their connection.
const totalsByPc = new WeakMap();

async function pollOnce(send) {
  const pcs = listPeerConnections();
  if (pcs.length === 0) return;
  const samples = [];
  for (const pc of pcs) {
    try {
      const report = await pc.getStats();
      const entries = [];
      report.forEach(s => entries.push(s));
      const { sample, totals } = deriveNetSample(entries, totalsByPc.get(pc) || null);
      totalsByPc.set(pc, totals);
      samples.push(sample);
    } catch (e) { /* connection closed mid-poll */ }
  }
  const merged = mergeSamples(samples);
  if (merged) send(merged);
}

export function startNetStatsPolling(send) {
  if (pollTimer || typeof send !== 'function') return;
  pollTimer = setInterval(() => { pollOnce(send); }, POLL_INTERVAL_MS);
}
