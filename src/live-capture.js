// liveCapture(medium, name, detectLocalDevices) — a Strudel source that records
// a rolling window of one MEDIUM from one source and replays the freshest slice
// on every pattern event.
//
//   $: liveCapture('audio', 'MOTU M4').struct("<x ~ x>")           // a local input
//   $: liveCapture('audio', 'Ada').struct("x*4").lpf(800).room(1)  // Ada's aggregator output
//   $: liveCapture('text', 'Ada').struct("x*2")                    // Ada's editor changes → chat
//   $: liveCapture('css', 'Ada').struct("<x ~>")                   // Ada's CSS changes → this page
//   $: liveCapture('gesture').struct("x*2")                        // refire my gestures in order
//   $: liveCapture('cursor').struct("x*8")                         // retrace my head-cursor path
//   $: liveCapture('video', 'Ada').struct("x*4")                   // scrub Ada's aggregator video
//
// medium ∈ audio | video | text | css | gesture | cursor.
//
// - audio / video: the named PARTICIPANT's aggregator output (their routed
//   Jitsi <audio>/<video>), or — for audio only — a local input device when the
//   name matches one instead of a participant. Audio flows through superdough's
//   normal chain like any sample; video scrubs a rolling frame ring exposed at
//   window._liveCapture.video[slug].canvas for a Hydra src().
// - text / css: the named participant's editor-change / CSS-change stream. Each
//   event paints the freshest captured fragment / re-applies the freshest
//   compiled sheet on THIS page. Silent by construction.
// - gesture / cursor: YOUR OWN input only. gesture logs every fired facial
//   gesture and refires them in sequence; cursor records the head-cursor path
//   and retraces it. Pressing the Right Arrow, or holding your right eye shut
//   for two seconds, breaks a running gesture/cursor replay — re-evaluate to
//   resume. Silent by construction.
//
// detectLocalDevices (3rd arg, boolean): dump YOUR camera / audio I/O devices
// to the console once and again on every devicechange. One cannot enumerate
// another participant's local system devices, so it is ignored with a warning
// when `name` is a remote participant.
//
// Only the authoring browser runs a liveCapture voice: the combined program is
// evaluated on every browser, so strudel.js rewrites remote peers' calls to
// _liveCaptureSilent(...) (same pattern shape, triggers silently skipped). In
// aggregator mode the authoring peer's published Strudel track carries the
// captured audio to the room. A browser that cannot resolve the source stays
// silent and retries with a cooldown, so a device plugged in — or a participant
// who presses Play — self-heals on a later re-evaluate.

import { listAudioInputDevices } from './latency-instrument.js';
import { getAllPeers, subscribePeerState } from './peer-state.js';
import {
  LiveRing, EventLog, CursorPath, matchAudioDevice, captureSlug,
  parseLiveCaptureArgs,
} from './live-capture-core.js';

const RING_SECONDS = 10;
const RETRY_MS = 10000;
const SILENT_SOUND = '_livecapsilent';
const VIDEO_W = 240, VIDEO_H = 180, VIDEO_FRAMES = 120, VIDEO_FPS = 12;

// slug → capture record. Common fields: { medium, name, slug, state, attemptAt,
// epoch, broken }. Medium-specific fields hang off the same object.
const captures = new Map();
let epoch = 0;
let audioCtx = null;
let registerSoundFn = null;
let sFn = null;
let workletReady = null;
let breakArmed = false;
let rightShutSince = 0;
let deviceWatch = null;
// Set while we synchronously dispatch a gesture refire, so the capture listener
// (which also hears the resulting 'trussal-gesture-fired') does not re-log a
// gesture we are replaying — that would grow the sequence on every pass.
let gestureReplaying = false;

// window._liveCapture.<medium>[slug] — the handles a page reads directly
// (a video canvas for Hydra, the retrace dot, …).
function bucket(medium) {
  if (typeof window === 'undefined') return {};
  const root = window._liveCapture || (window._liveCapture = {});
  return root[medium] || (root[medium] = {});
}

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

// --- source resolution -------------------------------------------------------

// A user-typed name → a peer, by display name (exact then substring) or by
// room-index token. Null when nothing matches.
function resolvePeerByName(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const peers = getAllPeers();
  return peers.find(p => (p.displayName || '').toLowerCase() === want)
      || peers.find(p => (p.displayName || '').toLowerCase().includes(want))
      || peers.find(p => String(p.roomIndex) === want)
      || null;
}

