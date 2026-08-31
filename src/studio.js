// Unified Trussal Studio UI.
//
// One toggleable overlay surfaces a participant strip + a detail panel split
// into a Latency Effects card and a Strudel card. Every participant gets a
// chip with effect indicators, play state, and an "audio routed" dot — making
// it obvious that each person owns their own chain and editor.

import studioStyles from './studio.css';
import { getRoomNameFromUrl } from './jamulus.js';
import {
  subscribeParticipants,
  getLocalParticipant
} from './participants.js';
import {
  subscribePeerState,
  getAllPeers,
  getPeerByJitsiId,
  getLocalPeer,
  sendLocalPattern,
  sendLocalPlaying,
  sendRemotePattern,
  sendRemoteMute,
  sendLocalNetStats,
  sendLocalDataPacks,
} from './peer-state.js';
import { bootStrudelOnUserGesture, stopStrudel, refreshLocalSamples, rebakeStrudel, DEFAULT_PATTERN, updateSliderValue } from './strudel.js';
import {
  uploadSamplesToDB, getSampleBanks, clearSamplesDB, deleteSample, getDataPacks,
} from './user-samples.js';
import { injectFacialGestureToggle, refreshFacialGestureButtons } from './facial-gesture.js';
import { injectKeyboardToggle, tickKbdUi } from './on-screen-keyboard.js';
import { attachPanelControls } from './panel-drag-resize.js';
import { toggleLineComment } from './editor-router-core.js';
import { readDirective, ensureDirective } from './program-directive.js';
import { attachUndoHistory, resetUndoBaseline } from './editor-undo.js';
import {
  bootAudioEngine,
  subscribeAudioRouting,
  attachExternalStreamForPeer,
  detachExternalStreamForPeer,
  getExternalStreamLabel,
  getExternalNodeLabel,
  listAudioInputDevices,
  propagateExternalStreamToRoom,
  stopPropagatingExternalStream,
  isPropagatingToRoom,
  setJamulusMode,
  getAudioContext,
} from './latency-instrument.js';
import { startNetStatsPolling } from './audio-net/observability/NetStats.js';
import { startPipelineLatencyMeasurement } from './audio-net/observability/PipelineLatency.js';
import { effectiveWorstCase, getProgramText } from './audio-net/Metaprogrammer.js';
import { cycleLength, timingTargetSeconds } from './audio-net/MetaprogramScheduler.js';
import { PIPELINE_ALLOWANCE_MS } from './audio-net/network-modulation/WorstCaseCalculationUtils.js';
import { parseMetaprogram } from './audio-net/MetaprogrammerParser.js';
import { mountMetaprogrammerEditor } from '../components/MetaprogrammerEditor.js';
import { mountMetaprogrammerCycleHighlighter } from '../components/MetaprogrammerCycleHighlighter.js';
import {
  myClusterBots,
  spawnBots,
  removeBots,
  removeOneBot,
  muteBots,
  setBotsVideo,
  subscribeFleetStatus
} from './audio-net/UserBotOrchestration.js';
import { startRoomHealth } from './audio-net/RoomHealthService.js';

const BUTTON_ID  = 'trussal-studio-toggle';
const OVERLAY_ID = 'trussal-studio-overlay';
const STYLE_ID   = 'trussal-studio-style';
const STORAGE_KEY = 'trussal.studio.pattern';

let selectedJitsiId = null;
// The stable identity behind selectedJitsiId ('local', or a peer.peerId) —
// jitsiId is what selection is KEYED by (it's what a chip's click handler
// has on hand), but it isn't stable: a P2P<->JVB renegotiation re-keys it
// for any participant. selectedPeerKey is what renderDetail's fallback
// recovers the CORRECT selection with when that happens, instead of
// silently snapping to the local peer. Kept in sync with selectedJitsiId
// everywhere the latter is assigned.
let selectedPeerKey = null;
let initedRoom = null;
let codeDebounce = null;
let lastStatus = 'Idle';
let routedSet = new Set();
// [{name, kind, count, samples}] — audio banks and data packs alike, kept in
// sync after every load/delete.
let sampleBanks = [];
let expandedBank = null; // which bank's per-sample list is open, if any
let currentSliders = []; // most recent slider configs from strudel eval
// Overlay height stashed while collapsed (strip + detail hidden), restored on
// expand — so a resized panel doesn't leave a tall empty shell when collapsed.
let savedStudioHeight = '';
// True while a native file picker opened by wireUpload is on screen, or while
// the files it returned are still being read. renderAll() skips rebuilding
// the detail shell during this window — see the guard there for why.
let uploadPending = false;

async function refreshSampleBanks() {
  sampleBanks = await getSampleBanks().catch(() => []);
  // Data packs must reach every other browser and the aggregator, or a
  // "Weather:3" in our code would resolve to nothing on their side and the
  // room would hear a different program than we do.
  sendLocalDataPacks(await getDataPacks().catch(() => []));
  renderAll();
}

