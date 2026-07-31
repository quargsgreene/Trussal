// Metaprogrammer — the Net Cycles eval driver (browser side).
//
// The shared metaprogram is ALWAYS IN FORCE — there is no on/off button. Its
// one live capability today is ORDERING when/which participants play: the
// program text syncs over the CRDT doc to the aggregator bot, whose ring
// adopts the $ participants membership and written order while keeping the
// fixed 4s rotation interval (bots/src/bot/aggregator-bot.js). Typing only
// syncs the shared TEXT; the ring (and programText here) adopt a program
// solely on an explicit apply (▶ Apply / Ctrl+Enter / /nc/apply), the
// one-time roster seed, or a late joiner's catch-up. The room
// starts under the default program — `$ participants <0>`, the first
// participant to join streaming continuously — seeded into the shared doc
// once by the roster leader. Membership is edits-only from there: a newcomer
// stays silent until someone adds their token, and a leaver stays listed
// (their held audio keeps streaming through the aggregator as a ghost) until
// someone drops it.
//
// Everything below that gates/transforms audio in THIS browser is a further
// transformational capability being brought up one at a time (to keep
// confounding variables out of testing the live one), so it stays dormant:
// setNetCyclesActive(true) arms it, and no UI currently calls it. When armed,
// this module parses edits and drives the pure MetaprogramScheduler with
// ClockSync network time. Scheduler slot events become:
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
  buildDefaultProgram
} from './MetaprogrammerParser.js';
import { MetaprogramScheduler, AVBufferQueue } from './MetaprogramScheduler.js';
import { computeWorstCaseMetrics, mergeInducedMetrics, INDUCTIONS } from './network-modulation/WorstCaseCalculationUtils.js';
import { makeClockSyncOverO2 } from './ClockSync.js';
import { O2LiteClient } from '../../public/lib/o2lite-web.js';
import { createMetaprogramDoc, connectMetaprogramSync } from './MetaprogrammerCrdtSync.js';
import { subscribePeerState, getAllPeers, getLocalPeer, sendCrdtUpdate } from '../peer-state.js';
import { getRoomNameFromUrl } from '../jamulus.js';
import {
  getAudioContext,
  setChainGate,
  resetChainGates,
  attachNodeToChain,
  insertMasterChain,
  removeMasterChain
} from '../latency-instrument.js';
import { EffectsChainManager } from './av-effects/index.js';

const EPOCH_ADDR = '/nc/epoch';
const APPLY_ADDR = '/nc/apply';
const EPOCH_REBROADCAST_MS = 10000;
const QUEUE_LIMITS = { maxBuffers: 8, maxBytes: 32 * 1024 * 1024 };

let active = false;
let programText = null;      // current program source (CRDT doc in Phase 6)
let scheduler = null;
let effects = null;
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

function emitSlot(event) {
  slotSubscribers.forEach(fn => {
    try { fn(event); } catch (e) { console.warn('[metaprogrammer] slot subscriber threw', e); }
  });
}

// --- Shared doc ------------------------------------------------------------------

let crdt = null;

// The metaprogram doc lives for the whole meeting so edits are shared even
// before Net Cycles playback is switched on.
export function ensureMetaprogramSync() {
  if (crdt) return crdt;
  const handle = createMetaprogramDoc();
  crdt = connectMetaprogramSync(handle, {
    subscribe: subscribePeerState,
    sendUpdate: sendCrdtUpdate
  });
  crdt.onRemoteChange((text, payload) => {
    // Typing elsewhere syncs the shared TEXT only. The RUNNING program
    // (programText, what shortcuts/armed schedulers baseline against) moves
    // only on an explicit apply, the roster seed, or the late-join catch-up.
    const applied = !!payload && (payload.catchUp === true ||
      payload.modality === 'apply' || payload.modality === 'roster');
    if (applied) programText = text;
    document.dispatchEvent(new CustomEvent('trussal-netcycles-program', { detail: { text, remote: true, applied } }));
  });
  // Induced network conditions (and VLAN changes) alter the effective WC
  // metrics on every client identically — schedulers and effects follow at
  // the next boundary.
  crdt.onModulationChange(() => pushEffectiveMetrics());
  crdt.onVlansChange(() => pushEffectiveMetrics());
  return crdt;
}

// Effective worst-case metrics: measured roster metrics with the shared
// induced floors layered on (upward-only).
export function effectiveWorstCase() {
  const measured = computeWorstCaseMetrics(getAllPeers());
  return crdt ? mergeInducedMetrics(measured, crdt.getInduced()) : measured;
}

