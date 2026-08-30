// Metaprogrammer — the Net Cycles eval driver (browser side).
//
// The shared metaprogram is ALWAYS IN FORCE — there is no on/off button. Its
// live capabilities today are ORDERING and TIMING: the program text syncs over
// the CRDT doc to the aggregator bot, whose ring adopts the $ participants
// membership and written order, and whose rotation is paced by that program's
// scheduler slot grid — so a turn lasts the cycle length `# cycles` derives
// from the live worst-case metrics (bots/src/bot/aggregator-bot.js). Typing only
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
import { MetaprogramScheduler, AVBufferQueue, beatSeconds, cycleLength } from './MetaprogramScheduler.js';
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
// How far in the past a remote /nc/epoch may sit and still be believable as
// the same clock we are reading; beyond this it is another timebase.
const EPOCH_PLAUSIBLE_PAST_S = 24 * 60 * 60;
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
// The last cycle-start the scheduler EMITTED — the cycle currently playing,
// which is what patterned effect arguments sample at.
let cycleGrid = null;        // { cycle, t, seconds }
let currentAst = null;       // last program that parsed clean

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
// Whether this session's crdt-state catch-up (the sidecar's full history for
// the room, sent unconditionally right after roster — see server.js) has
// landed yet. Until it has, maybeSeedDefaultProgram() must not write: a
// peer-upsert fires synchronously off the 'roster' message, which the
// sidecar sends BEFORE crdt-state, so without this gate a client that is
// briefly its own roster leader can seed a default program into its still-
// empty local Y.Doc a moment before the real history merges in — two
// causally-unrelated inserts at the same position, which Yjs concatenates
// rather than overwrites, leaving two `# cycles` lines and a parse error.
let caughtUp = false;

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
    if (applied) {
      programText = text;
      // currentAst (and everything derived from it — the Effects Service
      // chain driving text/css's network-modulated degradation, the local
      // dormant scheduler) used to move only
      // when THIS browser's own applyProgramText() ran it through here —
      // meaning any OTHER peer applying a program left every other viewer's
      // currentAst stale (often still null) until they happened to apply one
      // themselves. Re-parsing on every remote apply too keeps it in sync
      // with whatever the room is actually running, regardless of who
      // pressed Apply. Skip an empty catch-up/roster text exactly as
      // applyProgramText's own `valid` guard would — maybeSeedDefaultProgram
      // (below) is what seeds a genuinely empty doc, and parsing '' here
      // first would just log a spurious refusal ahead of that.
      if (text && text.trim()) pushProgramToScheduler();
    }
    if (payload && payload.catchUp === true) {
      caughtUp = true;
      // The seed check that ran (or was skipped) off the roster's own
      // peer-upsert already happened before this landed — retry now that
      // it's safe to tell an empty doc from one that just hasn't caught up.
      maybeSeedDefaultProgram();
    }
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

// Where the room is on its cycle grid, for effects written in cycles rather
// than seconds (`# echo` delay length) or sampled per cycle (patterned effect
// arguments). Position is deliberately UNCLAMPED arithmetic off the last
// boundary: cycle-start events are emitted a lookahead early, so between the
// event and the boundary the fraction is negative and the position correctly
// still names the previous cycle — no dual-anchor bookkeeping needed, as long
// as consumers floor-mod (ValuePattern.js does).
//
// Before the first boundary there is no anchor: compute the length the grid is
// about to use — from the running scheduler if there is one, otherwise from
// the program itself, since setChain runs during the roster seed while
// `scheduler` is still null. It has to be a CYCLE length either way; a beat is
// not a cycle (cycleLength quantizes the timing metric UP onto whole beats),
// and reporting one would size the first echo against a fabricated 0.5 s.
// Every client derives this from the same shared epoch and metrics, so
// patterned parameters stay identical across browsers.
function cycleContext() {
  if (cycleGrid && cycleGrid.seconds > 0) {
    return {
      cycleSeconds: cycleGrid.seconds,
      cyclePos: cycleGrid.cycle + (networkSeconds() - cycleGrid.t) / cycleGrid.seconds
    };
  }
  const len = scheduler
    ? scheduler.getCycleLength()
    : (currentAst && cycleLength({ cycles: currentAst.cycles, tempo: currentAst.tempo, metrics: effectiveWorstCase() }));
  return { cycleSeconds: len ? len.seconds : beatSeconds(null), cyclePos: 0 };
}

function pushEffectiveMetrics() {
  if (!active) return;
  const wc = effectiveWorstCase();
  if (scheduler) scheduler.setMetrics(wc);
  if (effects) effects.updateMetrics(wc);
}

// Induce an upward-only floor under one metric; values are shared via CRDT
// (channel 'modulation'), so every client computes the same effective
// worst-case. Dormant: the studio's induction sliders were removed and
// nothing calls this yet, but effectiveWorstCase() still merges whatever
// lands in the channel, so a future control surface needs no plumbing.
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
  // Establish the doc (and its crdt-state subscription) unconditionally and
  // FIRST: this runs synchronously off the very first peer-upsert, which
  // fires while handling the sidecar's 'roster' message — the message
  // immediately before 'crdt-state' on the same socket. Bailing out early
  // when !caughtUp without calling ensureMetaprogramSync() would mean, on a
  // session where nothing else has called it yet, that no listener exists
  // when 'crdt-state' arrives moments later — the bus has no replay buffer
  // (peer-state.js's emit is fire-and-forget), so that one-shot catch-up is
  // lost forever, caughtUp never flips true, and the room's real history (or
  // the default seed) never lands: an empty, permanently-unseeded doc.
  const sync = ensureMetaprogramSync();
  if (!caughtUp) return; // don't know yet whether real history is still in flight
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
  const { ast, errors, valid } = parseMetaprogram(programText);
  if (!valid) {
    // programText only ever holds APPLIED text, so invalid here is not a
    // half-typed line — it is a program the room is running that this client
    // cannot parse (a peer on an older bundle, or a directive whose syntax
    // changed under a saved doc). The whole program is refused, `$
    // participants` included, and the last valid one stays in force; say so
    // rather than leaving the room's ordering silently frozen.
    console.error('[metaprogrammer] refused an applied program this client cannot parse — ' +
      'still running the previous one', errors, programText);
    return;
  }
  currentAst = ast;
  if (scheduler) scheduler.setProgram(ast);
  // The program's #-chain drives this browser's Effects Service, which today
  // computes only the Hydra counterparts — every audio node it knows about
  // runs on the aggregator's master bus instead (av-effects/index.js).
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