function isInMeeting() {
  const body = document.body;
  if (!body) return false;
  try {
    const conf = window.APP && window.APP.conference;
    if (conf) {
      if (typeof conf.isJoined === 'function') return !!conf.isJoined();
      if (conf._room && typeof conf._room.isJoined === 'function') return !!conf._room.isJoined();
    }
  } catch (e) { /* fall through */ }
  if (body.classList.contains('welcome-page')) return false;
  if (document.querySelector('.prejoin-screen, .premeeting-screen, [class*="premeeting"], [class*="prejoin"]')) return false;
  if (document.getElementById('trussal-welcome-overlay')) return false;
  const largeVideo = document.getElementById('largeVideoContainer');
  if (!largeVideo) return false;
  const rect = largeVideo.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function hueFor(jitsiId) {
  if (!jitsiId) return 140;
  let h = 0;
  for (let i = 0; i < jitsiId.length; i++) h = (h * 31 + jitsiId.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initial(name) {
  if (!name) return '?';
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

// Keeps `container`'s children in sync with `items` without recreating a node
// for any item whose key is still present. A full teardown-and-rebuild (the
// previous design here) needed a click's mousedown and mouseup to land on the
// SAME node, dropped a focused input's cursor whenever its node got replaced,
// and reset a container's scroll position on every replacement — all because
// nothing survived the rebuild except by value. Reconciling by key means an
// unrelated data refresh never touches a node the user is mid-gesture with.
//
// keyFn(item) must return a stable identity for that item. createFn(item)
// builds a fresh node and binds ITS OWN listeners once, reading current values
// off the node's dataset/DOM at call time rather than closing over `item` (a
// later update replaces the node's content, not the node, so a closure over
// the original item would go stale). updateFn(node, item) patches an existing
// (or just-created) node's live-changing content in place.
function reconcileList(container, items, keyFn, createFn, updateFn) {
  const existing = new Map();
  for (const child of Array.from(container.children)) {
    const key = child.dataset ? child.dataset.reconcileKey : undefined;
    if (key != null) existing.set(key, child);
  }
  let prevNode = null;
  for (const item of items) {
    const key = String(keyFn(item));
    let node = existing.get(key);
    if (node) {
      existing.delete(key);
    } else {
      node = createFn(item);
      node.dataset.reconcileKey = key;
    }
    updateFn(node, item);
    const wantSibling = prevNode ? prevNode.nextSibling : container.firstChild;
    if (wantSibling !== node) container.insertBefore(node, wantSibling);
    prevNode = node;
  }
  for (const node of existing.values()) node.remove();
}

// Styles live in studio.css (imported as raw text — see build.mjs's '.css':
// 'text' loader) rather than a template literal here. #trussal-studio-overlay
// and #trussal-studio-toggle in that file are OVERLAY_ID/BUTTON_ID hardcoded
// as literal strings; keep them in sync if either constant is ever renamed.
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = studioStyles;
  document.head.appendChild(style);
}

function chipColor(jitsiId, isLocal) {
  return isLocal ? '#1ff466' : `hsl(${hueFor(jitsiId)}, 60%, 60%)`;
}

// The stable id (see selectedPeerKey) a chip's click hands to the selection.
function chipKey(peer) {
  return peer.isLocal ? 'local' : String(peer.peerId || peer.jitsiId || '');
}

function createChip() {
  const el = document.createElement('button');
  el.className = 'ts-chip';
  el.innerHTML = `
    <div class="ts-chip-row">
      <div class="ts-avatar"></div>
      <div class="ts-name"></div>
      <span class="ts-idx" title="JPattern room index"></span>
    </div>
  `;
  el.addEventListener('click', () => {
    const jid = el.dataset.jid;
    if (!jid) return;
    selectedJitsiId = jid;
    selectedPeerKey = el.dataset.peerKey || null;
    renderAll();
  });
  return el;
}

function updateChip(el, peer) {
  const isLocal = !!peer.isLocal;
  el.dataset.jid = peer.jitsiId || '';
  el.dataset.peerKey = chipKey(peer);
  el.style.setProperty('--ts-chip-color', chipColor(peer.jitsiId, isLocal));
  el.classList.toggle('selected', peer.jitsiId === selectedJitsiId);
  el.querySelector('.ts-avatar').textContent = initial(peer.displayName);
  const name = el.querySelector('.ts-name');
  name.textContent = isLocal ? 'You' : (peer.displayName || 'Participant');
  name.classList.toggle('you', isLocal);
  el.querySelector('.ts-idx').textContent = peer.roomIndex != null ? String(peer.roomIndex) : '·';
}

function renderStrip(container) {
  reconcileList(container, getAllPeers(), chipKey, createChip, updateChip);
}

function metricsLine(peer) {
  // preciseMs, not toFixed(0): these are the samples the WC readout directly
  // below is computed from, and at LAN scale a fixed 0-decimal render printed
  // a 0.4 ms RTT as "0ms" next to a WCL of "0.40ms" — the same number,
  // contradicting itself two lines apart. It coerces null to 0, so the
  // unmeasured guard stays.
  const ms = (v) => (typeof v === 'number' ? preciseMs(v) : '–');
  const rtt = ms(peer.rtt);
  const jitter = ms(peer.jitter);
  const rtcRtt = ms(peer.rtcRtt);
  const rtcJitter = ms(peer.rtcJitter);
  const loss = typeof peer.packetLoss === 'number' ? `${(peer.packetLoss * 100).toFixed(1)}%` : '–';
  const extLabel  = getExternalStreamLabel(peer.jitsiId) || getExternalNodeLabel(peer.jitsiId);
  const routed = routedSet.has(peer.jitsiId);
  const propagating = peer.isLocal && isPropagatingToRoom();
  let routedTxt;
  if (routed && extLabel) {
    routedTxt = `<b>routed</b> · ${escapeHtml(extLabel)}${propagating ? ' · <b>→ room</b>' : ''}`;
  } else if (routed) {
    routedTxt = '<b>routed</b>';
  } else if (peer.isLocal) {
    // Local Strudel audio bypasses the worklet chain (goes directly to master
    // gain), so it never lands in audioRouted. Show play state instead.
    routedTxt = peer.playing ? '<b>instrument ▶</b>' : 'not playing';
  } else {
    routedTxt = 'no live audio';
  }
  return `<div class="ts-meta" title="RTT and jitter are the WS ping/pong signalling leg to the sidecar; the media figures come from RTCStats on the audio path and are what WCL is built from">RTT <b>${rtt}</b> · media RTT <b>${rtcRtt}</b> · jitter <b>${jitter}</b> · media jitter <b>${rtcJitter}</b> · loss <b>${loss}</b> · ${routedTxt}</div>`;
}

// The one network panel: this peer's measured link and the room-wide
// worst-case basis every client shares (identical everywhere — it sets Net
// Cycles cycle lengths). `controls` is dropped into the header; the Jamulus
// capture buttons live there when re-enabled, since routing them is exactly
// what the peer line's `routed` state reports.
//
// effectiveWorstCase() layers the CRDT induced floors over the measured
// roster metrics, and carries measured's own `sampleCount` through the
// merge — so one call covers both and there is nothing to show twice.
// The turn length the running metaprogram's `# cycles` directive derives from
// `wc` — what the aggregator actually paces each performer's solo by. Shown
// next to the metrics that produce it so a WCL that moves without the turn
// following is visible in the UI, not only in the aggregator's log. Computed
// here rather than read off a scheduler because the browser-side scheduler is
// dormant (see setJPatternActive); this is the same pure calculation.
function cycleLengthReadout(wc) {
  const text = getProgramText();
  if (!text) return 'turn length: <b>&mdash;</b> <span title="no metaprogram running yet">(no program)</span>';
  const { ast, valid } = parseMetaprogram(text);
  if (!valid) return 'turn length: <b>&mdash;</b> <span title="the metaprogram has parse errors">(program invalid)</span>';
  const { seconds, beats, beatSeconds } = cycleLength({ cycles: ast.cycles, tempo: ast.tempo, metrics: wc });
  const targetS = timingTargetSeconds(ast.cycles, wc);
  const { metric, factor, fixed } = ast.cycles;
  // Spell the arithmetic out. On a LAN the driving metric is a fraction of a
  // millisecond and the scale factor is in the thousands, so "WCL 1ms" next to
  // a 10 s turn reads as a contradiction unless the multiplication is on screen.
  const source = fixed != null
    ? `pinned ${fixed}s`
    : `${metric.toUpperCase()} ${preciseMs(wc[metric] ?? 0)}`;
  return `turn length: <b>${seconds.toFixed(3)}s</b> ` +
    `<span class="ts-dim">= ${escapeHtml(source)} &times; ${factor} = ${targetS.toFixed(3)}s` +
    `, rounded up to ${beats} &times; ${beatSeconds.toFixed(3)}s beat</span>`;
}

// Milliseconds with enough precision to be believable at the scale these
// actually take. On a LAN every worst-case metric sits between 0 and a few ms,
// where rounding to whole milliseconds throws away exactly the variation that
// drives turn length: 1.0 ms and 1.4 ms both print as "1ms" but mean a 10 s and
// a 14 s turn under `# cycles wcl 10000`.
function preciseMs(v) {
  const n = Number(v) || 0;
  if (n >= 100) return `${n.toFixed(0)}ms`;
  if (n >= 10) return `${n.toFixed(1)}ms`;
  return `${n.toFixed(2)}ms`;
}

// Built once per peer selection; updateMetricsSection patches it on every
// peer-state tick (every ~2s per peer — the busiest data source in the whole
// panel) without touching anything outside .ts-metrics-body, so a metrics
// refresh can no longer disturb the bot cluster or the Strudel editor.
function createMetricsSection() {
  const el = document.createElement('div');
  el.className = 'ts-section ts-metrics-section';
  el.innerHTML = `
    <div class="ts-section-head">
      <div class="ts-section-title">Network Metrics</div>
      <div class="ts-section-controls">
        <span class="ts-metrics-controls"></span>
      </div>
    </div>
    <div class="ts-metrics-body"></div>
  `;
  return el;
}

// A throw here used to take the metrics, the bot cluster AND the Strudel
// editor down with it (one shared innerHTML assignment) — this has cost two
// live outages. Now that metrics own their own subtree, the try/catch only
// has to protect that subtree; nothing else in the panel can be affected.
function updateMetricsSection(el, peer, controls = '') {
  const controlsHost = el.querySelector('.ts-metrics-controls');
  if (controlsHost.innerHTML !== controls) controlsHost.innerHTML = controls;
  const body = el.querySelector('.ts-metrics-body');
  try {
    const wc = effectiveWorstCase();
    body.innerHTML = `
      ${metricsLine(peer)}
      <div class="ts-meta" title="WCL is worst-case one-way MOUTH-TO-EAR latency: both network legs + the measured de-jitter buffer + a fixed ${PIPELINE_ALLOWANCE_MS}ms encode/decode/device allowance">WCL <b>${preciseMs(wc.wcl)}</b> · WCPL <b>${(wc.wcpl * 100).toFixed(1)}%</b>
        <span title="peers contributing samples">(${wc.sampleCount})</span></div>
      <div class="ts-meta ts-dim">WCL = net ${preciseMs(Math.max(0, wc.wcl - (wc.wcjb || 0) - (wc.wcpipe ?? PIPELINE_ALLOWANCE_MS)))}
        + buffer ${preciseMs(wc.wcjb || 0)} + rig ${preciseMs(wc.wcpipe ?? PIPELINE_ALLOWANCE_MS)}
        <span title="worst value of each term across the room — an upper bound, so no real path exceeds it">(upper bound)</span>
        <span title="rigs that measured their own capture/codec/playout latency by loopback; the rest use the ${PIPELINE_ALLOWANCE_MS}ms fallback">${wc.pipelineMeasured ?? 0}/${wc.sampleCount} rigs measured</span></div>
      <div class="ts-meta">${cycleLengthReadout(wc)}</div>
    `;
  } catch (e) {
    console.error('[studio] network metrics block failed to render', e);
    body.innerHTML = `<div class="ts-meta">unavailable &mdash; ${escapeHtml(String((e && e.message) || e))}</div>`;
  }
}

let lastFleetStatus = '';
subscribeFleetStatus((status) => {
  if (status.action === 'spawn') {
    // `botConfig` is what the fleet made of the declaration in the code we sent
    // — "applied: harmony=…", "no botConfig() declared", or absent when it was
    // rejected (then `reason` says why). It is the only place an author can see
    // whether their declaration crossed three processes intact.
    lastFleetStatus = `spawned ${status.spawned}/${status.requested} for ${status.ownerIndex}` +
      (status.botConfig ? ` — ${status.botConfig}` : '') +
      (status.reason ? ` — ${status.reason}` : '');
  } else if (status.action === 'remove') {
    lastFleetStatus = `removed ${status.removed} (${status.ownerIndex})${status.reason ? ` — ${status.reason}` : ''}`;
  } else if (status.action === 'config-error') {
    // A botConfig() typo on a retroactive-or-not edit — see
    // fleet-service.js's #handlePerformerEdit. Without this the edit just
    // silently fails to apply, indistinguishable from "reverted".
    lastFleetStatus = `botConfig rejected (${status.ownerIndex}) — ${status.reason || 'invalid config'}`;
  } else if (status.action === 'teardown') {
    lastFleetStatus = `fleet teardown — ${status.reason || ''}`;
  }
  renderAll();
});

function botRowKey(bot) { return bot.roomIndex; }

function createBotRow() {
  const el = document.createElement('div');
  el.className = 'ts-fx';
  el.innerHTML = `
    <span class="ts-idx"></span>
    <span class="ts-bot-name" style="font-size:11px;color:#b9d1c1;"></span>
    <button class="ts-fx-btn ts-dwell-btn" data-bot-action="mute"></button>
    <button class="ts-fx-btn ts-dwell-btn" data-bot-action="video" title="publish this bot's Hydra output as its video tile">vid</button>
    <button class="ts-fx-btn ts-dwell-btn" data-bot-action="removeOne">×</button>
  `;
  // idx comes off the row's own reconcile key at click time, not a closed-over
  // `bot` — this node is reused across ticks, so a stale closure would still
  // read whatever roomIndex this bot happened to have when the row was first
  // created. myClusterBots() is re-queried fresh per click for the same reason.
  el.querySelectorAll('[data-bot-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.botAction;
      const idx = el.dataset.reconcileKey;
      if (action === 'removeOne') { removeOneBot(idx); return; }
      const bot = myClusterBots().find(b => b.roomIndex === idx);
      if (action === 'mute') muteBots([idx], !(bot && bot.muted));
      else if (action === 'video') setBotsVideo([idx], !(bot && bot.videoOn));
    });
  });
  return el;
}