// The MediaStream a routed remote participant's audio is playing through —
// latency-instrument mutes the tag and pipes it into that peer's chain, but the
// srcObject is still the live stream. id convention: remoteAudio_<jitsiId>.
function remoteAudioStream(jitsiId) {
  if (!jitsiId || typeof document === 'undefined') return null;
  const el = document.getElementById(`remoteAudio_${jitsiId}`)
    || Array.from(document.querySelectorAll('audio')).find(a => a.id && a.id.includes(jitsiId));
  return el && el.srcObject ? el.srcObject : null;
}

// The <video> element a remote participant's published track renders into.
function remoteVideoEl(jitsiId) {
  if (!jitsiId || typeof document === 'undefined') return null;
  let scoped = null;
  try { scoped = document.querySelector(`#participant_${jitsiId} video`); } catch (e) { /* bad id → fall through */ }
  return scoped
    || document.getElementById(`remoteVideo_${jitsiId}`)
    || Array.from(document.querySelectorAll('video')).find(v => v.id && v.id.includes(jitsiId) && v.srcObject)
    || null;
}

// --- audio -----------------------------------------------------------------

async function startAudioCapture(cap) {
  const { name } = cap;
  const peer = name ? resolvePeerByName(name) : null;
  let stream = null;
  let label = '';
  let ownsStream = false;

  if (peer && !peer.isLocal) {
    stream = remoteAudioStream(peer.jitsiId);
    if (!stream) {
      console.warn(`[liveCapture] audio: participant "${peer.displayName}" has no audio yet — retrying`);
      cap.state = 'failed';
      return;
    }
    label = `participant ${peer.displayName}`;
  } else {
    if (peer && peer.isLocal) {
      console.warn('[liveCapture] audio of yourself is a monitor loop — capturing your default input instead');
    }
    const devices = await listAudioInputDevices();
    const match = matchAudioDevice(devices, name);
    if (name && !match && !peer) {
      // No participant, no device — this browser is not the author, or the
      // device is unplugged. Stay silent rather than guessing.
      console.warn(`[liveCapture] no participant or local input matches "${name}" — silent in this browser. Inputs: ${devices.map(d => d.label).join(', ') || '(none)'}`);
      cap.state = 'failed';
      return;
    }
    // Music, not telephony: raw capture, same rationale as the Jamulus path.
    const audioConstraints = { echoCancellation: false, autoGainControl: false, noiseSuppression: false };
    if (match) audioConstraints.deviceId = { exact: match.deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    ownsStream = true;
    label = match ? match.label : 'default input';
  }

  await ensureWorklet();
  if (!captures.get(cap.slug) || cap.state !== 'starting') { // stopped while setting up
    if (ownsStream) stream.getTracks().forEach(t => t.stop());
    return;
  }
  const ring = new LiveRing(Math.round(RING_SECONDS * audioCtx.sampleRate));
  const source = audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioCtx, 'trussal-live-capture', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  worklet.port.onmessage = (e) => ring.write(e.data);
  // Zero-gain sink keeps the branch rendered without monitoring the capture
  // (the source is often a monitor of the very output Strudel plays into).
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  source.connect(worklet);
  worklet.connect(sink);
  sink.connect(audioCtx.destination);
  Object.assign(cap, { state: 'ready', ring, stream, source, worklet, sink, ownsStream });
  console.log(`[liveCapture] audio ← ${label} → s("${cap.slug}")`);
}

function audioOnTrigger(cap, t, value, onEnded) {
  if (cap.state !== 'ready' || !cap.ring || !cap.ring.filled) return; // silent skip
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
}

// --- video ---------------------------------------------------------------

async function startVideoCapture(cap) {
  const peer = resolvePeerByName(cap.name);
  if (!peer) {
    console.warn(`[liveCapture] video: no participant matches "${cap.name}"`);
    cap.state = 'failed';
    return;
  }
  const srcEl = remoteVideoEl(peer.jitsiId);
  if (!srcEl) {
    console.warn(`[liveCapture] video: "${peer.displayName}" has no visible video track yet — retrying`);
    cap.state = 'failed';
    return;
  }
  const frames = Array.from({ length: VIDEO_FRAMES }, () => {
    const c = document.createElement('canvas'); c.width = VIDEO_W; c.height = VIDEO_H; return c;
  });
  const vid = { frames, writePos: 0, filled: 0, playIdx: 0, srcEl };
  const grab = () => {
    if (!srcEl.videoWidth) return;
    try { frames[vid.writePos].getContext('2d').drawImage(srcEl, 0, 0, VIDEO_W, VIDEO_H); } catch (e) { return; }
    vid.writePos = (vid.writePos + 1) % VIDEO_FRAMES;
    vid.filled = Math.min(vid.filled + 1, VIDEO_FRAMES);
  };
  const playback = document.createElement('canvas');
  playback.width = VIDEO_W; playback.height = VIDEO_H;
  const liveCanvas = document.createElement('canvas');
  liveCanvas.width = VIDEO_W; liveCanvas.height = VIDEO_H;
  const liveTimer = setInterval(() => {
    if (srcEl.videoWidth) { try { liveCanvas.getContext('2d').drawImage(srcEl, 0, 0, VIDEO_W, VIDEO_H); } catch (e) { /* ignore */ } }
  }, Math.round(1000 / 15));
  const timer = setInterval(grab, Math.round(1000 / VIDEO_FPS));
  bucket('video')[cap.slug] = { canvas: playback, playback, live: liveCanvas };
  Object.assign(cap, { state: 'ready', vid, playback, liveCanvas, timer, liveTimer });
  console.log(`[liveCapture] video ← participant ${peer.displayName} → window._liveCapture.video["${cap.slug}"].canvas`);
}

function videoOnTrigger(cap, value) {
  const vid = cap.vid;
  if (cap.state !== 'ready' || !vid || !vid.filled) return;
  const speed = typeof value.speed === 'number' && value.speed !== 0 ? value.speed : 1;
  vid.playIdx = (vid.playIdx + Math.sign(speed) + vid.filled) % vid.filled;
  const ringIdx = (vid.writePos - vid.filled + vid.playIdx + VIDEO_FRAMES * 2) % VIDEO_FRAMES;
  try {
    cap.playback.getContext('2d').drawImage(vid.frames[ringIdx], 0, 0);
  } catch (e) { /* ignore a torn frame */ }
  return; // silent
}

// --- text ----------------------------------------------------------------

// New words in `next` that were not in `prev` — the added fragment. Falls back
// to the last non-empty line when nothing clean diffs out.
function textDelta(prev, next) {
  const p = new Set(String(prev || '').split(/\s+/).filter(Boolean));
  const added = String(next || '').split(/\s+/).filter(w => w && !p.has(w));
  if (added.length) return added.join(' ');
  const lines = String(next || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

const TEXT_OVERLAY_ID = 'trussal-livecapture-text';
function textOverlay() {
  let el = document.getElementById(TEXT_OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = TEXT_OVERLAY_ID;
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:1000000;max-width:40vw;' +
      'font-family:monospace;font-size:13px;line-height:1.5;color:#eeeeee;pointer-events:none;' +
      'text-shadow:0 1px 3px rgba(0,0,0,0.8);display:flex;flex-direction:column;gap:2px;';
    document.body.appendChild(el);
  }
  return el;
}

function startTextCapture(cap) {
  const log = new EventLog({ capacity: 64, windowMs: 60000 });
  cap.log = log;
  cap.lastText = null;
  cap.unsub = subscribePeerState((event, peer) => {
    if (event !== 'peer-upsert') return;
    if (!peerMatches(cap, peer)) return;
    const text = typeof peer.pattern === 'string' ? peer.pattern : '';
    if (cap.lastText === null) { cap.lastText = text; return; }
    if (text === cap.lastText) return;
    const frag = textDelta(cap.lastText, text);
    cap.lastText = text;
    if (frag) log.push(frag);
  });
  cap.state = 'ready';
  console.log(`[liveCapture] text ← editor changes of "${cap.name}"`);
}

function textOnTrigger(cap, value) {
  if (!cap.log) return;
  const e = cap.log.latest();
  if (!e) return;
  const el = textOverlay();
  const span = document.createElement('div');
  span.textContent = e.value;
  if (value && typeof value.color === 'string') span.style.color = value.color;
  if (value && (typeof value.size === 'number' || typeof value.size === 'string')) {
    span.style.fontSize = typeof value.size === 'number' ? `${value.size}px` : value.size;
  }
  if (value && typeof value.typeface === 'string') span.style.fontFamily = value.typeface;
  el.appendChild(span);
  while (el.childNodes.length > 8) el.removeChild(el.firstChild);
  setTimeout(() => { try { span.remove(); } catch (err) { /* gone */ } }, 6000);
  return; // silent
}

// --- css ---------------------------------------------------------------

function startCssCapture(cap) {
  const log = new EventLog({ capacity: 16, windowMs: 120000 });
  cap.log = log;
  cap.lastCss = null;
  cap.styleEl = null;
  cap.unsub = subscribePeerState((event, peer) => {
    if (event !== 'peer-upsert') return;
    if (!peerMatches(cap, peer)) return;
    const css = typeof peer.compiledCss === 'string' ? peer.compiledCss : '';
    if (css === cap.lastCss) return;
    cap.lastCss = css;
    if (css) log.push(css);
  });
  cap.state = 'ready';
  console.log(`[liveCapture] css ← CSS changes of "${cap.name}"`);
}

function cssOnTrigger(cap) {
  if (!cap.log) return;
  const e = cap.log.latest();
  if (!e) return;
  if (!cap.styleEl) {
    cap.styleEl = document.createElement('style');
    cap.styleEl.id = `trussal-livecapture-css-${cap.slug}`;
    document.head.appendChild(cap.styleEl);
  }
  if (cap.styleEl.textContent !== e.value) cap.styleEl.textContent = e.value;
  return; // silent
}

// --- gesture -----------------------------------------------------------

function startGestureCapture(cap) {
  const log = new EventLog({ capacity: 128, windowMs: 120000 });
  cap.log = log;
  cap.gCursor = 0;
  cap.onFired = (evt) => {
    if (gestureReplaying) return; // our own refire, not a fresh gesture
    const name = evt && evt.detail && evt.detail.name;
    if (name) log.push(name);
  };
  document.addEventListener('trussal-gesture-fired', cap.onFired);
  armBreakControls();
  cap.state = 'ready';
  console.log('[liveCapture] gesture ← your fired facial gestures');
}

function gestureOnTrigger(cap) {
  if (cap.broken || !cap.log || !cap.log.length) return;
  const e = cap.log.nextAfter(cap.gCursor);
  if (!e) return;
  cap.gCursor = e.t;
  gestureReplaying = true;
  try {
    document.dispatchEvent(new CustomEvent('trussal-gesture-refire', { detail: { name: e.value } }));
  } catch (err) { /* ignore */ } finally {
    gestureReplaying = false;
  }
  return; // silent
}

// --- cursor ----------------------------------------------------------

const CURSOR_DOT_ID = 'trussal-livecapture-cursor';
function cursorDot() {
  let el = document.getElementById(CURSOR_DOT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CURSOR_DOT_ID;
    el.style.cssText = 'position:fixed;width:14px;height:14px;border-radius:50%;z-index:9999998;' +
      'border:2px solid #eeeeee;background:rgba(238,238,238,0.25);pointer-events:none;' +
      'transform:translate(-50%,-50%);transition:left 0.08s linear,top 0.08s linear;display:none;';
    document.body.appendChild(el);
  }
  return el;
}

function startCursorCapture(cap) {
  const path = new CursorPath(6000);
  cap.path = path;
  cap.headMs = 0;
  cap.dotEl = cursorDot();
  const sample = () => {
    const fc = typeof window !== 'undefined' ? window.faceCtx : null;
    if (fc && Number.isFinite(fc.cursorX) && Number.isFinite(fc.cursorY)) {
      path.push(fc.cursorX, fc.cursorY);
    }
  };
  cap.sampleTimer = setInterval(sample, 33);
  cap.onMouse = (e) => path.push(e.clientX, e.clientY);
  window.addEventListener('mousemove', cap.onMouse);
  armBreakControls();
  cap.state = 'ready';
  console.log('[liveCapture] cursor ← your head-cursor / pointer path');
}

function cursorOnTrigger(cap, value) {
  if (cap.broken || !cap.path || !cap.path.length) {
    if (cap.dotEl) cap.dotEl.style.display = 'none';
    return;
  }
  const speed = typeof value.speed === 'number' && value.speed !== 0 ? value.speed : 1;
  const stepMs = Math.max(20, (value.duration ?? 0.1) * 1000) * speed;
  cap.headMs += stepMs;
  const p = cap.path.at(cap.headMs);
  if (!p) return;
  // Hand the point to facial-gesture so the real head cursor (and its dwell
  // activation) follows the retrace; also show our own dot as a fallback.
  window._lcCursorOverride = { x: p.x, y: p.y, until: Date.now() + 2000 };
  if (cap.dotEl) {
    cap.dotEl.style.display = 'block';
    cap.dotEl.style.left = `${p.x}px`;
    cap.dotEl.style.top = `${p.y}px`;
  }
  return; // silent
}

// --- break controls (gesture / cursor) ---------------------------------

function armBreakControls() {
  if (breakArmed || typeof window === 'undefined') return;
  breakArmed = true;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') breakReplay('right-arrow');
  });
  setInterval(() => {
    const fc = window.faceCtx;
    const r = (fc && fc.eyeBlinkRight) || 0;
    const l = (fc && fc.eyeBlinkLeft) || 0;
    if (r > 0.6 && l < 0.3) {
      if (!rightShutSince) rightShutSince = Date.now();
      else if (Date.now() - rightShutSince >= 2000) breakReplay('right-eye-2s');
    } else {
      rightShutSince = 0;
    }
  }, 100);
}

function breakReplay(why) {
  let any = false;
  for (const cap of captures.values()) {
    if ((cap.medium === 'gesture' || cap.medium === 'cursor') && !cap.broken) {
      cap.broken = true;
      any = true;
      if (cap.medium === 'cursor') {
        window._lcCursorOverride = null;
        if (cap.dotEl) cap.dotEl.style.display = 'none';
      }
    }
  }
  if (any) console.log(`[liveCapture] gesture/cursor replay broken (${why}) — re-evaluate to resume`);
}

// --- detectLocalDevices ----------------------------------------------------

async function startDeviceWatch(cap) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const peer = cap.name ? resolvePeerByName(cap.name) : null;
  if (peer && !peer.isLocal) {
    console.warn(`[liveCapture] detectLocalDevices ignored — one cannot access ${peer.displayName}'s local system devices, only your own`);
    return;
  }
  if (deviceWatch) { deviceWatch.refs++; return; }
  const dump = async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const rows = devs.map(d => ({
        kind: d.kind,
        label: d.label || '(hidden until a matching permission is granted)',
        id: (d.deviceId || '').slice(0, 8),
      }));
      console.log(`[liveCapture] your local devices (${rows.length}) — updates on devicechange:`);
      (typeof console.table === 'function' ? console.table : console.log).call(console, rows);
    } catch (e) {
      console.warn('[liveCapture] could not enumerate local devices', e);
    }
  };
  const onChange = () => dump();
  navigator.mediaDevices.addEventListener?.('devicechange', onChange);
  deviceWatch = { refs: 1, stop: () => navigator.mediaDevices.removeEventListener?.('devicechange', onChange) };
  await dump();
}

