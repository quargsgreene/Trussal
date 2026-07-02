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
import { subscribePeerState, getPeerByJitsiId } from './peer-state.js';

let audioCtx = null;
let realDestination = null;
let workletLoaded = null;
let reverbBuffer = null;
let masterStrudelGain = null;
let bootPromise = null;

// WebAudio effect chain applied to the local peer's Strudel master output.
// These run post-mix on the combined instrument bus, guaranteeing audible
// effects regardless of whether the Strudel evaluate() succeeds.
let strudelFx = null; // { distWS, noiseGain, noiseFilter, convGain } | null

const chains = new Map();           // jitsiId -> chain
const remoteSources = new Map();    // jitsiId -> { tag, source, label }
const pendingCaptures = new Set();  // jitsiIds currently being wired (prevents concurrent duplicates)
const externalSources = new Map();  // jitsiId -> { source, stream }
const externalNodes = new Map();    // jitsiId -> { node, label }  (WebAudio node, no MediaStream)
const audioRouted = new Set();      // jitsiIds whose chain has any live source
const routingSubscribers = new Set();

// Jamulus mode: aggregate Jamulus audio is routed through the local peer's
// effects chain; all other Jitsi peer audio tags are silenced so the Jamulus
// mix is the sole audio source.
let jamulusMode = false;
const jamulasMutedTags = new Set(); // tags we silenced on mode entry
let audioTagObserver = null;

function notifyRoutingChange() {
  routingSubscribers.forEach(fn => {
    try { fn(new Set(audioRouted)); } catch (e) { console.warn('[latency] routing subscriber threw', e); }
  });
}

export function subscribeAudioRouting(fn) {
  routingSubscribers.add(fn);
  try { fn(new Set(audioRouted)); } catch (e) {}
  return () => routingSubscribers.delete(fn);
}

export function getRoutedPeerIds() {
  return Array.from(audioRouted);
}

export function isAudioRoutedFor(jitsiId) {
  return audioRouted.has(jitsiId);
}

function applyJamulusMuteToAllTags() {
  document.querySelectorAll('audio').forEach(tag => {
    if (!tag.srcObject) return;
    if (tag.id === 'userAudio') return;
    // Skip tags already silenced by captureJitsiAudio — they're in remoteSources.
    const jitsiId = getParticipantIdForAudioTag(tag);
    if (jitsiId && remoteSources.has(jitsiId)) return;
    if (jamulasMutedTags.has(tag)) return;
    tag.muted = true;
    tag.volume = 0;
    jamulasMutedTags.add(tag);
  });
}

export function setJamulusMode(enabled) {
  if (enabled === jamulusMode) return;
  jamulusMode = enabled;
  if (enabled) {
    applyJamulusMuteToAllTags();
  } else {
    for (const tag of jamulasMutedTags) {
      tag.muted = false;
      tag.volume = 1;
    }
    jamulasMutedTags.clear();
  }
}

export function isJamulusMode() { return jamulusMode; }

function ensureAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return Promise.reject(new Error('WebAudio not supported'));
  if (!audioCtx) {
    // 48 kHz matches the Jamulus relay PCM stream and WebRTC Opus codec rate,
    // avoiding pitch-shift when relay audio flows through the effects chain.
    audioCtx = new Ctor({ sampleRate: 48000 });
    // Master bus: every chain/effect that used to target audioCtx.destination
    // now converges on this gain node, giving SpectrumAnalysis (and the room
    // health compressor) one place to tap the full mix.
    const masterBus = audioCtx.createGain();
    masterBus.gain.value = 1.0;
    masterBus.connect(audioCtx.destination);
    realDestination = masterBus;
  }
  if (!audioCtx.audioWorklet) return Promise.reject(new Error('AudioWorklet not supported'));

  if (!workletLoaded) {
    workletLoaded = audioCtx.audioWorklet.addModule('/latency-worklet-v2.js');
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

// Apply or update the Strudel WebAudio effect chain.  Called whenever the
// local peer's effects or metrics change so the master bus always reflects
// the current toggle state regardless of Strudel evaluate() success.
function updateStrudelFx(effects, rtt, jitter) {
  if (!strudelFx || !audioCtx) return;
  const e   = effects || {};
  const r   = rtt    || 0;
  const j   = jitter || 0;
  const now = audioCtx.currentTime;

  // Distortion — WaveShaperNode curve; null = identity (bypass).
  if (e.distortion) {
    const base  = 0.2;
    const extra = Math.max(0, Math.min(0.8, (r - 5) / 55 + j / 6));
    strudelFx.distWS.curve = makeDistortionCurve(base + extra);
  } else {
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
  try { chain.limiter.disconnect(); } catch (e) {}
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

  // Keep a stereo bus through the effect node so the stereo Opus path
  // (ENABLE_STEREO) isn't flattened. Configure the channels explicitly rather
  // than relying on AudioWorkletNode's implicit channelCountMode default, which
  // is browser-dependent; with `channelCount: 1` the node could down-mix to
  // mono. The processor already iterates every channel, so it applies the
  // distortion/noise to L and R independently. Mono sources (a DI, or a peer
  // sending mono) are up-mixed to dual-mono here, which is the correct centered
  // result.
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

  input.connect(worklet);
  worklet.connect(limiter);
  limiter.connect(realDestination); // dry path by default

  return { jitsiId, input, worklet, limiter, reverb, reverbGain, reverbOn: false };
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
  try { chain.input.disconnect(); } catch (e) {}
  try { chain.worklet.disconnect(); } catch (e) {}
  try { chain.limiter.disconnect(); } catch (e) {}
  if (chain.reverb) { try { chain.reverb.disconnect(); } catch (e) {} }
  if (chain.reverbGain) { try { chain.reverbGain.disconnect(); } catch (e) {} }
  chains.delete(jitsiId);
}

// Capture every remote Jitsi <audio> element exactly once and route it to its
// owner's effect chain. The tag id (remoteAudio_<jitsiId>) is the bridge. Any
// audio that reaches the browser via Jitsi mic — including Jamulus content the
// upstream peer is loopback-routing into their mic — is captured here, which
// is how Jamulus audio ends up running through the per-peer worklet chain.
function captureJitsiAudio() {
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
    } catch (e) { /* ignore — if we can't tell, proceed */ }
    // Only route audio through WebAudio for peers in our signalling system.
    // Ghost/stale sessions (e.g. SMACKS hibernating sessions) never connect to
    // our WS server, so they stay with native Jitsi playback where the browser's
    // AEC reference is intact. Bypassing AEC for those participants is what lets
    // their audio (which is often an echo of your own voice from the JVB) loop
    // back through your mic uncancelled — persisting even when you mute Jitsi.
    if (!getPeerByJitsiId(jitsiId)) return;
    if (remoteSources.has(jitsiId)) return;
    // Guard against concurrent async captures for the same jitsiId (MutationObserver
    // can fire multiple times before the first await resolves, which would create
    // duplicate MediaStreamSource nodes on the same chain and cause doubled audio).
    if (pendingCaptures.has(jitsiId)) return;
    pendingCaptures.add(jitsiId);

    try {
      const chain = await ensureChain(jitsiId);
      if (!chain) return;
      // Re-check after the async gap — another call may have completed first.
      if (remoteSources.has(jitsiId)) return;
      const source = audioCtx.createMediaStreamSource(tag.srcObject);
      source.connect(chain.input);
      tag.muted = true;
      tag.volume = 0;
      const trackLabels = (tag.srcObject.getAudioTracks?.() || []).map(t => t.label || 'audio');
      remoteSources.set(jitsiId, { tag, source, label: trackLabels.join(',') || 'mic' });
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
    if (jamulusMode) applyJamulusMuteToAllTags();
  });
  audioTagObserver.observe(document.body, { childList: true, subtree: true });
  captureJitsiAudio();
}

// React to peer state updates: rebuild effect params for that peer's chain,
// and re-scan audio tags when a peer first appears (their Jitsi audio element
// may have arrived before their WS hello, so captureJitsiAudio skipped them).
subscribePeerState((event, payload) => {
  if (event !== 'peer-upsert') return;
  if (!payload.jitsiId) return;
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
      try { src.source.disconnect(); } catch (e) {}
      if (src.tag) { src.tag.muted = false; src.tag.volume = 1; }
      remoteSources.delete(payload.id);
    }
    const ext = externalSources.get(payload.id);
    if (ext) {
      try { ext.source && ext.source.disconnect(); } catch (e) {}
      try { ext.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      externalSources.delete(payload.id);
    }
    if (audioRouted.delete(payload.id)) notifyRoutingChange();
    destroyChain(payload.id);
  }
});

// ---- Public API ----------------------------------------------------------

// The master-bus gain node all audio flows through (== realDestination once
// the context exists). Null before the engine boots.
export function getMasterBus() { return realDestination; }
export function getAudioContext() { return audioCtx; }

// Net Cycles slot gating: ramp a peer's whole chain (mic + external sources
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

// Net Cycles master effects: splice a {input, output} pair between the
// master bus and the real context destination — "after all other effects".
// The spectrum analyser's parallel tap on the master bus is unaffected.
export function insertMasterChain(endpoints) {
  if (!audioCtx || !realDestination || !endpoints) return false;
  try { realDestination.disconnect(audioCtx.destination); } catch (e) {}
  realDestination.connect(endpoints.input);
  endpoints.output.connect(audioCtx.destination);
  return true;
}

export function removeMasterChain(endpoints) {
  if (!audioCtx || !realDestination || !endpoints) return;
  try { realDestination.disconnect(endpoints.input); } catch (e) {}
  try { endpoints.output.disconnect(audioCtx.destination); } catch (e) {}
  try { realDestination.connect(audioCtx.destination); } catch (e) {}
}

// Leaving Net Cycles mode: every chain back to unity immediately.
export function resetChainGates() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const chain of chains.values()) {
    chain.input.gain.cancelScheduledValues(now);
    chain.input.gain.setTargetAtTime(1, now, 0.03);
  }
}

