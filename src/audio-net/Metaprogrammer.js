// Metaprogrammer — the Net Cycles eval driver (browser side).
//
// Owns the room's metaprogram: auto-populates the default program from the
// roster (join appends, leave removes), parses edits, and drives the pure
// MetaprogramScheduler with ClockSync network time. Scheduler slot events
// become:
//   - Strudel voice gates: strudel.js wraps every voice in
//     .gain(_ncGate(jitsiId)) and _ncGate reads getGateLevel() reactively —
//     outside their slot a performer's instrument is silent.
//   - Mic/chain gates: latency-instrument's per-peer chain input gain is
//     ramped at the slot boundary (bots' Jitsi-published audio included).
//   - Buffer dequeue: each participant's AV buffer queue enqueues one AV
//     object per cycle (pattern text + o2lite messages + performance
//     status; audio blob when capture is enabled). When the metapattern
//     reaches them, the head buffer is dequeued and its pattern update is
//     applied — an editor change therefore lands at the *next* slot, not
//     immediately.
//
// Cross-browser agreement: same CRDT-shared program text (Phase 6), same
// broadcast worst-case metrics, and a shared epoch — every client
// broadcasts its epoch on /nc/epoch over the O2 relay and adopts the
// smallest it hears, so all schedulers converge on one cycle grid.

import {
  parseMetaprogram,
  buildDefaultProgram,
  appendParticipantToProgram,
  removeParticipantFromProgram
} from './MetaprogrammerParser.js';
import { MetaprogramScheduler, AVBufferQueue } from './MetaprogramScheduler.js';
import { computeWorstCaseMetrics } from './network-modulation/WorstCaseCalculationUtils.js';
import { makeClockSyncOverO2 } from './ClockSync.js';
import { O2LiteClient } from '../../public/lib/o2lite-web.js';
import { subscribePeerState, getAllPeers } from '../peer-state.js';
import { getRoomNameFromUrl } from '../jamulus.js';
import { getAudioContext, setChainGate, resetChainGates, attachNodeToChain } from '../latency-instrument.js';

const EPOCH_ADDR = '/nc/epoch';
const EPOCH_REBROADCAST_MS = 10000;
const QUEUE_LIMITS = { maxBuffers: 8, maxBytes: 32 * 1024 * 1024 };

let active = false;
let programText = null;      // current program source (CRDT doc in Phase 6)
let customProgram = false;   // once a user applies an edit, joins/leaves patch text instead of regenerating
let scheduler = null;
let o2 = null;
let clock = null;
let epoch = null;
let epochTimer = null;
let localSecondsFallbackT0 = null;

const queues = new Map();        // token (room index) → AVBufferQueue
const activePatterns = new Map(); // jitsiId → pattern applied by the last dequeued buffer
const gateLevels = new Map();     // jitsiId → 0|1 (read reactively by strudel _ncGate)
const pendingEditorUpdates = new Map(); // token → latest pattern text since last enqueue
const slotSubscribers = new Set();
const slotTimers = new Set();

// --- Small helpers -----------------------------------------------------------

function localSeconds() {
  const ctx = getAudioContext();
  if (ctx) return ctx.currentTime;
  if (localSecondsFallbackT0 == null) localSecondsFallbackT0 = performance.now();
  return (performance.now() - localSecondsFallbackT0) / 1000;
}

function peerByToken(token) {
  return getAllPeers().find(p => p.roomIndex != null && String(p.roomIndex) === token) || null;
}

function rosterTokens() {
  return getAllPeers()
    .filter(p => p.roomIndex != null)
    .map(p => String(p.roomIndex))
    // Join order == numeric order for humans; bots sort inside their owner's
    // cluster by suffix length then lexicographically (a < z < za < zb).
    .sort((a, b) => {
      const pa = a.match(/^(\d+)([a-z]*)$/), pb = b.match(/^(\d+)([a-z]*)$/);
      const na = parseInt(pa[1], 10), nb = parseInt(pb[1], 10);
      if (na !== nb) return na - nb;
      if (pa[2].length !== pb[2].length) return pa[2].length - pb[2].length;
      return pa[2] < pb[2] ? -1 : pa[2] > pb[2] ? 1 : 0;
    });
}

