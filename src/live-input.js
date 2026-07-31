// live() — Strudel source that samples incoming system audio.
//
// `$: live("MOTU M4").struct("<x ~ x>")` starts a continuous mono capture of
// the named local audio input into a rolling ring buffer and returns
// s("live_motu_m4"), a registered superdough sound. Every trigger snapshots
// the MOST RECENT ring audio — snapshot length = that event's duration — so
// struct gates the live signal rhythmically, and the buffer source flows
// through superdough's normal chain (gain, lpf, crush, room, speed, …) like
// any other sample.
//
// Only the authoring browser plays a live() voice: the combined program is
// evaluated on every browser, so strudel.js rewrites remote peers' live(...)
// calls to _liveSilent(...) (same pattern shape, triggers silently skipped).
// A browser whose inputs don't match the name is silent too — capture failure
// never breaks the evaluate.
//
// The capture is never monitored (ring-record only): the named device is
// often a monitor/loopback of the very output Strudel plays into, and
// monitoring it would howl — see attachExternalStreamForPeer in
// latency-instrument.js for the same trap.

import { listAudioInputDevices } from './latency-instrument.js';
import { LiveRing, matchAudioDevice, liveSlug } from './live-input-core.js';

const RING_SECONDS = 10;
const RETRY_MS = 10000;
const SILENT_SOUND = '_livesilent';

const captures = new Map(); // slug → { state: 'starting'|'ready'|'failed', attemptAt, epoch, ring, stream, source, worklet, sink, name }
let epoch = 0;
let audioCtx = null;
let registerSoundFn = null;
let sFn = null;
let workletReady = null;

// Inline AudioWorklet: downmix input to mono, batch ~2048 frames, post the
// batch to the main thread (transferable) where it lands in the LiveRing.
const WORKLET_SOURCE = `
class TrussalLiveCapture extends AudioWorkletProcessor {
  constructor() { super(); this.batch = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length && ch[0].length) {
      const n = ch[0].length;
      const out = new Float32Array(n);
      for (let c = 0; c < ch.length; c++) {
        const d = ch[c];
        for (let i = 0; i < n; i++) out[i] += d[i];
      }
      if (ch.length > 1) {
        const inv = 1 / ch.length;
        for (let i = 0; i < n; i++) out[i] *= inv;
      }
      this.batch.push(out);
      this.len += n;
      if (this.len >= 2048) {
        const merged = new Float32Array(this.len);
        let o = 0;
        for (const b of this.batch) { merged.set(b, o); o += b.length; }
        this.port.postMessage(merged, [merged.buffer]);
        this.batch = [];
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('trussal-live-capture', TrussalLiveCapture);
`;

function ensureWorklet() {
  if (!workletReady) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    workletReady = audioCtx.audioWorklet.addModule(url);
  }
  return workletReady;
}

// The transpiler wraps double-quoted strings in mini patterns, so
// live("MOTU M4") receives a Pattern of the words; single-quoted strings
// arrive as plain strings. Recover the original name either way.
function nameToString(arg) {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg.firstCycle === 'function') {
    try {
      return arg.firstCycle()
        .sort((a, b) => a.part.begin - b.part.begin)
        .map(h => `${h.value}`)
        .join(' ');
    } catch (e) {
      console.warn('[live] could not read device name pattern', e);
    }
  }
  return String(arg ?? '');
}

async function startCapture(slug, name) {
  const devices = await listAudioInputDevices();
  const match = matchAudioDevice(devices, name);
  if (name && !match) {
    // Authoring-browser-only semantics: no matching input here means this
    // browser is not the author — stay silent rather than guessing a device.
    console.warn(`[live] no local audio input matches "${name}" — live() is silent in this browser. Inputs: ${devices.map(d => d.label).join(', ') || '(none)'}`);
    captures.get(slug).state = 'failed';
    return;
  }
  // Music, not telephony: raw capture, same rationale as the Jamulus path.
  const audioConstraints = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false
  };
  if (match) audioConstraints.deviceId = { exact: match.deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  await ensureWorklet();

  const cap = captures.get(slug);
  if (!cap || cap.state !== 'starting') { // stopped while we were setting up
    stream.getTracks().forEach(t => t.stop());
    return;
  }
  const ring = new LiveRing(Math.round(RING_SECONDS * audioCtx.sampleRate));
  const source = audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioCtx, 'trussal-live-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  worklet.port.onmessage = (e) => ring.write(e.data);
  // Zero-gain sink keeps the branch rendered without monitoring the capture.
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  source.connect(worklet);
  worklet.connect(sink);
  sink.connect(audioCtx.destination);
  Object.assign(cap, { state: 'ready', ring, stream, source, worklet, sink });
  console.log(`[live] capturing "${match ? match.label : 'default input'}" → s("${slug}")`);
}