function updateBotRow(el, bot) {
  el.querySelector('.ts-idx').textContent = bot.roomIndex;
  el.querySelector('.ts-bot-name').textContent = bot.displayName || 'bot';
  const muteBtn = el.querySelector('[data-bot-action="mute"]');
  muteBtn.textContent = bot.muted ? 'unmute' : 'mute';
  muteBtn.classList.toggle('on', !!bot.muted);
  el.querySelector('[data-bot-action="video"]').classList.toggle('on', !!bot.videoOn);
}

// Built once per peer selection. The count input is a stable node from here
// on — nothing ever rewrites its .value except the operator's own typing, so
// the "spawn count silently reverts to 2" bug (botClusterBlock used to
// hardcode value="2" into a template re-rendered on every peer-state tick)
// cannot recur structurally, not just by a preserve/restore patch on top.
function createBotClusterSection() {
  const el = document.createElement('div');
  el.className = 'ts-section ts-bot-cluster-section';
  el.innerHTML = `
    <div class="ts-section-head">
      <div class="ts-section-title">Bot Cluster</div>
      <div class="ts-section-controls">
        <input class="ts-select ts-bot-count" type="number" min="1" max="10" value="2" style="width:52px;">
        <button class="ts-btn ghost ts-dwell-btn" data-bot-action="spawn">+ Spawn</button>
        <button class="ts-btn ghost ts-dwell-btn" data-bot-action="mute-all">🔇 all</button>
        <button class="ts-btn ghost ts-dwell-btn" data-bot-action="remove-all">× all</button>
      </div>
    </div>
    <div class="ts-bot-rows"></div>
    <div class="ts-meta ts-bot-empty">no bots in your cluster</div>
    <div class="ts-meta ts-bot-status" style="display:none;"></div>
  `;
  const countEl = el.querySelector('.ts-bot-count');
  el.querySelector('[data-bot-action="spawn"]').addEventListener('click', () => {
    // The editor box itself, not the last-evaluated pattern: a botConfig(...)
    // makes no sound, so nothing prompts an author to re-run their block after
    // typing one, and peer.pattern only advances on eval. `:not(.jp-code)` is
    // load-bearing — the shared JPattern textarea also carries .ts-code.
    const codeEl = document.querySelector(`#${OVERLAY_ID} .ts-code:not(.jp-code)`);
    spawnBots(parseInt(countEl.value, 10) || 1, codeEl ? codeEl.value : undefined);
  });
  el.querySelector('[data-bot-action="remove-all"]').addEventListener('click', () => removeBots('all'));
  el.querySelector('[data-bot-action="mute-all"]').addEventListener('click', () => muteBots('all', true));
  return el;
}