export async function bootAudioEngine() {
  if (bootPromise) return bootPromise;
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

// Strudel hands its stacked output here. We mix into the local user's chain so
// per-peer effect toggles applied via Strudel-native operators in strudel.js
// still flow through the master output without going through any one peer's
// worklet (which would re-color everyone). One dedicated gain node sits in
// front of realDestination for Strudel-only volume control.
export async function ensureMasterStrudelInput() {
  await bootAudioEngine();
  await loadReverbBuffer();
  if (!masterStrudelGain) {
    masterStrudelGain = audioCtx.createGain();
    masterStrudelGain.channelCount = 2;
    masterStrudelGain.channelCountMode = 'explicit';
    Object.defineProperty(masterStrudelGain, 'maxChannelCount', { value: 2, configurable: true });
    masterStrudelGain.gain.value = 1.0;

    // Build the Strudel-output effect chain:
    //   masterStrudelGain → distWS → realDestination  (dry + distortion)
    //                              → convolver → convGain → realDestination  (reverb wet)
    //   noiseSource → noiseFilter → noiseGain → realDestination

    const distWS = audioCtx.createWaveShaper();
    distWS.oversample = '4x';
    distWS.curve = null; // identity (off) by default

    masterStrudelGain.connect(distWS);
    distWS.connect(realDestination);

    // Reverb wet path
    let convolver = null, convGain = null;
    if (reverbBuffer) {
      convolver = audioCtx.createConvolver();
      convolver.buffer = reverbBuffer;
      convGain = audioCtx.createGain();
      convGain.gain.value = 0; // off until reverb toggled
      masterStrudelGain.connect(convolver);
      convolver.connect(convGain);
      convGain.connect(realDestination);
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
    noiseGain.connect(realDestination);
    noiseSrc.start();

    strudelFx = { distWS, noiseFilter, noiseGain, convGain };
  }
  return { audioCtx, masterStrudelGain, realDestination };
}

// Strudel needs both the context and a node it can use as "destination".
export async function getStrudelAudioContext() {
  const { audioCtx: ctx, masterStrudelGain: out, realDestination: rd } = await ensureMasterStrudelInput();
  return { audioCtx: ctx, destinationNode: out, realDestination: rd };
}

// Attach any MediaStream to a participant's effects chain. Used by the studio
// UI to bring in a system-level audio input (e.g. a virtual device that
// loopback-carries Jamulus output) so it flows through the same worklet +
// reverb path as remote Jitsi audio.
//
// monitorLocally controls whether the stream is also played out of THIS
// browser's speakers (source → chain → realDestination). For a peer's incoming
// audio that is the whole point, but for the LOCAL user capturing their own
// Jamulus/system output it must be false: the capture device is typically a
// monitor/loopback of the same output realDestination feeds, so playing it back
// re-emits the captured signal into the very device we're capturing — it gets
// re-captured, re-emitted, and howls ("nothing but feedback"). The local user
// already hears Jamulus natively, so we only propagate the stream to the room
// (see propagateExternalStreamToRoom) rather than monitoring it here.
export async function attachExternalStreamForPeer(jitsiId, stream, label = 'external', { monitorLocally = true } = {}) {
  if (!jitsiId || !stream) return null;
  await bootAudioEngine();
  const chain = await ensureChain(jitsiId);
  if (!chain) return null;
  const existing = externalSources.get(jitsiId);
  if (existing) {
    try { existing.source && existing.source.disconnect(); } catch (e) {}
    try { existing.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
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
  try { ext.source && ext.source.disconnect(); } catch (e) {}
  try { ext.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  externalSources.delete(jitsiId);
  if (!remoteSources.has(jitsiId)) {
    if (audioRouted.delete(jitsiId)) notifyRoutingChange();
  }
}

export function getExternalStreamLabel(jitsiId) {
  const ext = externalSources.get(jitsiId);
  return ext ? ext.label : null;
}

// ---- Outgoing Jitsi mic propagation -------------------------------------
//
// When the local user captures an external stream (e.g. a Jamulus loopback),
// we mix that stream into the OUTGOING Jitsi audio track so other peers in the
// meeting receive it as part of our mic. Their browsers run our mic through
// our per-peer chain (which is keyed by our jitsiId), so the room hears the
// processed result everywhere. The local user still also routes the raw
// stream into their local chain for self-monitoring (separate path).

let jitsiMixState = null; // { track, effect, replacedSender, originalTrack }

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
    try { if (this._micSource) this._micSource.disconnect(); } catch (e) {}
    try { if (this._extSource) this._extSource.disconnect(); } catch (e) {}
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
        () => { try { micSource && micSource.disconnect(); } catch (e) {} },
        () => { try { extSource && extSource.disconnect(); } catch (e) {} }
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

// Attach a pre-built WebAudio node directly to a peer's effects chain.
// Used by the Jamulus relay to avoid the MediaStream round-trip: the relay
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