function emitSlot(event) {
  slotSubscribers.forEach(fn => {
    try { fn(event); } catch (e) { console.warn('[metaprogrammer] slot subscriber threw', e); }
  });
}

// --- Program text maintenance --------------------------------------------------

function regenerateOrPatchProgram() {
  const tokens = rosterTokens();
  if (!customProgram || programText == null) {
    programText = buildDefaultProgram(tokens);
  } else {
    // Keep user edits; append newcomers, drop leavers.
    const { ast } = parseMetaprogram(programText);
    const inProgram = new Set();
    if (ast.participants) {
      for (const st of ast.participants.stacks) {
        for (const el of st.elements) if (el.token) inProgram.add(el.token);
      }
    }
    for (const tok of tokens) {
      if (!inProgram.has(tok)) programText = appendParticipantToProgram(programText, tok);
    }
    for (const tok of inProgram) {
      if (!tokens.includes(tok)) programText = removeParticipantFromProgram(programText, tok);
    }
  }
  pushProgramToScheduler();
  document.dispatchEvent(new CustomEvent('trussal-netcycles-program', { detail: { text: programText } }));
}

function pushProgramToScheduler() {
  if (!scheduler || programText == null) return;
  const { ast, valid } = parseMetaprogram(programText);
  if (valid) scheduler.setProgram(ast);
}

// Explicit apply from the editor (Phase 6 UI). Returns parse errors.
export function applyProgramText(text) {
  const { errors, valid } = parseMetaprogram(text);
  if (valid) {
    programText = text;
    customProgram = true;
    pushProgramToScheduler();
    document.dispatchEvent(new CustomEvent('trussal-netcycles-program', { detail: { text } }));
  }
  return errors;
}

export function getProgramText() { return programText; }

// --- Queues ---------------------------------------------------------------------

function queueFor(token) {
  let q = queues.get(token);
  if (!q) { q = new AVBufferQueue(QUEUE_LIMITS); queues.set(token, q); }
  return q;
}

// One AV object per participant per cycle. "Each individual participant
// automatically enqueues AV buffer objects at intervals specified by the
// cyclic timing mode, which may or may not be empty"; a valid editor update
// since the last interval rides along.
function enqueueCycleBuffers(cycle) {
  for (const peer of getAllPeers()) {
    if (peer.roomIndex == null) continue;
    const token = String(peer.roomIndex);
    const pendingPattern = pendingEditorUpdates.get(token);
    pendingEditorUpdates.delete(token);
    const audio = captureTakes.get(token) || null;
    captureTakes.delete(token);
    queueFor(token).enqueue({
      pattern: pendingPattern ?? null,   // null = empty buffer (no code change)
      audio,
      messages: [],
      status: { playing: !!peer.playing, muted: !!peer.muted },
      bytes: (audio && audio.bytes) || 0,
      cycle
    });
  }
}

export function getQueueDepth(token) {
  const q = queues.get(token);
  return q ? q.length : 0;
}

// --- Gates ------------------------------------------------------------------------

export function getGateLevel(jitsiId) {
  if (!active) return 1;
  return gateLevels.get(jitsiId) ?? 0;
}

function scheduleGate(jitsiId, level, atNetworkT) {
  const nowNet = clock && clock.isSynced() ? clock.toNetworkTime(localSeconds()) : localSeconds();
  const delayMs = Math.max(0, (atNetworkT - nowNet) * 1000);
  const audioT = clock && clock.isSynced() ? clock.toAudioTime(atNetworkT) : null;
  setChainGate(jitsiId, level, audioT);
  const timer = setTimeout(() => {
    slotTimers.delete(timer);
    if (!active) return;
    gateLevels.set(jitsiId, level);
  }, delayMs);
  slotTimers.add(timer);
}