function updateBotClusterSection(el) {
  const bots = myClusterBots();
  reconcileList(el.querySelector('.ts-bot-rows'), bots, botRowKey, createBotRow, updateBotRow);
  el.querySelector('.ts-bot-empty').style.display = bots.length ? 'none' : '';
  const statusEl = el.querySelector('.ts-bot-status');
  if (lastFleetStatus) {
    statusEl.textContent = lastFleetStatus;
    statusEl.style.display = '';
  } else {
    statusEl.style.display = 'none';
  }
}

// Resolves whichever peer is currently selected, repairing selectedJitsiId
// if it's gone stale (see selectedPeerKey's declaration comment) rather than
// letting a caller fall back to the local peer on a merely-renamed jitsiId.
// Callers that DO want a "nothing selected yet" fallback to the local peer
// (only renderDetail, which must always show SOMETHING) do that themselves
// afterward; a caller that should do nothing when the selection is
// unresolvable (the in-place remote-tile sync in renderAll) can just check
// the return value.
function resolveSelectedPeer() {
  let peer = getPeerByJitsiId(selectedJitsiId);
  // selectedJitsiId can go stale out from under an otherwise-unchanged
  // selection: a P2P<->JVB renegotiation re-keys jitsiId for ANY
  // participant (human or bot — see peerKeyAttr's comment on the remote-tile
  // textarea), never peerId. Recover by the stable id instead of silently
  // treating the selection as gone, which used to make renderDetail snap
  // back to the local peer with no indication anything happened — reading
  // as "my bot edit reverted" when what actually happened is the studio
  // quietly switched to showing an unrelated (the operator's own) tile, and
  // any further edits/evals were going to THAT tile instead.
  if (!peer && selectedPeerKey && selectedPeerKey !== 'local') {
    peer = getAllPeers().find(p => p.peerId === selectedPeerKey) || null;
    if (peer) selectedJitsiId = peer.jitsiId;
  }
  return peer;
}

// Top-level entry point, called every tick. Decides whether the selected
// peer's identity actually changed (rare — a deliberate chip click, or the
// very first render) and only rebuilds structure then; otherwise it just
// patches the existing structure with fresh data. See buildDetailShell and
// patchDetailForPeer for what each half does.
function renderDetail(container) {
  let peer = resolveSelectedPeer();
  if (!peer) {
    const local = getLocalPeer();
    if (local && local.jitsiId) {
      selectedJitsiId = local.jitsiId;
      peer = local;
    }
  }
  if (!peer) {
    if (container.dataset.peerKey) delete container.dataset.peerKey;
    if (!container.querySelector('.ts-meta')) {
      container.innerHTML = `<div class="ts-meta">Waiting for participant data…</div>`;
    }
    return;
  }

  const isLocal = !!peer.isLocal;
  // Track the stable id behind whatever jitsiId ended up selected, so the
  // NEXT jitsiId flip (this peer's or anyone else's) can recover the same
  // way rather than only the first one.
  selectedPeerKey = isLocal ? 'local' : (peer.peerId || null);
  // The LOCAL peer's key must be the constant 'local', NOT peer.jitsiId:
  // participants.js polls window.APP.conference and emits 'local-update' with
  // a new id across a P2P<->JVB renegotiation (room crossing the 2<->3-
  // participant boundary — see pageEnsureAudioPublished's watchdog for the
  // same underlying flip on the bot side), which is a real, observed
  // mid-session event with nothing to do with the editor. Keying local on
  // jitsiId used to make that moment look like "a different peer" and
  // rebuild the shell, silently reverting the box to peer.pattern (the last
  // EVALUATED text) and losing everything typed since. A remote tile has the
  // same flip on the bot side, so its key is peer.peerId — the
  // websocket-assigned id that never changes for the life of the connection
  // — rather than jitsiId.
  const peerKey = isLocal ? 'local' : String(peer.peerId || peer.jitsiId || '');

  if (container.dataset.peerKey !== peerKey) {
    buildDetailShell(container, peer, peerKey, isLocal);
  }
  patchDetailForPeer(container, peer, isLocal);
}

function buildDetailShell(container, peer, peerKey, isLocal) {
  container.innerHTML = '';
  container.dataset.peerKey = peerKey;
  container.style.setProperty('--ts-detail-color', chipColor(peer.jitsiId, isLocal));

  const header = document.createElement('div');
  header.className = 'ts-detail-header';
  header.innerHTML = `<div class="ts-detail-name"></div>`;
  container.appendChild(header);

  container.appendChild(createMetricsSection());

  if (isLocal) container.appendChild(createBotClusterSection());

  const localProgram = createLocalProgramSection(isLocal);
  container.appendChild(localProgram);
  bindLocalProgramSection(localProgram, peer, isLocal);

  const status = document.createElement('div');
  status.className = 'ts-status';
  container.appendChild(status);
}

function createLocalProgramSection(isLocal) {
  const el = document.createElement('div');
  el.className = 'ts-section ts-local-program-section';
  // Remote tiles are editable too: an operator can drive a participant's
  // pattern from here. The server only applies edits/mutes to bots (humans
  // own their own state), so for a human peer the textarea is a no-op
  // scratchpad. The mute button only makes sense for a bot, so it starts
  // hidden and patchLocalProgramSection shows it when peer.isBot.
  const controls = isLocal
    ? `
      <div class="ts-section-controls">
        <button class="ts-btn play" data-action="play">▶ Play</button>
        <button class="ts-btn stop" data-action="stop">■ Stop</button>
        <button class="ts-btn ghost" data-action="load-samples" title="Load a folder of audio files (and any JSON/CSV/TSV inside it) into Strudel">⬆ Samples</button>
        <input type="file" class="ts-samples-input" webkitdirectory style="display:none">
        <button class="ts-btn ghost" data-action="load-data" title="Load JSON/CSV/TSV files as data packs — reference a column as &quot;Name:3&quot;">⬆ Data</button>
        <input type="file" class="ts-data-input" accept=".json,.csv,.tsv" multiple style="display:none">
        <span class="ts-shortcuts">Ctrl+Enter to eval · Ctrl+. to stop · Ctrl+/ to comment</span>
      </div>`
    : `
      <div class="ts-section-controls">
        <button class="ts-btn eval" data-action="remote-eval">▶ Eval</button>
        <button class="ts-btn mute ts-remote-mute-btn" data-action="mute" style="display:none;"></button>
        <span class="ts-shortcuts">Ctrl+Enter to send · Ctrl+/ to comment</span>
      </div>`;
  el.innerHTML = `
    <div class="ts-section-head">
      <div class="ts-section-title">Local Program</div>
      ${controls}
    </div>
    <div class="ts-sample-banks-host"></div>
    <textarea class="ts-code" spellcheck="false"></textarea>
    <div class="ts-strudel-sliders ts-sliders"></div>
  `;
  return el;
}