// Tell every other HUMAN peer running the shared metaprogram to silence
// their local ensemble the same way this browser's ■ Stop does. Does NOT
// reach bots — a bot's page never mounts components/MetaprogrammerEditor.js
// (nothing ever opens the Studio overlay there), and its actual audio is a
// separate standalone @strudel/repl instance this signal couldn't touch
// anyway; see stopAllBots (UserBotOrchestration.js) for that path. Leaves
// programText/the CRDT text untouched, so a later Apply resumes exactly what
// was running. Local silencing is the caller's job (see
// components/MetaprogrammerEditor.js, which also owns stopStrudel() and
// would create an import cycle if that call lived here instead).
export function broadcastStopSignal() {
  ensureMetaprogramSync().broadcastStop();
}

// Studio effect toggles double as metaprogram shortcuts under Net Cycles:
// toggling adds/removes the corresponding # line and applies it, so the
// buttons and the shared editor never disagree.
const SHORTCUT_LINES = { room: '# room wcl 2', echo: '# echo', crush: '# crush wcl 1', noise: '# noise' };

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
    const lengthChanged = !cycleGrid || cycleGrid.seconds !== ev.seconds;
    cycleGrid = { cycle: ev.cycle, t: ev.t, seconds: ev.seconds };
    // A boundary is the only moment the cycle LENGTH can change, and the
    // scheduler applies pending metrics here rather than when they arrived —
    // so an echo written in cycles has to be re-derived now. Nothing else
    // would: pushEffectiveMetrics ran before the swap, with the old length.
    if (lengthChanged && effects) effects.updateMetrics(effectiveWorstCase());
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

// Network time on the clock the scheduler stamps its events with: ClockSync's
// reference once converged, this browser's AudioContext clock until then.
function networkSeconds() {
  return clock && clock.isSynced() ? clock.toNetworkTime(localSeconds()) : localSeconds();
}

// Only publish an epoch we actually quoted from the SYNCED clock. An epoch
// read off the local AudioContext names an instant on this tab's own timeline
// (seconds since the context opened), and every other client — the aggregator
// especially, whose grid it can capture via adoptEpochIfEarlier — would anchor
// its cycle grid at a moment its own clock never reaches. Silence, not drift.
function broadcastEpoch() {
  if (!o2 || epoch == null) return;
  if (!(clock && clock.isSynced())) return;
  o2.send(EPOCH_ADDR, ',t', [epoch]);
}

// Symmetrically: only adopt a remote epoch while synced, and only one that
// could plausibly sit on our own timeline. "Earlier" is otherwise
// indistinguishable from "measured against a different clock".
function adoptEpochIfEarlier(remoteEpoch) {
  if (!Number.isFinite(remoteEpoch)) return;
  if (epoch != null && remoteEpoch >= epoch - 0.05) return;
  const now = networkSeconds();
  if (!(clock && clock.isSynced()) || remoteEpoch > now || (now - remoteEpoch) > EPOCH_PLAUSIBLE_PAST_S) {
    console.warn(`[metaprogrammer] refused /nc/epoch ${remoteEpoch} (local now ${now})`);
    return;
  }
  epoch = remoteEpoch;
  if (scheduler) {
    scheduler.stop();
    startScheduler();
  }
}

function startScheduler() {
  // A fresh grid counts from cycle 0 again — an anchor from the old one would
  // place cycle-position sampling in a cycle that no longer exists.
  cycleGrid = null;
  scheduler = new MetaprogramScheduler({
    now: networkSeconds,
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
      getLocalJitsiId: () => getLocalPeer().jitsiId,
      // Patterned effect arguments (`# crush wcl <2 4>`, `# noise wcl <20 10>`)
      // are read off the same grid the slots run on, so a value turns over on a
      // turn boundary rather than on a clock of its own; `# echo` reads the
      // cycle LENGTH off it too, its delay being written in cycles.
      //
      // cycleContext derives its position from the last cycle-start the
      // scheduler EMITTED, not from scheduler.getCycle() — the scheduler
      // increments past the cycle it just announced (and emits a lookahead
      // ahead of real time), so getCycle() names the next one and would put
      // this browser's visual an element ahead of the aggregator's audio. The
      // aggregator tracks the same event the same way (#onSchedulerEvent).
      getCycleContext: cycleContext
    });
    // Give /nc/epoch — and the CRDT catch-up carrying any existing program —
    // a beat to arrive before declaring our own epoch / seeding the default.
    await new Promise(r => setTimeout(r, 500));
    if (epoch == null) {
      epoch = Math.ceil(networkSeconds());
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
    cycleGrid = null; // the next arming starts a fresh grid at cycle 0
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