// --- Slot handling ----------------------------------------------------------------

function onSchedulerEvent(ev) {
  emitSlot(ev);
  if (ev.type === 'cycle-start') {
    enqueueCycleBuffers(ev.cycle);
    return;
  }
  const peer = ev.token ? peerByToken(ev.token) : null;
  if (!peer || !peer.jitsiId) return;

  if (ev.type === 'slot-open') {
    const av = queueFor(ev.token).dequeue(); // empty → null: silence, cycle advances
    if (av) {
      if (typeof av.pattern === 'string') {
        activePatterns.set(peer.jitsiId, av.pattern);
        document.dispatchEvent(new CustomEvent('trussal-netcycles-apply', {
          detail: { jitsiId: peer.jitsiId, token: ev.token }
        }));
      }
      if (av.audio) replayCapturedAudio(peer.jitsiId, av.audio, ev);
    }
    scheduleGate(peer.jitsiId, 1, ev.t);
  } else if (ev.type === 'slot-close') {
    scheduleGate(peer.jitsiId, 0, ev.t);
  }
}

// Pattern applied by the last dequeued buffer — strudel.js prefers this over
// the live peer.pattern while Net Cycles is active, which is what delays an
// edit to the performer's next slot.
export function getActivePattern(jitsiId) {
  return activePatterns.has(jitsiId) ? activePatterns.get(jitsiId) : null;
}

export function subscribeSlotEvents(fn) {
  slotSubscribers.add(fn);
  return () => slotSubscribers.delete(fn);
}

// --- Optional audio buffer capture/replay -------------------------------------------
//
// True sample capture: the local performer's master Strudel output is
// recorded per cycle via MediaRecorder on a MediaStreamAudioDestinationNode
// and enqueued as { blob, bytes }; at slot-open the head take is decoded and
// replayed through the performer's chain. Off by default until it has
// cross-browser soak time — gating alone already realizes the slot
// semantics, capture adds the deliberate-delay material.

export let bufferReplayEnabled = false;
export function setBufferReplayEnabled(v) { bufferReplayEnabled = !!v; }

const captureTakes = new Map(); // token → { blob, bytes }
let recorder = null;

export function startLocalCapture(sourceNode, localToken) {
  if (!bufferReplayEnabled || recorder || typeof MediaRecorder === 'undefined') return;
  const ctx = getAudioContext();
  if (!ctx || !sourceNode) return;
  const dest = ctx.createMediaStreamDestination();
  sourceNode.connect(dest);
  const chunks = [];
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    if (chunks.length) {
      const blob = new Blob(chunks.splice(0), { type: 'audio/webm' });
      captureTakes.set(localToken, { blob, bytes: blob.size });
    }
    if (recorder === rec) { try { rec.start(); } catch (e) {} }
  };
  rec.start();
  recorder = rec;
  // Cut a take at each cycle boundary so every enqueue carries fresh audio.
  subscribeSlotEvents((ev) => {
    if (ev.type === 'cycle-start' && recorder === rec && rec.state === 'recording') {
      try { rec.stop(); } catch (e) {}
    }
  });
}

async function replayCapturedAudio(jitsiId, take, ev) {
  const ctx = getAudioContext();
  if (!ctx || !take || !take.blob) return;
  try {
    const buf = await take.blob.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(buf);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    await attachNodeToChain(jitsiId, src, 'nc-replay');
    const atAudio = clock && clock.isSynced() ? Math.max(clock.toAudioTime(ev.t), ctx.currentTime) : ctx.currentTime;
    src.start(atAudio);
    src.stop(atAudio + ev.dur);
  } catch (e) {
    console.warn('[metaprogrammer] replay failed', e);
  }
}

// --- Epoch agreement -----------------------------------------------------------------

function broadcastEpoch() {
  if (o2 && epoch != null) o2.send(EPOCH_ADDR, ',t', [epoch]);
}