// Binds everything that only needs binding once per peer selection — this
// runs a single time when buildDetailShell creates the section, not on every
// data tick, so it's safe to close over `peer`/`isLocal`/`targetPeerId`
// (fixed for the shell's whole lifetime). Anything that needs a value that
// can change while the shell is alive (peer.muted, peer.pattern) re-reads it
// fresh at the point of use instead — see the mute handler and
// patchLocalProgramSection.
// Ctrl+/ line-comment toggle for a plain textarea: replacing .value resets
// the caret to the end, so the pure toggle's remapped selection has to be
// restored explicitly afterward.
function applyCommentToggle(codeEl) {
  const { value, selectionStart, selectionEnd } =
    toggleLineComment(codeEl.value, codeEl.selectionStart, codeEl.selectionEnd);
  codeEl.value = value;
  codeEl.setSelectionRange(selectionStart, selectionEnd);
  codeEl.dispatchEvent(new Event('input', { bubbles: true }));
}

function bindLocalProgramSection(el, peer, isLocal) {
  const codeEl = el.querySelector('.ts-code');
  const targetPeerId = peer.peerId;

  if (isLocal) {
    // Seed once. Local edits are authoritative in the DOM from here on —
    // patchLocalProgramSection never overwrites this value; it only reaches
    // peer-state on eval (sendLocalPattern), exactly as before.
    codeEl.value = peer.pattern || '';
    attachUndoHistory(codeEl);

    codeEl.addEventListener('input', () => {
      clearTimeout(codeDebounce);
      codeDebounce = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, codeEl.value); } catch (e) {}
      }, 200);
    });
    codeEl.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key === 'Enter') {
        e.preventDefault();
        onEvalAndPlay(codeEl.value);
      } else if (meta && e.key === '.') {
        e.preventDefault();
        onStopClick();
      } else if (meta && e.key === '/') {
        e.preventDefault();
        applyCommentToggle(codeEl);
      }
    });

    el.querySelector('[data-action="play"]').addEventListener('click', () => {
      onEvalAndPlay(codeEl.value);
    });
    el.querySelector('[data-action="stop"]').addEventListener('click', onStopClick);
    const captureBtnEl = el.querySelector('[data-action="capture"]');
    if (captureBtnEl) captureBtnEl.addEventListener('click', onCaptureClick);
    // const relayBtnEl = el.querySelector('[data-action="relay"]');
    // if (relayBtnEl) relayBtnEl.addEventListener('click', onRelayClick);

    // One ingest path for both buttons: the folder picker takes audio and any
    // data files sitting alongside it, the file picker takes data files chosen
    // directly. uploadSamplesToDB sorts them out by extension either way.
    const wireUpload = (buttonSelector, inputSelector) => {
      const button = el.querySelector(buttonSelector);
      const input = el.querySelector(inputSelector);
      if (!button || !input) return;
      // uploadPending must be set BEFORE input.click() opens the native
      // picker: that dialog can sit open for as long as the user takes to
      // find a file. This section is now stable across peer-state ticks (it
      // only rebuilds on a deliberate peer-selection change), so the old "a
      // background tick tears the input out mid-dialog" race is gone; this
      // still guards the one remaining path — switching the selected peer
      // while the dialog is open.
      button.addEventListener('click', () => { uploadPending = true; input.click(); });
      // Modern Chromium fires 'cancel' when the user dismisses the picker
      // without choosing a file; without this the flag would stay stuck true
      // and freeze the shell rebuild path until the next successful upload.
      input.addEventListener('cancel', () => { uploadPending = false; });
      input.addEventListener('change', async () => {
        try {
          const files = input.files;
          if (!files || !files.length) return;
          setStatus('Loading…');
          await uploadSamplesToDB(files, async ({ audio, images, packs, errors }) => {
            if (!audio && !images && !packs) {
              setStatus(errors.length ? errors[0] : 'No audio, image or data files found');
              return;
            }
            // Images are re-minted by the same refresh as the sounds, so an
            // image-only upload has to trigger it too or img() resolves to nothing.
            if (audio || images) await refreshLocalSamples();
            await refreshSampleBanks();
            const parts = [];
            if (audio) parts.push(`${audio} sample${audio === 1 ? '' : 's'}`);
            if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
            if (packs) parts.push(`${packs} data pack${packs === 1 ? '' : 's'}`);
            const hint = packs
              ? ' — reference a column as "Name:3"'
              : images && !audio
                ? ' — use img("foldername") in a Hydra preamble'
                : ' — use s("foldername") in patterns';
            setStatus(`Loaded ${parts.join(', ')}${hint}`
              + (errors.length ? ` (${errors.length} rejected)` : ''));
          });
          input.value = '';
        } finally {
          uploadPending = false;
        }
      });
    };
    wireUpload('[data-action="load-samples"]', '.ts-samples-input');
    wireUpload('[data-action="load-data"]', '.ts-data-input');

    el.querySelector('.ts-sample-banks-host').appendChild(createSampleBanksArea());
  } else {
    // Remote tile: editing drives the participant (bots only, enforced server-side).
    codeEl.value = peer.pattern || '';
    codeEl.dataset.lastSynced = codeEl.value;
    attachUndoHistory(codeEl);
    const sendRemoteEval = () => sendRemotePattern(targetPeerId, codeEl.value);
    codeEl.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key === 'Enter') { e.preventDefault(); sendRemoteEval(); }
      else if (meta && e.key === '/') { e.preventDefault(); applyCommentToggle(codeEl); }
    });
    el.querySelector('[data-action="remote-eval"]').addEventListener('click', sendRemoteEval);
    el.querySelector('.ts-remote-mute-btn').addEventListener('click', () => {
      // Read fresh state at click time — this closure outlives any single
      // peer-state tick, so a captured peer.muted would go stale.
      const current = resolveSelectedPeer();
      sendRemoteMute(targetPeerId, !(current && current.muted));
    });
  }
}

