// Per-rig audio pipeline latency, MEASURED rather than assumed.
//
// The worst-case model needs the part of mouth-to-ear latency that lives on a
// performer's own machine: capture buffering, Opus encode, depacketize/decode,
// and playout buffering. None of it is visible in the getStats() figures the
// network layer already collects, and it varies enormously by rig — a USB
// interface at 64 samples and a Bluetooth headset are two orders of magnitude
// apart — so a single constant was never going to be honest for a room of
// mixed hardware.
//
// Two measurements, summed:
//
//   1. A LOOPBACK ROUND TRIP through a local RTCPeerConnection pair. Audio
//      goes out through a real Opus encoder and comes back through a real
//      decoder and de-jitter buffer, on this machine, with no network in
//      between. An impulse is emitted at a known AudioContext time and
//      detected on the far side, so the delay is the rig's own codec +
//      packetization path. This is the term that cannot be derived any other
//      way.
//   2. The device buffers the platform reports: AudioContext.baseLatency
//      (capture/render quantum) + AudioContext.outputLatency (playout device
//      and OS mixer). These sit OUTSIDE the loopback — the loopback never
//      reaches hardware — so they are added, not double-counted.
//
// The derivation is a pure function so node:test drives it without WebAudio or
// WebRTC; only the measurement rig itself needs a browser.

// Impulse amplitude and the threshold that counts as "heard it". Opus is lossy
// and will not reproduce a unit impulse exactly, so the threshold is well
// below the emitted amplitude but far above codec noise.
const IMPULSE_AMPLITUDE = 1.0;
const DETECT_THRESHOLD = 0.05;
// Give up rather than hang if the loopback never delivers (no getUserMedia, a
// blocked codec, a browser that refuses the local pair).
const MEASURE_TIMEOUT_MS = 5000;
// Re-measure this often: device latency changes when the performer switches
// output, plugs in an interface, or the OS moves them between mixers.
const REMEASURE_INTERVAL_MS = 60000;

// Total local pipeline latency in ms, from the loopback round trip and the
// platform's device-buffer report (both in SECONDS, as their APIs give them).
// Returns null when nothing usable was measured, so callers can fall back
// rather than publish a fabricated zero.
export function pipelineLatencyMs({ loopbackS = null, baseLatencyS = 0, outputLatencyS = 0 } = {}) {
  const device = (Number(baseLatencyS) || 0) + (Number(outputLatencyS) || 0);
  if (loopbackS == null || !isFinite(loopbackS) || loopbackS < 0) {
    return device > 0 ? device * 1000 : null;
  }
  return (loopbackS + device) * 1000;
}

// Sample offset of the first sample at or above `threshold`, or -1. Pure so
// the detector's edge cases (silence, a late impulse, a split buffer) are
// testable without audio hardware.
export function firstImpulseOffset(samples, threshold = DETECT_THRESHOLD) {
  if (!samples) return -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) return i;
  }
  return -1;
}

// --- Browser measurement rig -------------------------------------------------

// Run one loopback measurement. Resolves to seconds of round-trip delay, or
// null if the impulse never came back within MEASURE_TIMEOUT_MS.
//
// Deliberately silent: the graph terminates in a MediaStreamAudioDestinationNode
// and a detector node whose output is muted, so nothing reaches the speakers
// and no test tone is audible to anyone in the meeting.
async function measureLoopbackSeconds(ctx) {
  if (typeof RTCPeerConnection !== 'function') return null;
  const nodes = [];
  const pcs = [];
  try {
    const source = ctx.createConstantSource();
    source.offset.value = 0;
    const outbound = ctx.createMediaStreamDestination();
    source.connect(outbound);
    nodes.push(source, outbound);

    const pcSend = new RTCPeerConnection();
    const pcRecv = new RTCPeerConnection();
    pcs.push(pcSend, pcRecv);
    pcSend.onicecandidate = (e) => e.candidate && pcRecv.addIceCandidate(e.candidate);
    pcRecv.onicecandidate = (e) => e.candidate && pcSend.addIceCandidate(e.candidate);

    const inbound = new Promise((resolve) => { pcRecv.ontrack = (e) => resolve(e.streams[0]); });
    for (const track of outbound.stream.getAudioTracks()) pcSend.addTrack(track, outbound.stream);

    const offer = await pcSend.createOffer();
    await pcSend.setLocalDescription(offer);
    await pcRecv.setRemoteDescription(offer);
    const answer = await pcRecv.createAnswer();
    await pcRecv.setLocalDescription(answer);
    await pcSend.setRemoteDescription(answer);

    const remoteStream = await Promise.race([
      inbound,
      new Promise((r) => setTimeout(() => r(null), MEASURE_TIMEOUT_MS)),
    ]);
    if (!remoteStream) return null;

    const back = ctx.createMediaStreamSource(remoteStream);
    const detector = ctx.createScriptProcessor(256, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;                 // never audible
    back.connect(detector); detector.connect(mute); mute.connect(ctx.destination);
    nodes.push(back, detector, mute);

    // Let the pipeline settle before timing, so the first measurement is not
    // dominated by connection setup rather than steady-state transport.
    await new Promise((r) => setTimeout(r, 300));

    const emittedAt = ctx.currentTime + 0.05;
    source.offset.setValueAtTime(0, emittedAt - 0.001);
    source.offset.setValueAtTime(IMPULSE_AMPLITUDE, emittedAt);
    source.offset.setValueAtTime(0, emittedAt + 0.005);
    source.start();

    return await Promise.race([
      new Promise((resolve) => {
        detector.onaudioprocess = (e) => {
          const offset = firstImpulseOffset(e.inputBuffer.getChannelData(0));
          if (offset < 0) return;
          detector.onaudioprocess = null;
          resolve(Math.max(0, (e.playbackTime + offset / ctx.sampleRate) - emittedAt));
        };
      }),
      new Promise((r) => setTimeout(() => r(null), MEASURE_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.error(`[pipeline-latency] loopback measurement failed: ${e.message}`);
    return null;
  } finally {
    for (const n of nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } }
    for (const pc of pcs) { try { pc.close(); } catch (e) { /* already closed */ } }
  }
}

let measureTimer = null;

// Measure this rig's pipeline latency now and on REMEASURE_INTERVAL_MS, handing
// each result to `send({ pipelineMs })`. `getContext` is injected so this stays
// decoupled from latency-instrument's AudioContext ownership.
export function startPipelineLatencyMeasurement(send, getContext) {
  if (measureTimer || typeof send !== 'function' || typeof getContext !== 'function') return;
  const runOnce = async () => {
    const ctx = getContext();
    if (!ctx) return;
    const loopbackS = await measureLoopbackSeconds(ctx);
    const pipelineMs = pipelineLatencyMs({
      loopbackS,
      baseLatencyS: ctx.baseLatency,
      outputLatencyS: ctx.outputLatency,
    });
    if (pipelineMs != null) {
      console.log(`[pipeline-latency] this rig: ${pipelineMs.toFixed(1)}ms ` +
        `(loopback ${loopbackS == null ? 'n/a' : (loopbackS * 1000).toFixed(1) + 'ms'}, ` +
        `device ${(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000).toFixed(1)}ms)`);
      send({ pipelineMs });
    }
  };
  runOnce();
  measureTimer = setInterval(runOnce, REMEASURE_INTERVAL_MS);
}

export function stopPipelineLatencyMeasurement() {
  if (measureTimer) { clearInterval(measureTimer); measureTimer = null; }
}