function pushEffectiveMetrics() {
  if (!active) return;
  const wc = effectiveWorstCase();
  if (scheduler) scheduler.setMetrics(wc);
  if (effects) effects.updateMetrics(wc);
}

// Slider API for the studio (and permitted bots): induce an upward-only
// floor under one metric. Values are shared via CRDT (channel 'modulation').
export function setInducedMetric(key, value) {
  if (!INDUCTIONS[key]) return false;
  ensureMetaprogramSync().setInduced(key, INDUCTIONS[key].clamp(value));
  pushEffectiveMetrics();
  return true;
}

export function getInducedMetrics() {
  return crdt ? crdt.getInduced() : {};
}

// VLAN grouping: place peers into an additional named VLAN with its own
// local induced conditions. All VLANs mix down to the single master bus;
// the default is one mutual VLAN (no entries).
export function setVlan(name, { members = [], induced = {} } = {}) {
  if (!name) return false;
  ensureMetaprogramSync().setVlan(name, { members: members.map(String), induced });
  pushEffectiveMetrics();
  return true;
}

export function removeVlan(name) {
  if (crdt) crdt.setVlan(name, null);
  pushEffectiveMetrics();
}

export function getVlans() {
  return crdt ? crdt.getVlans() : {};
}

// The default-program seed must come from exactly one client or concurrent
// CRDT inserts duplicate it. The leader is the lowest-indexed human present.
function isRosterEditLeader() {
  const me = getLocalPeer();
  if (me.isBot || me.roomIndex == null) return false;
  const humanIndices = getAllPeers()
    .filter(p => !p.isBot && p.roomIndex != null && /^\d+$/.test(String(p.roomIndex)))
    .map(p => parseInt(p.roomIndex, 10));
  if (!humanIndices.length) return false;
  return parseInt(me.roomIndex, 10) === Math.min(...humanIndices);
}

// --- Program text maintenance --------------------------------------------------

// Seed the room's default program — participant 0 streaming continuously —
// exactly once: only when the shared doc is still empty (nothing typed or
// applied anywhere) and only from the leader, so concurrent joins can't
// double-seed. Membership never auto-follows the roster after this: a
// newcomer stays unlisted (silent) until an edit adds them, and a leaver
// stays listed as a ghost until an edit drops them.
function maybeSeedDefaultProgram() {
  const sync = ensureMetaprogramSync();
  const docText = sync.getText();
  if (docText && docText.trim()) return;
  if (programText != null && programText.trim()) return;
  if (!isRosterEditLeader()) return;
  programText = buildDefaultProgram();
  sync.setText(programText, 'roster');
  pushProgramToScheduler();
  document.dispatchEvent(new CustomEvent('trussal-netcycles-program', { detail: { text: programText } }));
}

// The CircularParticipantQueue lives in the aggregator bot's own process; the
// bot's #pushProgramToScheduler (bots/src/bot/aggregator-bot.js) receives the
// same program over CRDT//nc/apply and pushes the ordering into the queue there.
function pushProgramToScheduler() {
  if (programText == null) return;
  const { ast, valid } = parseMetaprogram(programText);
  if (!valid) return;
  if (scheduler) scheduler.setProgram(ast);
  // The program's #-chain drives the Effects Service on the master bus.
  if (effects) effects.setChain(ast.chain, effectiveWorstCase());
}

// Explicit apply from the editor. Valid text lands in the shared doc, in the
// local scheduler (next boundary), and — via /nc/apply — in everyone else's
// scheduler. Returns parse errors for squiggles.
export function applyProgramText(text, { broadcast = true } = {}) {
  const { errors, valid } = parseMetaprogram(text);
  if (valid) {
    programText = text;
    if (crdt) {
      // Typing usually synced this exact text already, making the diff empty
      // — broadcast the apply signal anyway so every receiver (aggregator
      // included) runs the program now.
      const changed = crdt.setText(text, 'apply');
      if (!changed) crdt.broadcastApplied();
    }
    pushProgramToScheduler();
    if (broadcast && o2) o2.send(APPLY_ADDR, ',s', [text]);
    document.dispatchEvent(new CustomEvent('trussal-netcycles-program', { detail: { text, applied: true } }));
  }
  return errors;
}

export function getProgramText() { return programText; }

// Studio effect toggles double as metaprogram shortcuts under Net Cycles:
// toggling adds/removes the corresponding # line and applies it, so the
// buttons and the shared editor never disagree.
const SHORTCUT_LINES = { room: '# room wcl 2', echo: '# echo 1 0.1', crush: '# crush 1', noise: '# noise' };