// Runs on every peer-state tick (far more often than buildDetailShell —
// every ~2s per peer) and only ever touches text/classes/values inside the
// existing structure, never the structure itself.
function patchDetailForPeer(container, peer, isLocal) {
  container.style.setProperty('--ts-detail-color', chipColor(peer.jitsiId, isLocal));

  const header = container.querySelector('.ts-detail-header');
  header.querySelector('.ts-detail-name').textContent = isLocal ? 'You' : (peer.displayName || 'Participant');
  let botBadge = header.querySelector('.ts-bot-badge');
  const showBadge = !isLocal && peer.isBot;
  if (showBadge && !botBadge) {
    botBadge = document.createElement('span');
    botBadge.className = 'ts-bot-badge';
    botBadge.textContent = 'BOT';
    header.appendChild(botBadge);
  } else if (!showBadge && botBadge) {
    botBadge.remove();
  }

  // Jamulus capture + relay controls are detached for now (kept for later
  // use — see the commented-out block in createLocalProgramSection). This is
  // what used to feed networkMetricsBlock's header controls.
  updateMetricsSection(container.querySelector('.ts-metrics-section'), peer, '');

  if (isLocal) {
    const botCluster = container.querySelector('.ts-bot-cluster-section');
    if (botCluster) updateBotClusterSection(botCluster);
  }

  patchLocalProgramSection(container.querySelector('.ts-local-program-section'), peer, isLocal);

  const status = isLocal ? lastStatus : (peer.muted ? 'Muted' : (peer.playing ? 'Playing' : 'Idle'));
  container.querySelector('.ts-status').textContent = status;

  refreshFacialGestureButtons();
}

function patchLocalProgramSection(el, peer, isLocal) {
  if (isLocal) {
    const banksHost = el.querySelector('.ts-sample-banks-host');
    const area = banksHost.firstElementChild;
    if (area) updateSampleBanksArea(area);
    return;
  }

  const muteBtnEl = el.querySelector('.ts-remote-mute-btn');
  muteBtnEl.style.display = peer.isBot ? '' : 'none';
  muteBtnEl.textContent = peer.muted ? '🔇 Muted' : '🔈 Mute';
  muteBtnEl.classList.toggle('on', !!peer.muted);

  // Never stomp an unsent edit: while focused, only follow a live pattern
  // change if nothing has been typed since the last sync (still equal to
  // what this box was last painted from — a genuinely new peer.pattern, e.g.
  // a retroactive botConfig relatch changing what the bot is actually
  // playing, is still safe to show even while focused). Unfocused always
  // follows live — there's no in-progress edit to lose.
  const codeEl = el.querySelector('.ts-code');
  const active = document.activeElement === codeEl;
  const hasUnsentEdit = active && codeEl.value !== codeEl.dataset.lastSynced;
  if (!hasUnsentEdit) {
    const live = peer.pattern || '';
    if (codeEl.value !== live) {
      codeEl.value = live;
      resetUndoBaseline(codeEl);
    }
    codeEl.dataset.lastSynced = live;
  }
}

// Delegated: bank chips and their delete buttons are fully regenerated on
// every upload/delete anyway (low-frequency, user-initiated), so one
// listener on the wrapper avoids rebinding per-chip on every refresh.
function createSampleBanksArea() {
  const el = document.createElement('div');
  el.className = 'ts-sample-banks-area';
  el.addEventListener('click', async (e) => {
    const bankChip = e.target.closest('[data-action="toggle-bank"]');
    if (bankChip) {
      const name = bankChip.getAttribute('data-bank');
      expandedBank = expandedBank === name ? null : name;
      updateSampleBanksArea(el);
      return;
    }
    const delSample = e.target.closest('[data-action="delete-sample"]');
    if (delSample) {
      const id = delSample.getAttribute('data-sample');
      setStatus('Deleting sample…');
      await deleteSample(id);
      await refreshLocalSamples();
      await refreshSampleBanks();
      // The pack may have been emptied by that delete, which removes it.
      if (!sampleBanks.some(b => b.name === expandedBank)) expandedBank = null;
      await rebakeStrudel();
      setStatus('Sample deleted');
      updateSampleBanksArea(el);
      return;
    }
    const delAll = e.target.closest('[data-action="delete-samples"]');
    if (delAll) {
      if (!window.confirm('Delete all imported user samples and data packs?')) return;
      setStatus('Deleting samples…');
      await clearSamplesDB();
      sampleBanks = [];
      expandedBank = null;
      // Withdraw them from the room too, or peers would keep resolving
      // references to packs this browser no longer has.
      sendLocalDataPacks([]);
      await rebakeStrudel();
      setStatus('User samples deleted');
      updateSampleBanksArea(el);
    }
  });
  updateSampleBanksArea(el);
  return el;
}

// A bank chip opens a list of its own samples, each deletable on its own.
// Audio banks read `name (n)` as they always have; a data pack reads
// `Name:n` — the same spelling a reference to it uses, with n the number of
// columns/properties it holds.
function updateSampleBanksArea(el) {
  if (!sampleBanks.length) { el.innerHTML = ''; return; }
  const bankChip = (b) => {
    const label = b.kind === 'audio'
      ? `${escapeHtml(b.name)} (${b.count})`
      : `${escapeHtml(b.name)}:${b.count}`;
    const open = expandedBank === b.name;
    return `<button class="ts-sample-bank${b.kind === 'audio' ? '' : ' data'}${open ? ' open' : ''}"
      data-action="toggle-bank" data-bank="${escapeHtml(b.name)}"
      title="${b.kind === 'audio' ? 'audio bank' : `${b.kind.toUpperCase()} data pack`}${
        b.truncated ? ' — truncated to fit the memory budget' : ''}">${label}${b.truncated ? ' ⚠' : ''}</button>`;
  };
  const openBank = sampleBanks.find(b => b.name === expandedBank);
  const sampleList = openBank ? `
    <div class="ts-sample-list">
      ${openBank.samples.map((s, i) => `
        <span class="ts-sample-item">
          <span class="ts-sample-idx">${openBank.kind === 'audio' ? i : i + 1}</span>
          <span class="ts-sample-label"${s.preview ? ` title="${escapeHtml(s.preview)}"` : ''}>${escapeHtml(s.label)}</span>
          ${s.length != null ? `<span class="ts-sample-len">${s.length}${s.truncated ? '⚠' : ''}</span>` : ''}
          <button class="ts-sample-x" data-action="delete-sample" data-sample="${escapeHtml(s.id)}"
            title="delete this sample">×</button>
        </span>`).join('')}
    </div>` : '';
  el.innerHTML = `
    <div class="ts-sample-banks">
      ${sampleBanks.map(bankChip).join('')}
      <button class="ts-sample-banks-del" data-action="delete-samples">× delete all user samples</button>
    </div>
    ${sampleList}`;
}

async function onEvalAndPlay(code) {
  if (typeof code === 'string') {
    const dir = readDirective(code);
    if (dir.kind !== 'personal') {
      setStatus(dir.kind == null
        ? "Add 'personal program' as the first line of your editor"
        : `This editor opens with '${dir.phrase}', not 'personal program'`);
      return;
    }
  }
  setStatus('Starting…');
  try {
    await bootAudioEngine();
    if (typeof code === 'string') sendLocalPattern(code);
    await bootStrudelOnUserGesture();
    sendLocalPlaying(true);
    setStatus('Playing');
    document.dispatchEvent(new CustomEvent('trussal-eval'));
  } catch (e) {
    console.error('[studio] play failed', e);
    setStatus('Error: ' + (e && e.message ? e.message : e));
  }
}