function stopDeviceWatch() {
  if (!deviceWatch) return;
  try { deviceWatch.stop(); } catch (e) { /* ignore */ }
  deviceWatch = null;
}

// --- shared plumbing -----------------------------------------------------

function peerMatches(cap, peer) {
  if (!peer) return false;
  if (!cap._targetJitsiId) {
    const resolved = resolvePeerByName(cap.name);
    cap._targetJitsiId = resolved ? resolved.jitsiId : null;
  }
  if (cap._targetJitsiId && peer.jitsiId === cap._targetJitsiId) return true;
  const want = String(cap.name || '').trim().toLowerCase();
  if (!want) return false;
  return (peer.displayName || '').toLowerCase() === want
      || String(peer.roomIndex) === want;
}

function startCapture(cap) {
  switch (cap.medium) {
    case 'audio':   return startAudioCapture(cap);
    case 'video':   return startVideoCapture(cap);
    case 'text':    return Promise.resolve(startTextCapture(cap));
    case 'css':     return Promise.resolve(startCssCapture(cap));
    case 'gesture': return Promise.resolve(startGestureCapture(cap));
    case 'cursor':  return Promise.resolve(startCursorCapture(cap));
    default:        return Promise.reject(new Error(`unknown medium ${cap.medium}`));
  }
}

