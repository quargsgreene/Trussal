// Audio engine for the distributed instrument.
//
// One AudioContext per browser. For every meeting participant we maintain a
// dedicated effects chain (worklet → limiter → optional reverb → realDestination).
// Remote peers' mic audio is routed to their chain via the matching Jitsi
// `<audio>` tag; the local participant's chain hosts Strudel's output (see
// strudel.js).
//
// Each chain's effect parameters are computed from that peer's
// effects toggles plus their network metrics (rtt/jitter), broadcast over the
// peer-state bus, so every browser produces the same audio for the same peer.

import { subscribeParticipants, getLocalParticipant, getParticipantIdForAudioTag } from './participants.js';
import { subscribePeerState, getPeerByJitsiId, getAllPeers } from './peer-state.js';
import { electAggregator } from './aggregator-election.js';

let audioCtx = null;
let realDestination = null;
let workletLoaded = null;
let reverbBuffer = null;
let masterStrudelGain = null;
let masterLimiter = null; // DynamicsCompressor downstream of masterStrudelGain — see ensureMasterStrudelInput
let bootPromise = null;
let strudelFx = null; 
let strudelOut = null;

const chains = new Map();           // jitsiId -> chain
const remoteSources = new Map();    // jitsiId -> { tag, source, label }
const pendingCaptures = new Set();  // jitsiIds currently being wired (prevents concurrent duplicates)
const externalSources = new Map();  // jitsiId -> { source, stream }
const externalNodes = new Map();    // jitsiId -> { node, label }  (WebAudio node, no MediaStream)
const audioRouted = new Set();      // jitsiIds whose chain has any live source
const routingSubscribers = new Set();

let audioTagObserver = null;
let aggregatorJitsiId = null;

function notifyRoutingChange() {
  routingSubscribers.forEach(fn => {
    try { fn(new Set(audioRouted)); } catch (e) { console.warn('[latency] routing subscriber threw', e); }
  });
}

export function subscribeAudioRouting(fn) {
  routingSubscribers.add(fn);
  try { fn(new Set(audioRouted)); } catch (e) { console.warn("[latency] ignored", e); }
  return () => routingSubscribers.delete(fn);
}

function presenceLevelFor(jitsiId) {
  if (!aggregatorJitsiId) return 1;
  return jitsiId === aggregatorJitsiId ? 1 : 0;
}

function localStrudelLevel() { return aggregatorJitsiId ? 0 : 1; }

export function setAggregatorPeer(jitsiId) {
  const next = jitsiId || null;
  if (next === aggregatorJitsiId) return;
  aggregatorJitsiId = next;
  if (next) publishLocalStrudelToRoom().catch((e) => console.warn('[latency] strudel publish failed', e));
  else unpublishLocalStrudelFromRoom().catch((e) => console.warn('[latency] strudel unpublish failed', e));
  document.dispatchEvent(new CustomEvent('trussal-aggregator-mode-change'));
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const chain of chains.values()) {
    if (chain.presence) chain.presence.gain.setTargetAtTime(presenceLevelFor(chain.jitsiId), now, 0.05);
  }
  if (strudelOut) strudelOut.gain.setTargetAtTime(localStrudelLevel(), now, 0.05);
}

export function getAggregatorPeer() { return aggregatorJitsiId; }
function refreshAggregatorPeer() {
  const winner = electAggregator(getAllPeers());
  setAggregatorPeer(winner && !winner.isLocal ? winner.jitsiId : null);
}

function ensureAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return Promise.reject(new Error('WebAudio not supported'));
  if (!audioCtx) {
    audioCtx = new Ctor({ sampleRate: 48000 });
    const masterBus = audioCtx.createGain();
    masterBus.gain.value = 1.0;
    masterBus.connect(audioCtx.destination);
    realDestination = masterBus;
  }
  if (!audioCtx.audioWorklet) return Promise.reject(new Error('AudioWorklet not supported'));

  if (!workletLoaded) {
    try {
      workletLoaded = audioCtx.audioWorklet.addModule('/latency-worklet-v2.js');
    } catch (e) {
      console.warn('[latency] worklet load failed', e);
      workletLoaded = Promise.resolve();
    }
  }
  const resume = audioCtx.state === 'suspended' ? audioCtx.resume() : Promise.resolve();
  return resume.then(() => workletLoaded);
}

async function loadReverbBuffer() {
  if (reverbBuffer) return reverbBuffer;
  try {
    const resp = await fetch('trussal-impulse.wav');
    const ct = resp.headers.get('content-type');
    if (ct && ct.includes('text/html')) throw new Error('impulse file returned HTML');
    const ab = await resp.arrayBuffer();
    reverbBuffer = await audioCtx.decodeAudioData(ab);
  } catch (e) {
    console.warn('[latency] reverb buffer load failed', e);
    reverbBuffer = null;
  }
  return reverbBuffer;
}