async function onStopClick() {
  try {
    sendLocalPlaying(false);
    await stopStrudel();
    setStatus('Stopped');
  } catch (e) {
    console.error('[studio] stop failed', e);
  }
}

// Capture an external audio input (e.g. a virtual device that loopback-carries
// Jamulus output) and propagate it to the room: the stream is mixed into the
// outgoing Jitsi mic via an audio mixing effect, so every other peer receives
// it as part of our mic stream and renders it through OUR per-peer chain on
// their side — the room hears the processed signal.
//
// We deliberately do NOT monitor the captured stream through the local speakers
// (monitorLocally: false). The capture device is almost always a monitor/loopback
// of the same output the browser plays to, so self-monitoring would re-emit the
// signal into the very device we're capturing and howl ("nothing but feedback").
// The local user already hears Jamulus natively, so local playback is redundant.
async function onCaptureClick() {
  const local = getLocalPeer();
  if (!local || !local.jitsiId) return;
  if (getExternalStreamLabel(local.jitsiId)) {
    // Detach order matters: stop propagating to the room first (restores the
    // original outgoing mic track) THEN tear down the local chain hookup, so
    // Jitsi never sees a stopped track on the wire.
    await stopPropagatingExternalStream();
    detachExternalStreamForPeer(local.jitsiId);
    setJamulusMode(false);
    setStatus('Input detached');
    renderAll();
    return;
  }
  try {
    setStatus('Picking input…');
    const devices = await listAudioInputDevices();
    let deviceId = null;
    let label = 'default';
    if (devices.length > 1) {
      const choice = window.prompt(
        'Select an audio input by number to route through your effects chain ' +
        '(use a virtual device that carries Jamulus to feed Jamulus through here):\n\n' +
        devices.map((d, i) => `${i + 1}. ${d.label}`).join('\n'),
        '1'
      );
      if (!choice) { setStatus('Cancelled'); return; }
      const idx = parseInt(choice, 10) - 1;
      if (devices[idx]) { deviceId = devices[idx].deviceId; label = devices[idx].label; }
    } else if (devices.length === 1) {
      deviceId = devices[0].deviceId;
      label = devices[0].label;
    }
    // Disable the voice-telephony processing chain. Jamulus output is music;
    // AGC pumps it, noise suppression chews sustained notes, echo cancellation
    // comb-filters anything that resembles a loopback. We want the raw stream.
    const audioConstraints = {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    await attachExternalStreamForPeer(local.jitsiId, stream, label, { monitorLocally: false });
    const propagated = await propagateExternalStreamToRoom(stream);
    setJamulusMode(true);
    setStatus(propagated ? `Capturing ${label} → room` : `Capturing ${label} (local only — no Jitsi mic hook)`);
    renderAll();
  } catch (e) {
    console.error('[studio] capture failed', e);
    setStatus('Capture failed: ' + (e && e.message ? e.message : e));
  }
}

// Strudel's own `slider()` controls, re-rendered on every trussal-sliders-updated.
// Target .ts-strudel-sliders, not bare .ts-sliders: any other panel that later
// reuses the .ts-sliders styling class would get blanked out (the empty-list
// early return below) on every render.
// Strudel's slider() carries no name of its own — the transpiler keys each
// one by its character range in the (multi-peer, combined) evaluated program,
// not anything human-readable (strudel-fork/packages/transpiler/plugin-
// widgets.mjs). The only signal studio.js has for "what does this control" is
// the LOCAL peer's own last-evaluated pattern text: find the identifier
// immediately wrapping each slider(...) call — ".gain(slider(...))" -> "gain"
// — and pair the matches up positionally against `sliders` (both are
// left-to-right source order, and currentSliders is only ever refreshed right
// after THIS text was what got evaluated, so the two can't be out of sync).
// Only trusted when the counts match exactly; any mismatch (a slider nested
// in something this regex can't see through, e.g.) falls back to the plain
// "slider N" label rather than risk mislabeling one.
function deriveSliderLabels(sliders) {
  const local = getLocalPeer();
  const text = (local && local.pattern) || '';
  const matches = [...text.matchAll(/\bslider\s*\(/g)];
  if (matches.length !== sliders.length) return sliders.map((_, i) => `slider ${i + 1}`);
  return matches.map((m, i) => {
    const before = text.slice(0, m.index).trimEnd();
    const named = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\($/.exec(before);
    return named ? named[1] : `slider ${i + 1}`;
  });
}

function renderSliders(container, sliders) {
  const area = container.querySelector('.ts-strudel-sliders');
  if (!area) return;
  if (!sliders || !sliders.length) { area.innerHTML = ''; return; }
  const labels = deriveSliderLabels(sliders);
  area.innerHTML = sliders.map((s, i) => `
    <div class="ts-slider-row" data-slider-id="${escapeHtml(String(s.id))}">
      <div class="ts-slider-label">
        <span>${escapeHtml(labels[i])}</span>
        <span class="ts-slider-val">${Number(s.value).toFixed(3)}</span>
      </div>
      <input class="ts-slider-input" type="range"
        min="${s.min}" max="${s.max}" step="${s.step}" value="${s.value}">
    </div>`).join('');
  area.querySelectorAll('.ts-slider-row').forEach(row => {
    const id = row.dataset.sliderId;
    const input = row.querySelector('input');
    const valEl = row.querySelector('.ts-slider-val');
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      updateSliderValue(id, v);
      if (valEl) valEl.textContent = v.toFixed(3);
    });
  });
}

function setStatus(text) {
  lastStatus = text;
  const statusEl = document.querySelector(`#${OVERLAY_ID} .ts-status`);
  if (statusEl) statusEl.textContent = text;
}

// Every entry point in this file that used to mean "something changed, tear
// down and rebuild" now just means "resync" — renderStrip/renderDetail patch
// their existing DOM in place (see reconcileList and buildDetailShell's
// comment) rather than blowing it away, so calling this on every peer-state
// broadcast (every ~2s per peer) or click no longer costs a focused input's
// cursor, a click gesture in flight, or a scroll position. rAF-batched so a
// burst of updates in one frame only patches once.
let renderQueued = false;
function renderAll() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    const strip = overlay.querySelector('.ts-strip');
    const detail = overlay.querySelector('.ts-detail');
    if (strip) renderStrip(strip);
    // A native file picker opened by wireUpload's Samples/Data button holds a
    // reference to the .ts-data-input/.ts-samples-input node inside this very
    // panel. That node is now stable across ordinary patches (see
    // buildDetailShell), so the only remaining way to detach it from under an
    // open dialog is a genuine peer-selection change landing in that window —
    // still worth guarding against, since Chromium never fires 'change' on a
    // detached input and the upload would silently go nowhere.
    if (detail && !uploadPending) renderDetail(detail);
    if (detail) renderSliders(detail, currentSliders);
  });
}

document.addEventListener('trussal-sliders-updated', (e) => {
  currentSliders = e.detail || [];
  const detail = document.querySelector(`#${OVERLAY_ID} .ts-detail`);
  if (detail) renderSliders(detail, currentSliders);
});