function makeOnTrigger(slug) {
  return (t, rawValue, onEnded) => {
    const cap = captures.get(slug);
    if (!cap) return;
    const value = rawValue && typeof rawValue === 'object' ? rawValue : {};
    switch (cap.medium) {
      case 'audio':   return audioOnTrigger(cap, t, value, onEnded);
      case 'video':   return videoOnTrigger(cap, value);
      case 'text':    return textOnTrigger(cap, value);
      case 'css':     return cssOnTrigger(cap);
      case 'gesture': return gestureOnTrigger(cap);
      case 'cursor':  return cursorOnTrigger(cap, value);
      default:        return undefined;
    }
  };
}

function teardown(slug, cap) {
  try { if (cap.ownsStream && cap.stream) cap.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
  try { cap.source && cap.source.disconnect(); } catch (e) { /* ignore */ }
  try { cap.worklet && cap.worklet.disconnect(); } catch (e) { /* ignore */ }
  try { cap.sink && cap.sink.disconnect(); } catch (e) { /* ignore */ }
  try { cap.timer && clearInterval(cap.timer); } catch (e) { /* ignore */ }
  try { cap.liveTimer && clearInterval(cap.liveTimer); } catch (e) { /* ignore */ }
  try { cap.sampleTimer && clearInterval(cap.sampleTimer); } catch (e) { /* ignore */ }
  try { cap.unsub && cap.unsub(); } catch (e) { /* ignore */ }
  try { cap.onFired && document.removeEventListener('trussal-gesture-fired', cap.onFired); } catch (e) { /* ignore */ }
  try { cap.onMouse && window.removeEventListener('mousemove', cap.onMouse); } catch (e) { /* ignore */ }
  try { cap.styleEl && cap.styleEl.remove(); } catch (e) { /* ignore */ }
  try { cap.dotEl && cap.dotEl.remove(); } catch (e) { /* ignore */ }
  if (cap.medium === 'cursor') window._lcCursorOverride = null;
  const b = typeof window !== 'undefined' && window._liveCapture && window._liveCapture[cap.medium];
  if (b) delete b[slug];
  captures.delete(slug);
}

// Called once from ensureStrudel after initStrudel: registers the silent stub
// sound and returns the { liveCapture, _liveCaptureSilent } functions for
// evalScope.
export function installLiveCapture(mod, ctx) {
  audioCtx = ctx;
  registerSoundFn = mod.registerSound;
  sFn = mod.s;
  registerSoundFn(SILENT_SOUND, () => undefined, { type: 'live', prebake: true });

  const liveCapture = (mediumArg, nameArg, detectArg) => {
    const { medium, name, detectLocalDevices, error } = parseLiveCaptureArgs(mediumArg, nameArg, detectArg);
    if (error) {
      console.warn(`[liveCapture] ${error}`);
      return sFn(SILENT_SOUND);
    }
    const slug = captureSlug(medium, name);
    let cap = captures.get(slug);
    // A failed capture retries after a cooldown so plugging a device in, or a
    // participant pressing Play, self-heals on a later re-evaluate. Permission
    // is per-origin, so retries never re-prompt.
    if (cap && cap.state === 'failed' && Date.now() - cap.attemptAt > RETRY_MS) {
      teardown(slug, cap);
      cap = null;
    }
    if (!cap) {
      cap = { medium, name, slug, state: 'starting', attemptAt: Date.now(), epoch, broken: false };
      captures.set(slug, cap);
      registerSoundFn(slug, makeOnTrigger(slug), { type: 'live', prebake: true });
      startCapture(cap).catch((e) => {
        const c = captures.get(slug);
        if (c) c.state = 'failed';
        console.error(`[liveCapture] ${medium} capture failed for "${name}"`, e);
      });
    } else {
      // Re-entry == re-evaluation (rebuildAndEvaluate dedups on program text),
      // which is the documented way to resume a broken gesture/cursor replay.
      cap.broken = false;
    }
    cap.epoch = epoch;
    if (detectLocalDevices) startDeviceWatch(cap).catch(() => {});
    return sFn(slug);
  };

  const _liveCaptureSilent = () => sFn(SILENT_SOUND);

  return { liveCapture, _liveCaptureSilent };
}

// Stop every capture and release its devices / listeners. Called on Strudel
// stop so the mic/camera indicator goes away with the music; the next evaluate
// that still contains liveCapture() restarts its capture.
export function stopLiveCaptures() {
  for (const [slug, cap] of captures) teardown(slug, cap);
  stopDeviceWatch();
  if (typeof window !== 'undefined') window._lcCursorOverride = null;
}

// A capture must not outlive the liveCapture() call that opened it. Every call
// in the program being evaluated re-runs and stamps the current epoch, so
// anything left holding the previous one is no longer referenced — the user
// edited the call away, or the peer who wrote it left. Bump before evaluate,
// release after it succeeds (a failed evaluate proves nothing about intent).
export function beginLiveEpoch() { epoch++; }

export function releaseUnusedCaptures() {
  for (const [slug, cap] of captures) {
    if (cap.epoch === epoch) continue;
    console.log(`[liveCapture] releasing ${cap.medium} "${cap.name || 'self'}" — no longer referenced`);
    teardown(slug, cap);
  }
  if (!captures.size) stopDeviceWatch();
}