// Tanh-based soft-clip curve for the WaveShaperNode.
function makeDistortionCurve(amount) {
  const n = 512;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    if (amount < 0.001) { curve[i] = x; continue; }
    const k = amount * 24 + 0.001;
    curve[i] = (Math.PI + k) * x / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function updateStrudelFx(effects, rtt, jitter) {
  if (!strudelFx || !audioCtx) return;
  const e   = effects || {};
  const r   = rtt    || 0;
  const j   = jitter || 0;
  const now = audioCtx.currentTime;

  // Distortion — WaveShaperNode curve; null = identity (bypass).
  if (e.distortion) {
    if (strudelFx._bypassedDist !== false) {
      try { masterLimiter.disconnect(strudelOut); } catch (e) { console.warn("[latency] ignored", e); }
      try { masterLimiter.connect(strudelFx.distWS); strudelFx.distWS.connect(strudelOut); } catch (e) { console.warn("[latency] ignored", e); }
      strudelFx._bypassedDist = false;
    }
    const base  = 0.2;
    const extra = Math.max(0, Math.min(0.8, (r - 5) / 55 + j / 6));
    strudelFx.distWS.oversample = '4x';
    strudelFx.distWS.curve = makeDistortionCurve(base + extra);
  } else {
    if (strudelFx._bypassedDist !== true) {
      try { strudelFx.distWS.disconnect(strudelOut); } catch (e) { console.warn("[latency] ignored", e); }
      try { masterLimiter.disconnect(strudelFx.distWS); } catch (e) { console.warn("[latency] ignored", e); }
      try { masterLimiter.connect(strudelOut); } catch (e) { console.warn("[latency] ignored", e); }
      strudelFx._bypassedDist = true;
    }
    strudelFx.distWS.curve = null;
  }

  // Noise — ramp GainNode for smooth gradient fade-in/out.
  const targetNoise = e.noise ? 0.12 : 0;
  strudelFx.noiseGain.gain.cancelScheduledValues(now);
  strudelFx.noiseGain.gain.linearRampToValueAtTime(targetNoise, now + 0.8);
  if (e.noise) {
    // Filter colour: white (flat) → brown (200 Hz) → pink (1 kHz) by jitter.
    const targetFreq = j < 1 ? 20000 : j < 3 ? 200 : 1200;
    strudelFx.noiseFilter.frequency.cancelScheduledValues(now);
    strudelFx.noiseFilter.frequency.linearRampToValueAtTime(targetFreq, now + 0.3);
  }

  // Reverb — ramp wet gain.
  if (strudelFx.convGain) {
    const targetRev = e.reverb ? 1.8 : 0;
    strudelFx.convGain.gain.cancelScheduledValues(now);
    strudelFx.convGain.gain.linearRampToValueAtTime(targetRev, now + 0.5);
  }
}

function computeEffectParams(effects, metrics) {
  const rtt    = metrics && typeof metrics.rtt    === 'number' ? metrics.rtt    : 0;
  const jitter = metrics && typeof metrics.jitter === 'number' ? metrics.jitter : 0;

  // Base 0.05 (drive ≈5.5) when on; network conditions push it toward 1.0
  // (drive ≈91) for clearly audible differences across the latency range.
  let glitchIntensity = 0;
  if (effects && effects.distortion) {
    const base  = 0.05;
    const extra = Math.max(0, Math.min(1 - base, (rtt - 5) / 55 + jitter / 6));
    glitchIntensity = base + extra;
  }

  // Always apply noise when on; jitter selects the colour so the progression
  // sounds clearly distinct: white (quiet) → brown (warm, loud) → pink (loud).
  let noiseType = 0;
  if (effects && effects.noise) {
    if      (jitter < 1) noiseType = 1;   // white
    else if (jitter < 3) noiseType = 2;   // brown
    else                 noiseType = 3;   // pink
  }
  return { glitchIntensity, noiseType, reverb: !!(effects && effects.reverb) };
}

function applyParams(chain, params) {
  if (!chain || !audioCtx) return;
  const now = audioCtx.currentTime;
  const glitch = chain.worklet.parameters.get('glitchIntensity');
  if (glitch) glitch.setValueAtTime(params.glitchIntensity, now);
  const noise = chain.worklet.parameters.get('noiseType');
  if (noise) noise.setValueAtTime(params.noiseType, now);
  // Ramp noiseAmount for gradient fade-in/out (worklet scales noise by this).
  const noiseAmt = chain.worklet.parameters.get('noiseAmount');
  if (noiseAmt) {
    const target = params.noiseType > 0 ? 1 : 0;
    noiseAmt.cancelScheduledValues(now);
    noiseAmt.linearRampToValueAtTime(target, now + 0.8);
  }

  // Reverb toggle: limiter feeds either dry to realDestination or wet via the
  // convolver (whose output we already wired to realDestination).
  if (chain.reverbOn === params.reverb) return;
  chain.reverbOn = params.reverb;
  try { chain.limiter.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
  if (params.reverb && chain.reverb) {
    chain.limiter.connect(chain.reverb);
  } else {
    chain.limiter.connect(realDestination);
  }
}

async function buildChain(jitsiId) {
  await ensureAudioContext();
  await loadReverbBuffer();

  const input = audioCtx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  Object.defineProperty(input, 'maxChannelCount', { value: 2, configurable: true });

  const worklet = new AudioWorkletNode(audioCtx, 'latency-processor-v2', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -1.0;

  let reverb = null;
  let reverbGain = null;
  if (reverbBuffer) {
    reverb = audioCtx.createConvolver();
    reverb.buffer = reverbBuffer;
    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 1.8;
    reverb.connect(reverbGain);
    reverbGain.connect(realDestination);
  }

  const presence = audioCtx.createGain();
  presence.gain.value = presenceLevelFor(jitsiId);

  input.connect(presence);
  presence.connect(worklet);
  worklet.connect(limiter);
  limiter.connect(realDestination); // dry path by default

  return { jitsiId, input, presence, worklet, limiter, reverb, reverbGain, reverbOn: false };
}

async function ensureChain(jitsiId) {
  if (!jitsiId) return null;
  if (chains.has(jitsiId)) return chains.get(jitsiId);
  const chain = await buildChain(jitsiId);
  chains.set(jitsiId, chain);
  // Apply whatever state we already know about this peer.
  const peer = getPeerByJitsiId(jitsiId);
  if (peer) applyParams(chain, computeEffectParams(peer.effects, { rtt: peer.rtt, jitter: peer.jitter }));
  return chain;
}

function destroyChain(jitsiId) {
  const chain = chains.get(jitsiId);
  if (!chain) return;
  try { chain.input.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
  if (chain.presence) { try { chain.presence.disconnect(); } catch (e) { console.warn("[latency] ignored", e); } }
  try { chain.worklet.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
  try { chain.limiter.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
  if (chain.reverb) { try { chain.reverb.disconnect(); } catch (e) { console.warn("[latency] ignored", e); } }
  if (chain.reverbGain) { try { chain.reverbGain.disconnect(); } catch (e) { console.warn("[latency] ignored", e); } }
  chains.delete(jitsiId);
}

function captureJitsiAudio() {
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  if (!audioCtx) return;
  const local = getLocalParticipant();
  const localJitsiId = local ? local.id : null;
  const tags = document.querySelectorAll('audio');
  tags.forEach(async tag => {
    if (!tag.srcObject) return;
    if (tag.id === 'userAudio') return; // local mic, never route locally
    const jitsiId = getParticipantIdForAudioTag(tag);
    if (!jitsiId) {
      // Unrecognized tag layout — log once so we can adapt the matcher if
      // Jitsi renames things in the future.
      if (!tag.dataset.trussalUnmatched) {
        console.warn('[latency] unmatched audio tag (no participant id)', { id: tag.id, srcTracks: tag.srcObject.getAudioTracks?.().length });
        tag.dataset.trussalUnmatched = '1';
      }
      return;
    }
    // Never route the local user's own audio back to their speakers.
    if (localJitsiId && jitsiId === localJitsiId) return;
    // Skip hidden participants (Jicofo, virtual sources, etc.).
    try {
      const conf = window.APP && window.APP.conference;
      const member = conf && typeof conf.getParticipantById === 'function'
        ? conf.getParticipantById(jitsiId) : null;
      if (member && typeof member.isHidden === 'function' && member.isHidden()) return;
    } catch (e) { console.warn("[latency] ignored", e); }
    if (!getPeerByJitsiId(jitsiId)) return;
    if (pendingCaptures.has(jitsiId)) return;
    const existing = remoteSources.get(jitsiId);
    if (existing) {
      const live = existing.tag && existing.tag.isConnected
        && existing.tag.srcObject === existing.stream
        && existing.track && existing.track.readyState === 'live';
      if (live) return; // healthy wiring (on this tag or another) — nothing to do
      try { existing.source.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
      remoteSources.delete(jitsiId);
      if (!externalSources.has(jitsiId) && !externalNodes.has(jitsiId)) {
        if (audioRouted.delete(jitsiId)) notifyRoutingChange();
      }
      console.log('[latency] audio wiring for', jitsiId, 'went stale (track replaced) — re-wiring');
    }
    pendingCaptures.add(jitsiId);

    try {
      const chain = await ensureChain(jitsiId);
      if (!chain) return;
      // Re-check after the async gap — another call may have completed first.
      if (remoteSources.has(jitsiId)) return;
      const stream = tag.srcObject;
      if (!stream) return; // swapped away mid-wire; the next pass handles it
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(chain.input);
      tag.muted = true;
      tag.volume = 0;
      const audioTracks = stream.getAudioTracks?.() || [];
      const trackLabels = audioTracks.map(t => t.label || 'audio');
      remoteSources.set(jitsiId, { tag, stream, track: audioTracks[0] || null, source, label: trackLabels.join(',') || 'mic' });
      audioRouted.add(jitsiId);
      console.log('[latency] routed Jitsi audio →', jitsiId, 'tracks:', trackLabels);
      notifyRoutingChange();
    } catch (e) {
      console.warn('[latency] failed to wire audio tag for', jitsiId, e);
    } finally {
      pendingCaptures.delete(jitsiId);
    }
  });
}

function startAudioTagsObserver() {
  if (audioTagObserver) return;
  audioTagObserver = new MutationObserver(() => {
    captureJitsiAudio();
  });
  audioTagObserver.observe(document.body, { childList: true, subtree: true });
  const _captureInterval = setInterval(captureJitsiAudio, 1000); // keep for lifecycle; reduce load not necessary
  captureJitsiAudio();
}

// React to peer state updates: rebuild effect params for that peer's chain,
// and re-scan audio tags when a peer first appears (their Jitsi audio element
// may have arrived before their WS hello, so captureJitsiAudio skipped them).
subscribePeerState((event, payload) => {
  if (event !== 'peer-upsert') return;
  if (!payload.jitsiId) return;
  // A peer's isAggregator (or a new peer) may change who the aggregator is, or
  // whether we're now in aggregator mode at all — recompute before routing.
  refreshAggregatorPeer();
  const chain = chains.get(payload.jitsiId);
  if (chain) {
    applyParams(chain, computeEffectParams(payload.effects, { rtt: payload.rtt, jitter: payload.jitter }));
  } else if (!payload.isLocal && !remoteSources.has(payload.jitsiId)) {
    captureJitsiAudio();
  }
  if (payload.isLocal) {
    updateStrudelFx(payload.effects, payload.rtt, payload.jitter);
  }
});

// React to participants: drop chains for peers who left.
subscribeParticipants((event, payload) => {
  if (event === 'leave' && payload && payload.id) {
    const src = remoteSources.get(payload.id);
    if (src) {
      try { src.source.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
      if (src.tag) { src.tag.muted = false; src.tag.volume = 1; }
      remoteSources.delete(payload.id);
    }
    const ext = externalSources.get(payload.id);
    if (ext) {
      try { ext.source && ext.source.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
      try { ext.stream.getTracks().forEach(t => t.stop()); } catch (e) { console.warn("[latency] ignored", e); }
      externalSources.delete(payload.id);
    }
    if (audioRouted.delete(payload.id)) notifyRoutingChange();
    destroyChain(payload.id);
    // The aggregator itself may have just left — fall back to the normal mix.
    refreshAggregatorPeer();
  }
});

// ---- Public API ----------------------------------------------------------

// The master-bus gain node all audio flows through (== realDestination once
// the context exists). Null before the engine boots.
export function getMasterBus() { return realDestination; }
export function getAudioContext() { return audioCtx; }

// JPattern slot gating: ramp a peer's whole chain (mic + external sources
// all flow through chain.input) open/closed at an audio-clock time. Short
// ramp avoids clicks without smearing the slot boundary.
export function setChainGate(jitsiId, level, atAudioTime = null, rampS = 0.03) {
  const chain = chains.get(jitsiId);
  if (!chain || !audioCtx) return false;
  const t = atAudioTime != null ? Math.max(atAudioTime, audioCtx.currentTime) : audioCtx.currentTime;
  const g = chain.input.gain;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(level, t, rampS);
  return true;
}

// JPattern master effects: splice a {input, output} pair between the
// master bus and the real context destination — "after all other effects".
// The spectrum analyser's parallel tap on the master bus is unaffected.
export function insertMasterChain(endpoints) {
  if (!audioCtx || !realDestination || !endpoints) return false;
  try { realDestination.disconnect(audioCtx.destination); } catch (e) { console.warn("[latency] ignored", e); }
  realDestination.connect(endpoints.input);
  endpoints.output.connect(audioCtx.destination);
  return true;
}

export function removeMasterChain(endpoints) {
  if (!audioCtx || !realDestination || !endpoints) return;
  try { realDestination.disconnect(endpoints.input); } catch (e) { console.warn("[latency] ignored", e); }
  try { endpoints.output.disconnect(audioCtx.destination); } catch (e) { console.warn("[latency] ignored", e); }
  try { realDestination.connect(audioCtx.destination); } catch (e) { console.warn("[latency] ignored", e); }
}

// Leaving JPattern mode: every chain back to unity immediately.
export function resetChainGates() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const chain of chains.values()) {
    chain.input.gain.cancelScheduledValues(now);
    chain.input.gain.setTargetAtTime(1, now, 0.03);
  }
}

export async function bootAudioEngine() {
  if (bootPromise) {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => { /* still blocked */ });
    }
    return bootPromise;
  }
  bootPromise = (async () => {
    await ensureAudioContext();
    await loadReverbBuffer();
    startAudioTagsObserver();
    // Pre-create chains for known peers so Strudel can route immediately.
    const local = getLocalParticipant();
    if (local) await ensureChain(local.id);
    return { audioCtx, realDestination };
  })();
  return bootPromise;
}

export async function ensureMasterStrudelInput() {
  await bootAudioEngine();
  await loadReverbBuffer();
  if (!masterStrudelGain) {
    masterStrudelGain = audioCtx.createGain();
    masterStrudelGain.channelCount = 2;
    masterStrudelGain.channelCountMode = 'explicit';
    Object.defineProperty(masterStrudelGain, 'maxChannelCount', { value: 2, configurable: true });
    masterStrudelGain.gain.value = 1.0;
    masterLimiter = audioCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -1.0;
    masterStrudelGain.connect(masterLimiter);

    const meterAn = audioCtx.createAnalyser();
    meterAn.fftSize = 2048;
    try { masterStrudelGain.connect(meterAn); } catch (err) { /* ignore */ }
    // meter logging disabled to reduce main-thread jank affecting audio

    strudelOut = audioCtx.createGain();
    strudelOut.gain.value = localStrudelLevel();
    strudelOut.connect(realDestination);

    const distWS = audioCtx.createWaveShaper();
    distWS.oversample = 'none';
    distWS.curve = null; // identity (off) by default

    masterLimiter.connect(strudelOut); // bypass by default; enable only if distortion used

    // Reverb wet path
    let convolver = null, convGain = null;
    if (reverbBuffer) {
      convolver = audioCtx.createConvolver();
      convolver.buffer = reverbBuffer;
      convGain = audioCtx.createGain();
      convGain.gain.value = 0; // off until reverb toggled
      try { masterLimiter.connect(convolver); } catch (err) { console.warn('[latency] reverb connect failed', err); }
      try { convolver.connect(convGain); } catch (err) { console.warn('[latency] reverb connect failed', err); }
      try { convGain.connect(strudelOut); } catch (err) { console.warn('[latency] reverb connect failed', err); }
    }

    // Noise source (2-second white-noise loop)
    const bufLen = Math.floor(audioCtx.sampleRate * 2);
    const noiseBuf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;
    const noiseSrc = audioCtx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 20000; // flat (white) by default
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.value = 0; // silent until noise toggled
    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(strudelOut);
    noiseSrc.start();

    strudelFx = { distWS, noiseFilter, noiseGain, convGain, _bypassedDist: true };
  }
  return { audioCtx, masterStrudelGain, realDestination };
}

// Strudel needs both the context and a node it can use as "destination".
export async function getStrudelAudioContext() {
  const { audioCtx: ctx, masterStrudelGain: out, realDestination: rd } = await ensureMasterStrudelInput();
  return { audioCtx: ctx, destinationNode: out, realDestination: rd };
}

export async function attachExternalStreamForPeer(jitsiId, stream, label = 'external', { monitorLocally = true } = {}) {
  if (!jitsiId || !stream) return null;
  await bootAudioEngine();
  const chain = await ensureChain(jitsiId);
  if (!chain) return null;
  const existing = externalSources.get(jitsiId);
  if (existing) {
    try { existing.source && existing.source.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
    try { existing.stream.getTracks().forEach(t => t.stop()); } catch (e) { console.warn("[latency] ignored", e); }
  }
  let source = null;
  if (monitorLocally) {
    source = audioCtx.createMediaStreamSource(stream);
    source.connect(chain.input);
  }
  externalSources.set(jitsiId, { source, stream, label });
  audioRouted.add(jitsiId);
  console.log('[latency] attached external stream →', jitsiId, label, monitorLocally ? '(monitored)' : '(room only)', 'tracks:', stream.getAudioTracks().map(t => t.label));
  notifyRoutingChange();
  return source;
}

export function detachExternalStreamForPeer(jitsiId) {
  const ext = externalSources.get(jitsiId);
  if (!ext) return;
  try { ext.source && ext.source.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
  try { ext.stream.getTracks().forEach(t => t.stop()); } catch (e) { console.warn("[latency] ignored", e); }
  externalSources.delete(jitsiId);
  if (!remoteSources.has(jitsiId)) {
    if (audioRouted.delete(jitsiId)) notifyRoutingChange();
  }
}

export function getExternalStreamLabel(jitsiId) {
  const ext = externalSources.get(jitsiId);
  return ext ? ext.label : null;
}

let jitsiMixState = null;

function findLocalJitsiAudioTrack() {
  try {
    const conf = window.APP && window.APP.conference;
    if (!conf) return null;
    // Modern jitsi-meet keeps it as a direct property.
    if (conf.localAudioTrack && typeof conf.localAudioTrack.setEffect === 'function') return conf.localAudioTrack;
    // Some builds expose a getter.
    if (typeof conf.getLocalAudioTrack === 'function') {
      const t = conf.getLocalAudioTrack();
      if (t) return t;
    }
    // Fall back to the underlying lib-jitsi-meet conference object.
    if (conf._room && typeof conf._room.getLocalAudioTrack === 'function') {
      const t = conf._room.getLocalAudioTrack();
      if (t) return t;
    }
    // Last-ditch: scan _localTracks for an audio track.
    if (Array.isArray(conf._localTracks)) {
      const t = conf._localTracks.find(t => t && (t.isAudioTrack?.() || t.type === 'audio'));
      if (t) return t;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function findOutgoingAudioSender() {
  try {
    const conf = window.APP && window.APP.conference;
    if (!conf) return null;
    // jitsi-meet stores the PeerConnection wrapper under tpc; the underlying
    // RTCPeerConnection is .peerconnection.
    const pcWrapper = conf._room?.rtc?.peerConnections;
    if (pcWrapper) {
      // peerConnections is a Map in lib-jitsi-meet.
      const iter = (pcWrapper.values && pcWrapper.values()) || pcWrapper;
      for (const tpc of iter) {
        const pc = tpc?.peerconnection;
        if (pc && pc.getSenders) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
          if (sender) return sender;
        }
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

class JitsiMicMixEffect {
  constructor(audioCtx, externalStream) {
    this._audioCtx = audioCtx;
    this._externalStream = externalStream;
    this._dest = audioCtx.createMediaStreamDestination();
    this._micSource = null;
    this._extSource = null;
  }
  isEnabled() { return true; }
  startEffect(stream) {
    try {
      this._micSource = this._audioCtx.createMediaStreamSource(stream);
      this._micSource.connect(this._dest);
    } catch (e) { console.warn('[latency] mix effect: mic source failed', e); }
    try {
      this._extSource = this._audioCtx.createMediaStreamSource(this._externalStream);
      this._extSource.connect(this._dest);
    } catch (e) { console.warn('[latency] mix effect: external source failed', e); }
    return this._dest.stream;
  }
  stopEffect() {
    try { if (this._micSource) this._micSource.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
    try { if (this._extSource) this._extSource.disconnect(); } catch (e) { console.warn("[latency] ignored", e); }
  }
}

async function propagateViaSetEffect(stream) {
  const track = findLocalJitsiAudioTrack();
  if (!track || typeof track.setEffect !== 'function') return false;
  const effect = new JitsiMicMixEffect(audioCtx, stream);
  try {
    await track.setEffect(effect);
    jitsiMixState = { track, effect };
    console.log('[latency] propagation: setEffect on local audio track');
    return true;
  } catch (e) {
    console.warn('[latency] setEffect failed', e);
    return false;
  }
}

async function propagateViaReplaceTrack(stream) {
  const sender = findOutgoingAudioSender();
  if (!sender || typeof sender.replaceTrack !== 'function') return false;
  // Build a mix of original mic + external so we don't drop the user's voice.
  const dest = audioCtx.createMediaStreamDestination();
  let micSource = null;
  if (sender.track) {
    try {
      const micStream = new MediaStream([sender.track]);
      micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(dest);
    } catch (e) { console.warn('[latency] replaceTrack: cannot tap mic', e); }
  }
  let extSource = null;
  try {
    extSource = audioCtx.createMediaStreamSource(stream);
    extSource.connect(dest);
  } catch (e) { console.warn('[latency] replaceTrack: ext source failed', e); }
  const mixedTrack = dest.stream.getAudioTracks()[0];
  if (!mixedTrack) return false;
  const originalTrack = sender.track;
  try {
    await sender.replaceTrack(mixedTrack);
    jitsiMixState = {
      replacedSender: sender,
      originalTrack,
      mixedTrack,
      _disposers: [
        () => { try { micSource && micSource.disconnect(); } catch (e) { console.warn("[latency] ignored", e); } },
        () => { try { extSource && extSource.disconnect(); } catch (e) { console.warn("[latency] ignored", e); } }
      ]
    };
    console.log('[latency] propagation: replaceTrack on outgoing sender');
    return true;
  } catch (e) {
    console.warn('[latency] replaceTrack failed', e);
    return false;
  }
}

export async function propagateExternalStreamToRoom(stream) {
  if (!stream) return false;
  await bootAudioEngine();
  if (jitsiMixState) await stopPropagatingExternalStream();
  if (await propagateViaSetEffect(stream)) return true;
  if (await propagateViaReplaceTrack(stream)) return true;
  console.warn('[latency] could not propagate external stream — no compatible Jitsi audio surface');
  return false;
}

export async function stopPropagatingExternalStream() {
  if (!jitsiMixState) return;
  const s = jitsiMixState;
  jitsiMixState = null;
  if (s.track && typeof s.track.setEffect === 'function') {
    try { await s.track.setEffect(undefined); } catch (e) { console.warn('[latency] setEffect undo failed', e); }
  } else if (s.replacedSender) {
    try {
      if (s.originalTrack) await s.replacedSender.replaceTrack(s.originalTrack);
    } catch (e) { console.warn('[latency] replaceTrack restore failed', e); }
    if (Array.isArray(s._disposers)) s._disposers.forEach(fn => fn());
  }
  console.log('[latency] external propagation stopped');
}

export function isPropagatingToRoom() {
  return !!jitsiMixState;
}

// A continuous ~-70 dBFS noise floor on the published Strudel track, so it is
// never literal digital zero: Chrome's sender skips "silent" stretches (91% of
// what the aggregator received was concealment, with no packet loss, before
// this existed — see 104335a). It must stay well above one 16-bit step
// (1/32768 ≈ 0.00003), the resolution WebRTC encodes at: below that it rounds
// to exactly the zero it is there to prevent.
const DITHER_LEVEL = 0.0003;
function createDitherNode(audioCtx) {
  const bufLen = Math.floor(audioCtx.sampleRate * 2);
  const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = audioCtx.createGain();
  gain.gain.value = DITHER_LEVEL;
  src.connect(gain);
  src.start();
  return { node: gain, stop: () => { try { src.stop(); } catch (e) { /* already stopped */ } } };
}

// A jitsi-meet track effect whose output is exactly `node` — the mic input it is
// handed is ignored. `node` connects straight into the effect's destination (no
// MediaStream round-trip → no Chrome same-context loopback silence). Also mixes
// in the dither above, scoped to this effect's own destination only — it never
// reaches the local monitor or any other consumer of `node`.
class NodeOutputEffect {
  constructor(audioCtx, node) {
    this._ctx = audioCtx;
    this._node = node;
    this._dest = audioCtx.createMediaStreamDestination();
    this._dither = null;
  }
  isEnabled() { return true; }
  startEffect(_micStream) {
    try { this._node.connect(this._dest); }
    catch (e) { console.warn('[latency] NodeOutputEffect connect failed', e); }
    try {
      this._dither = createDitherNode(this._ctx);
      this._dither.node.connect(this._dest);
    } catch (e) { console.warn('[latency] NodeOutputEffect dither failed', e); }
    return this._dest.stream;
  }
  stopEffect() {
    try { this._node.disconnect(this._dest); } catch (e) { console.warn("[latency] ignored", e); }
    if (this._dither) {
      try { this._dither.node.disconnect(this._dest); } catch (e) { console.warn("[latency] ignored", e); }
      try { this._dither.stop(); } catch (e) { console.warn("[latency] ignored", e); }
      this._dither = null;
    }
  }
}

let strudelRoomEffect = null; // { track, effect } while publishing, else null
let strudelPublishRetryTimer = null; // aggregator-mode publish guard interval
let strudelTrackAcquiring = false;   // acquireLocalAudioTrackForStrudel() in flight
let strudelTrackAcquireAt = 0;       // epoch ms of the last acquisition attempt
let strudelPublishWarned = false;    // "no local track" logged once per outage
let strudelSynthDest = null;         // MediaStreamAudioDestinationNode feeding the published Strudel track (no mic)
let strudelPublishBackoff = false;   // last acquisition failed outright — poll slowly, not every 8s
const STRUDEL_TRACK_ACQUIRE_COOLDOWN_MS = 8000;
const STRUDEL_TRACK_ACQUIRE_BACKOFF_MS = 30000;

function stopStrudelPublishRetry() {
  if (strudelPublishRetryTimer) { clearInterval(strudelPublishRetryTimer); strudelPublishRetryTimer = null; }
}

// Resolve once a local Jitsi audio track with a usable setEffect API exists, or
// after timeoutMs with null. Polled (like participants.js) because track
// creation is driven by jitsi-meet internals we don't get events for.
function pollForLocalAudioTrack(timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const t = findLocalJitsiAudioTrack();
      if (t && typeof t.setEffect === 'function') return resolve(t);
      if (Date.now() - started >= timeoutMs) return resolve(null);
      setTimeout(tick, 120);
    };
    tick();
  });
}

async function acquireLocalAudioTrackForStrudel() {
  const existing = findLocalJitsiAudioTrack();
  if (existing && typeof existing.setEffect === 'function') return existing;
  if (strudelTrackAcquiring) return null;
  const cooldown = strudelPublishBackoff ? STRUDEL_TRACK_ACQUIRE_BACKOFF_MS : STRUDEL_TRACK_ACQUIRE_COOLDOWN_MS;
  if (Date.now() - strudelTrackAcquireAt < cooldown) return null;
  strudelTrackAcquiring = true;
  strudelTrackAcquireAt = Date.now();
  try {
    const conf = window.APP && window.APP.conference;
    // 1) Mic permission granted → jitsi-meet's own unmute is simplest.
    if (conf && typeof conf.muteAudio === 'function') {
      try { await conf.muteAudio(false); } catch (e) { /* denied — fall through to (2) */ }
      const t = await pollForLocalAudioTrack(2000);
      if (t) { strudelPublishBackoff = false; return t; }
    }
    // 2) No track (mic muted or blocked) → publish a synthetic Strudel track.
    if (audioCtx && masterStrudelGain && window.JitsiMeetJS
        && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
      if (!strudelSynthDest) {
        strudelSynthDest = audioCtx.createMediaStreamDestination();
        try { masterLimiter.connect(strudelSynthDest); } catch (e) { console.warn("[latency] ignored", e); }
      }
      const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c = {}) =>
        (c && c.audio && !c.video && strudelSynthDest) ? strudelSynthDest.stream : realGUM(c);
      let at = null;
      try {
        const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['audio'] });
        at = tracks && tracks[0];
      } catch (e) {
        console.warn('[latency] strudel publish: synthetic-track create failed', e);
      } finally {
        navigator.mediaDevices.getUserMedia = realGUM; // restore before anything else can gUM
      }
      if (at && conf) {
        try {
          if (typeof conf.useAudioStream === 'function') await conf.useAudioStream(at);
          else if (conf._room && typeof conf._room.addTrack === 'function') await conf._room.addTrack(at);
        } catch (e) {
          console.warn('[latency] strudel publish: useAudioStream failed', e);
        }
      }
      const t = await pollForLocalAudioTrack(2500);
      if (t) { strudelPublishBackoff = false; return t; }
    }
    strudelPublishBackoff = true; // nothing took — slow the retry down
  } finally {
    strudelTrackAcquiring = false;
  }
  return findLocalJitsiAudioTrack();
}

function ensureStrudelPublishGuard() {
  if (strudelPublishRetryTimer) return; // already polling
  strudelPublishRetryTimer = setInterval(() => {
    if (!aggregatorJitsiId) { stopStrudelPublishRetry(); return; }
    if (strudelRoomEffect) {
      const current = findLocalJitsiAudioTrack();
      if (current === strudelRoomEffect.track) return;
      try { strudelRoomEffect.effect.stopEffect(); } catch (e) { console.warn("[latency] ignored", e); }
      strudelRoomEffect = null;
      console.warn('[latency] published Strudel track was replaced (renegotiation?) — re-publishing');
    }
    publishLocalStrudelToRoom().catch((e) => console.warn('[latency] strudel publish retry failed', e));
  }, 2000);
}

export async function publishLocalStrudelToRoom() {
  if (window.__trussalIsBot || window.__trussalIsAggregator) return false;
  if (strudelRoomEffect) return true; // already publishing
  await ensureMasterStrudelInput(); // guarantees masterStrudelGain + audioCtx
  if (!masterStrudelGain) return false;
  let track = findLocalJitsiAudioTrack();
  if (!track || typeof track.setEffect !== 'function') {
    track = await acquireLocalAudioTrackForStrudel();
  }
  if (!track || typeof track.setEffect !== 'function') {
    if (!strudelPublishWarned) {
      console.warn('[latency] cannot publish local Strudel to room yet — no local Jitsi audio track (mic blocked and synthetic publish did not take); retrying');
      strudelPublishWarned = true;
    }
    ensureStrudelPublishGuard();
    return false;
  }
  strudelPublishWarned = false;
  const effect = new NodeOutputEffect(audioCtx, masterLimiter);
  try {
    await track.setEffect(effect);
  } catch (e) {
    console.warn('[latency] publish Strudel setEffect failed', e);
    ensureStrudelPublishGuard(); // transient failures retry on the poll
    return false;
  }
  strudelRoomEffect = { track, effect };
  // Keep the guard running: a renegotiation can replace the track under the
  // effect at any time while the aggregator is present.
  ensureStrudelPublishGuard();
  console.log('[latency] publishing local Strudel to room (Strudel-only, direct node) for the aggregator to tap');
  return true;
}

export async function unpublishLocalStrudelFromRoom() {
  stopStrudelPublishRetry(); // aggregator gone (or never published) — stop waiting for the mic
  strudelPublishWarned = false; // next aggregator re-arms the one-shot warning
  strudelPublishBackoff = false;
  if (strudelSynthDest) {
    try { masterLimiter && masterLimiter.disconnect(strudelSynthDest); } catch (e) { console.warn("[latency] ignored", e); }
    strudelSynthDest = null;
  }
  if (!strudelRoomEffect) return;
  const s = strudelRoomEffect;
  strudelRoomEffect = null;
  try {
    if (s.track && typeof s.track.setEffect === 'function') await s.track.setEffect(undefined);
  } catch (e) { console.warn('[latency] stop publishing Strudel failed', e); }
  console.log('[latency] stopped publishing local Strudel to room');
}

// Manual hooks for testing the publish path without depending on aggregator
// detection (which rides the sometimes-flaky peer-state bus).
if (typeof window !== 'undefined') {
  window.__trussalPublishStrudelToRoom = publishLocalStrudelToRoom;
  window.__trussalUnpublishStrudelFromRoom = unpublishLocalStrudelFromRoom;
  window.__trussalAudioDiag = async () => {
    const out = {
      aggregatorJitsiId,                                   // non-null => in aggregator mode
      strudelOutGain: strudelOut ? strudelOut.gain.value : null, // 0 => local monitor muted
      ctxState: audioCtx ? audioCtx.state : 'no-ctx',
      sampleRate: audioCtx ? audioCtx.sampleRate : null,
    };
    if (audioCtx && masterStrudelGain) {
      const t0 = audioCtx.currentTime;
      const an = audioCtx.createAnalyser();
      an.fftSize = 2048;
      masterStrudelGain.connect(an);                       // tap only; doesn't alter output
      const buf = new Float32Array(an.fftSize);
      let peak = 0, sumSq = 0, n = 0;
      const end = performance.now() + 500;
      while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, 40));
        an.getFloatTimeDomainData(buf);
        for (const v of buf) { const a = v < 0 ? -v : v; if (a > peak) peak = a; sumSq += v * v; n++; }
      }
      try { masterStrudelGain.disconnect(an); } catch (e) { console.warn("[latency] ignored", e); }
      out.strudelPeak = +peak.toFixed(5);                  // >0 => Strudel IS producing sound
      out.strudelRms = +Math.sqrt(sumSq / (n || 1)).toFixed(5);
      out.ctxClockAdvanced = +(audioCtx.currentTime - t0).toFixed(3); // ~0 => context frozen/suspended
    }
    console.log('[trussal] audio diag', out);
    return out;
  };
}

// Attach a pre-built WebAudio node directly to a peer's effects chain.
// AudioWorklet output connects straight into the chain input node.
export async function attachNodeToChain(jitsiId, node, label = 'relay') {
  if (!jitsiId || !node) return;
  await bootAudioEngine();
  const chain = await ensureChain(jitsiId);
  if (!chain) return;
  const existing = externalNodes.get(jitsiId);
  if (existing) {
    try { existing.node.disconnect(chain.input); } catch (_) {}
  }
  node.connect(chain.input);
  externalNodes.set(jitsiId, { node, label });
  audioRouted.add(jitsiId);
  console.log('[latency] attached WebAudio node →', jitsiId, label);
  notifyRoutingChange();
}

export function detachNodeFromChain(jitsiId) {
  const entry = externalNodes.get(jitsiId);
  if (!entry) return;
  const chain = chains.get(jitsiId);
  if (chain) {
    try { entry.node.disconnect(chain.input); } catch (_) {}
  }
  externalNodes.delete(jitsiId);
  if (!remoteSources.has(jitsiId) && !externalSources.has(jitsiId)) {
    if (audioRouted.delete(jitsiId)) notifyRoutingChange();
  }
  console.log('[latency] detached WebAudio node ←', jitsiId);
}

export function getExternalNodeLabel(jitsiId) {
  return externalNodes.get(jitsiId)?.label ?? null;
}

export async function listAudioInputDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  // Device labels are only populated once any audio permission has been
  // granted; if labels look empty we briefly request the default mic so the
  // subsequent enumerate call returns named devices.
  let devices = await navigator.mediaDevices.enumerateDevices();
  let inputs = devices.filter(d => d.kind === 'audioinput');
  const labelsMissing = inputs.length && inputs.every(d => !d.label);
  if (labelsMissing) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter(d => d.kind === 'audioinput');
    } catch (e) { /* user denied */ }
  }
  return inputs.map(d => ({ deviceId: d.deviceId, label: d.label || 'Unnamed audio input' }));
}