export function hasEffectShortcut(fn) {
  if (!programText) return false;
  return new RegExp(`^#\\s*${fn}\\b`, 'm').test(programText);
}

export function toggleEffectShortcut(fn) {
  if (!SHORTCUT_LINES[fn]) return false;
  let text = programText ?? buildDefaultProgram();
  const lineRe = new RegExp(`^#\\s*${fn}\\b[^\\n]*\\n?`, 'm');
  if (lineRe.test(text)) text = text.replace(lineRe, '');
  else text = `${text.trimEnd()}\n${SHORTCUT_LINES[fn]}\n`;
  return applyProgramText(text).length === 0;
}

// --- Queues ---------------------------------------------------------------------

function queueFor(token) {
  // DO NOT use this function
  let q = queues.get(token);
  //AVBuffer
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
// The $ participants token-order hookup to the CircularParticipantQueue lives in
// the aggregator bot (bots/src/bot/aggregator-bot.js #onSchedulerEvent), which
// runs its own scheduler over the same shared program — not in this browser-side
// handler, whose job stays gating the local Strudel voices and chains.
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
  scheduler.setMetrics(effectiveWorstCase());
  scheduler.start(epoch);
}

// --- Lifecycle ----------------------------------------------------------------------

export function isNetCyclesActive() { return active; }

// Arms the DORMANT browser-side slot machinery: local gates, the effects
// chain, buffer-queue pattern delay, and this browser's own scheduler. No UI
// calls this today — the metaprogram's live capability is participant
// ordering, which flows through the shared doc to the aggregator regardless
// of `active`. Kept intact (both directions) so each further transformational
// capability can be switched on and verified one at a time.
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
      o2.method(APPLY_ADDR, (msg) => applyProgramText(msg.args[0], { broadcast: false }));
      clock = makeClockSyncOverO2(o2, localSeconds);
    }
    ensureMetaprogramSync();
    try { await o2.connect(); } catch (e) { console.warn('[metaprogrammer] O2 connect failed (running unsynced)', e); }
    clock.start();
    effects = new EffectsChainManager({
      audioCtx: getAudioContext(),
      insert: insertMasterChain,
      remove: removeMasterChain,
      getPeers: getAllPeers,
      getLocalJitsiId: () => getLocalPeer().jitsiId
    });
    // Give /nc/epoch — and the CRDT catch-up carrying any existing program —
    // a beat to arrive before declaring our own epoch / seeding the default.
    await new Promise(r => setTimeout(r, 500));
    if (epoch == null) {
      const nowNet = clock.isSynced() ? clock.toNetworkTime(localSeconds()) : localSeconds();
      epoch = Math.ceil(nowNet);
    }
    maybeSeedDefaultProgram();
    startScheduler();
    broadcastEpoch();
    if (!epochTimer) epochTimer = setInterval(broadcastEpoch, EPOCH_REBROADCAST_MS);
    // Everyone starts gated closed until their first slot.
    for (const p of getAllPeers()) {
      if (p.jitsiId) { gateLevels.set(p.jitsiId, 0); setChainGate(p.jitsiId, 0); }
    }
  } else {
    if (scheduler) { scheduler.stop(); scheduler = null; }
    if (effects) { effects.dispose(); effects = null; }
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

// Joins and leaves never touch the program text: a newcomer's token is simply
// unlisted (they wait silent) and a leaver's token stays listed (their ghost
// keeps streaming through the aggregator) until someone edits the program.
// The upsert hook retries the one-time default seed — the leader's room index
// arrives here as a peer-upsert, whenever the sidecar assigns it.
subscribePeerState((event, peer) => {
  if (!peer) return;
  if (event === 'peer-upsert') {
    if (peer.roomIndex != null) {
      const token = String(peer.roomIndex);
      // Editor updates ride the next cycle-interval buffer.
      if (typeof peer.pattern === 'string' && peer.pattern &&
          peer.pattern !== activePatterns.get(peer.jitsiId)) {
        pendingEditorUpdates.set(token, peer.pattern);
      }
    }
    maybeSeedDefaultProgram();
    if (active) {
      pushEffectiveMetrics();
    }
  } else if (event === 'peer-leave') {
    if (peer.roomIndex != null) {
      const token = String(peer.roomIndex);
      queues.delete(token);
      pendingEditorUpdates.delete(token);
      if (peer.jitsiId) { activePatterns.delete(peer.jitsiId); gateLevels.delete(peer.jitsiId); }
    }
  }
});