function adoptEpochIfEarlier(remoteEpoch) {
  if (epoch != null && remoteEpoch >= epoch - 0.05) return;
  epoch = remoteEpoch;
  if (scheduler) {
    scheduler.stop();
    startScheduler();
  }
}

function startScheduler() {
  scheduler = new MetaprogramScheduler({
    now: () => (clock && clock.isSynced() ? clock.toNetworkTime(localSeconds()) : localSeconds()),
    onEvent: onSchedulerEvent
  });
  pushProgramToScheduler();
  scheduler.setMetrics(computeWorstCaseMetrics(getAllPeers()));
  scheduler.start(epoch);
}

// --- Lifecycle ----------------------------------------------------------------------

export function isNetCyclesActive() { return active; }

export async function setNetCyclesActive(enable) {
  if (enable === active) return;
  active = !!enable;
  if (active) {
    const room = getRoomNameFromUrl() || 'default';
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!o2) {
      o2 = new O2LiteClient({ url: `${proto}//${loc.host}/o2?room=${encodeURIComponent(room)}` });
      o2.method(EPOCH_ADDR, (msg) => adoptEpochIfEarlier(msg.args[0]));
      clock = makeClockSyncOverO2(o2, localSeconds);
    }
    try { await o2.connect(); } catch (e) { console.warn('[metaprogrammer] O2 connect failed (running unsynced)', e); }
    clock.start();
    regenerateOrPatchProgram();
    // Give /nc/epoch a beat to arrive before declaring our own.
    await new Promise(r => setTimeout(r, 500));
    if (epoch == null) {
      const nowNet = clock.isSynced() ? clock.toNetworkTime(localSeconds()) : localSeconds();
      epoch = Math.ceil(nowNet);
    }
    startScheduler();
    broadcastEpoch();
    if (!epochTimer) epochTimer = setInterval(broadcastEpoch, EPOCH_REBROADCAST_MS);
    // Everyone starts gated closed until their first slot.
    for (const p of getAllPeers()) {
      if (p.jitsiId) { gateLevels.set(p.jitsiId, 0); setChainGate(p.jitsiId, 0); }
    }
  } else {
    if (scheduler) { scheduler.stop(); scheduler = null; }
    if (clock) clock.stop();
    if (epochTimer) { clearInterval(epochTimer); epochTimer = null; }
    epoch = null;
    for (const t of slotTimers) clearTimeout(t);
    slotTimers.clear();
    gateLevels.clear();
    activePatterns.clear();
    queues.clear();
    pendingEditorUpdates.clear();
    resetChainGates();
  }
  document.dispatchEvent(new CustomEvent('trussal-netcycles-mode', { detail: { active } }));
}

// --- Peer-state wiring ---------------------------------------------------------------

const knownTokens = new Set();
subscribePeerState((event, peer) => {
  if (!peer) return;
  if (event === 'peer-upsert') {
    if (peer.roomIndex != null) {
      const token = String(peer.roomIndex);
      if (!knownTokens.has(token)) {
        knownTokens.add(token);
        if (active) regenerateOrPatchProgram();
      }
      // Editor updates ride the next cycle-interval buffer.
      if (typeof peer.pattern === 'string' && peer.pattern &&
          peer.pattern !== activePatterns.get(peer.jitsiId)) {
        pendingEditorUpdates.set(token, peer.pattern);
      }
    }
    if (active && scheduler) scheduler.setMetrics(computeWorstCaseMetrics(getAllPeers()));
  } else if (event === 'peer-leave') {
    if (peer.roomIndex != null) {
      const token = String(peer.roomIndex);
      knownTokens.delete(token);
      queues.delete(token);
      pendingEditorUpdates.delete(token);
      if (peer.jitsiId) { activePatterns.delete(peer.jitsiId); gateLevels.delete(peer.jitsiId); }
      if (active) regenerateOrPatchProgram();
    }
  }
});