function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;
  if (!document.body) return null;

  injectStyles();
  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="ts-header">
      <div class="ts-title">Trussal Studio <small>each participant owns their own instrument</small></div>
      <button class="ts-dwell-btn ts-collapse-btn" id="trussal-studio-collapse" type="button" title="Collapse / expand panel">▼</button>
      <button class="ts-close" type="button">✕</button>
    </div>
    <div class="ts-strip"></div>
    <div class="ts-jpattern" style="padding: 0 14px; display:flex; flex-direction:column; gap:12px;"></div>
    <div class="ts-detail"></div>
  `;
  document.body.appendChild(overlay);

  // Jitsi's own toolbar popovers (hangup menu, "..." overflow menu, etc.)
  // close themselves on any mousedown/click that bubbles to document and
  // doesn't land inside their own DOM. Trussal Studio is a separate DOM
  // subtree, so without this guard every interaction inside it — collapsing,
  // closing, clicking a button — reads to Jitsi as an outside click and
  // closes whatever Jitsi menu happens to be open. Stop both event types
  // here so nothing from within Studio ever reaches document.
  overlay.addEventListener('mousedown', (e) => e.stopPropagation());
  overlay.addEventListener('click', (e) => e.stopPropagation());

  // The JPattern card mounts once, outside the re-rendered detail panel,
  // so the live CRDT-bound textarea survives roster/metrics re-renders.
  const ncHost = overlay.querySelector('.ts-jpattern');
  try {
    mountMetaprogrammerEditor(ncHost);
    mountMetaprogrammerCycleHighlighter(ncHost);
  } catch (e) {
    console.warn('[studio] JPattern card mount failed', e);
  }

  overlay.querySelector('.ts-close').addEventListener('click', () => {
    overlay.style.display = 'none';
    tickKbdUi(); // and take the body-level keyboard panel down with it
  });

  const studioCollapseBtn = overlay.querySelector('#trussal-studio-collapse');
  if (studioCollapseBtn) {
    studioCollapseBtn.addEventListener('click', () => {
      const strip  = overlay.querySelector('.ts-strip');
      const detail = overlay.querySelector('.ts-detail');
      if (!strip || !detail) return;
      const collapsed = strip.style.display === 'none';
      strip.style.display  = collapsed ? '' : 'none';
      detail.style.display = collapsed ? '' : 'none';
      studioCollapseBtn.textContent = collapsed ? '▼' : '▲';
      // Drop a resized panel's explicit height while collapsed so the hidden
      // strip/detail don't leave dead space; put it back on expand.
      overlay.classList.toggle('ts-collapsed', !collapsed);
      if (!collapsed) { savedStudioHeight = overlay.style.height; overlay.style.height = ''; }
      else { overlay.style.height = savedStudioHeight; }
    });
  }

  injectFacialGestureToggle(overlay.querySelector('.ts-header'));
  injectKeyboardToggle(overlay.querySelector('.ts-header'));

  // Drag/resize the whole overlay by its header (mouse) or the ✥ / ⇲ header
  // buttons (head cursor) — same window behaviour as the on-screen keyboard.
  attachPanelControls(overlay, {
    handle: overlay.querySelector('.ts-header'),
    minW: 360,
    minH: 260,
  });

  refreshSampleBanks();

  const localPeer = getLocalPeer();
  if (localPeer.jitsiId && !localPeer.pattern) {
    let seed = DEFAULT_PATTERN;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // A draft saved before the directive existed is migrated in place — the
      // editor pre-fills the line, the same as the default seed carrying it.
      if (saved && saved.trim()) seed = ensureDirective(saved, 'personal');
    } catch (e) {}
    sendLocalPattern(seed);
  }

  renderAll();
  return overlay;
}

function ensureToggle() {
  let btn = document.getElementById(BUTTON_ID);
  if (btn) return btn;
  if (!document.body) return null;
  injectStyles();

  btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.textContent = 'Studio';
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const overlay = ensureOverlay();
    if (!overlay) return;
    overlay.style.display = (overlay.style.display === 'none') ? 'flex' : 'none';
    if (overlay.style.display === 'flex') renderAll();
    else tickKbdUi(); // hiding Studio from its toggle takes the keyboard panel too
  });
  document.body.appendChild(btn);
  return btn;
}

function tickUi() {
  const room = getRoomNameFromUrl();
  if (!room || !isInMeeting()) {
    const btn = document.getElementById(BUTTON_ID);
    const overlay = document.getElementById(OVERLAY_ID);
    if (btn) btn.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    tickKbdUi(); // retract the body-level keyboard panel once Studio is hidden
    initedRoom = null;
    return;
  }
  if (initedRoom !== room) {
    initedRoom = room;
    const local = getLocalParticipant();
    if (local && !selectedJitsiId) { selectedJitsiId = local.id; selectedPeerKey = 'local'; }
  }
  const btn = ensureToggle();
  if (btn) btn.style.display = 'block';

  tickKbdUi(); // retract the keyboard panel if Studio was closed while it was open
  startNetStatsPolling(sendLocalNetStats);
  // This rig measures its own capture/codec/playout latency by loopback and
  // publishes it, so the room's worst-case bound is built from real hardware
  // rather than one constant standing in for every machine.
  startPipelineLatencyMeasurement(sendLocalNetStats, getAudioContext);
  startRoomHealth();
  bootAudioEngine().catch(e => console.warn('[studio] audio boot deferred', e));
}

// Keyboard module requests eval via this event. The JPattern editor's
// Eval applies the shared metaprogram instead of booting Strudel.
document.addEventListener('trussal-kbd-eval', (e) => {
  const code = e.detail?.code;
  if (e.detail?.editor === 'jpattern') {
    import('./audio-net/Metaprogrammer.js').then(m => {
      const errors = m.applyProgramText(typeof code === 'string' ? code : '');
      setStatus(errors.length ? `metaprogram: ${errors[0].line}:${errors[0].col} ${errors[0].message}` : 'metaprogram applied');
    });
    return;
  }
  onEvalAndPlay(typeof code === 'string' ? code : (getLocalPeer()?.pattern ?? ''));
});

// Flash the code textarea border whenever an eval fires (from keyboard, gesture, or button).
// trussal-eval is the personal instrument's signal, so it must not land on the
// JPattern textarea — which shares .ts-code and sits above it in the overlay.
document.addEventListener('trussal-eval', () => {
  const codeEl = document.querySelector(`#${OVERLAY_ID} .ts-code:not(.jp-code)`);
  if (codeEl) {
    codeEl.classList.remove('ts-eval-flash');
    void codeEl.offsetWidth; // force reflow so the animation restarts each time
    codeEl.classList.add('ts-eval-flash');
  }
});

subscribeParticipants((event, payload) => {
  if (event === 'local' && payload && !selectedJitsiId) { selectedJitsiId = payload.id; selectedPeerKey = 'local'; }
  renderAll();
});

subscribePeerState(() => renderAll());

subscribeAudioRouting((set) => {
  routedSet = set instanceof Set ? set : new Set(set);
  renderAll();
});

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  tickUi();
} else {
  window.addEventListener('DOMContentLoaded', tickUi);
}
setInterval(tickUi, 1000);