function makeOnTrigger(slug) {
  return (t, value, onEnded) => {
    const cap = captures.get(slug);
    if (!cap || cap.state !== 'ready' || !cap.ring.filled) return; // silent skip
    const speed = typeof value.speed === 'number' ? value.speed : 1;
    if (speed === 0) return;
    const dur = Math.min(RING_SECONDS, Math.max(0.005, value.duration ?? 0.1));
    const data = cap.ring.snapshot(Math.round(dur * audioCtx.sampleRate));
    if (!data.length) return;
    if (speed < 0) data.reverse();
    const buffer = audioCtx.createBuffer(1, data.length, audioCtx.sampleRate);
    buffer.copyToChannel(data, 0);
    const node = audioCtx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = Math.abs(speed);
    node.onended = onEnded;
    node.start(t);
    return { node, stop: (time) => { try { node.stop(time); } catch (e) { /* already ended */ } } };
  };
}

// Called once from ensureStrudel after initStrudel: registers the silent stub
// sound and returns the { live, _liveSilent } functions for evalScope.
export function installLiveInput(mod, ctx) {
  audioCtx = ctx;
  registerSoundFn = mod.registerSound;
  sFn = mod.s;
  registerSoundFn(SILENT_SOUND, () => undefined, { type: 'live', prebake: true });

  const live = (nameArg) => {
    const name = nameToString(nameArg).trim();
    const slug = liveSlug(name);
    const existing = captures.get(slug);
    // A failed capture retries after a cooldown so plugging the device in (or
    // granting permission) self-heals on a later re-evaluate. Permission is
    // per-origin, so retries never re-prompt.
    if (existing && existing.state === 'failed' && Date.now() - existing.attemptAt > RETRY_MS) {
      captures.delete(slug);
    }
    if (!captures.has(slug)) {
      captures.set(slug, { state: 'starting', attemptAt: Date.now(), name, epoch });
      registerSoundFn(slug, makeOnTrigger(slug), { type: 'live', prebake: true });
      startCapture(slug, name).catch((e) => {
        const cap = captures.get(slug);
        if (cap) cap.state = 'failed';
        console.error(`[live] capture failed for "${name}"`, e);
      });
    }
    // Mark this device as still wanted by the program being evaluated.
    captures.get(slug).epoch = epoch;
    return sFn(slug);
  };

  const _liveSilent = () => sFn(SILENT_SOUND);

  return { live, _liveSilent };
}

function teardown(slug, cap) {
  try { cap.stream && cap.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
  try { cap.source && cap.source.disconnect(); } catch (e) { /* ignore */ }
  try { cap.worklet && cap.worklet.disconnect(); } catch (e) { /* ignore */ }
  try { cap.sink && cap.sink.disconnect(); } catch (e) { /* ignore */ }
  captures.delete(slug);
}

// Stop every live capture and release the devices. Called on Strudel stop so
// the mic/interface indicator goes away with the music; the next evaluate
// that still contains live() restarts its capture.
export function stopLiveCaptures() {
  for (const [slug, cap] of captures) teardown(slug, cap);
}

// An open microphone must not outlive the live() call that opened it. Every
// live() in the program being evaluated re-runs and stamps the current epoch,
// so anything left holding the previous one is no longer referenced — the user
// edited the call away, or the peer who wrote it left. Bump before evaluate,
// release after it succeeds (a failed evaluate proves nothing about intent).
export function beginLiveEpoch() { epoch++; }

export function releaseUnusedCaptures() {
  for (const [slug, cap] of captures) {
    if (cap.epoch === epoch) continue;
    console.log(`[live] releasing "${cap.name || 'default input'}" — no longer referenced`);
    teardown(slug, cap);
  }
}
