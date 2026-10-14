// Unified Trussal Studio UI.

import studioStyles from './studio.css';
import { getRoomNameFromUrl } from './get-room-name-from-url.js';
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
import { uploadChatFilesToDB } from './file-cycles.js';
import { panic as panicToMainRoom } from './panic-button.js';
import { injectFacialGestureToggle } from './facial-gesture.js';
import { injectKeyboardToggle, tickKbdUi, _esc as escapeHtml } from './on-screen-keyboard.js';
export { _esc as escapeHtml } from './on-screen-keyboard.js';
import { attachPanelControls } from './panel-drag-resize.js';
import { toggleLineComment } from './editor-router-core.js';
import { readDirective, ensureDirective, stripDirective } from './program-directive.js';
import { detectNotation } from './notation.js';
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
  applyBotClusterDirectives,
  resetBotClusterDirectives,
  subscribeFleetStatus
} from './audio-net/UserBotOrchestration.js';
import { startRoomHealth } from './audio-net/RoomHealthService.js';
import {
  getTheme,
  setTheme,
  isHexColor,
  isFontScale,
  WEB_SAFE_FONTS,
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  MIN_FONT_SCALE,
  MAX_FONT_SCALE,
} from './theme-context.js';

const BUTTON_ID  = 'trussal-studio-toggle';
const OVERLAY_ID = 'trussal-studio-overlay';
const STYLE_ID   = 'trussal-studio-style';
const STORAGE_KEY = 'trussal.studio.pattern';

let selectedJitsiId = null;
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

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = studioStyles;
  document.head.appendChild(style);
}

// Feeds the --ts-chip-color / --ts-detail-color custom properties. The flat
// monochrome theme (studio.css) no longer reads either, so this has no visual
// effect today — kept (rather than ripping out the setProperty calls) so a
// future themed variant can wire the properties back up in one place.
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


function scopeTag(kind) {
  return `<span class="ts-scope" title="${kind === 'personal'
    ? 'this participant’s own reading'
    : 'room-wide worst case — identical on every client'}">${kind}</span>`;
}

function metricsLine(peer) {
  // preciseMs, not toFixed(0): at LAN scale a fixed 0-decimal render printed a
  // 0.4 ms RTT as "0ms" next to a WCL of "0.40ms" — the same number,
  // contradicting itself two lines apart. It coerces null to 0, so the
  // unmeasured guard stays.
  const ms = (v) => (typeof v === 'number' ? preciseMs(v) : '–');
  const rtt = ms(peer.rtt);
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
    routedTxt = peer.playing ? '<b>instrument playing</b>' : 'not playing';
  } else {
    routedTxt = 'no live audio';
  }
  return `<div class="ts-meta" title="RTT is the WS ping/pong signalling leg to the sidecar">${scopeTag('personal')} RTT <b>${rtt}</b> · ${routedTxt}</div>`;
}


function cycleLengthReadout(wc) {
  const text = getProgramText();
  if (!text) return `${scopeTag('global')} Current turn length: <b>&mdash;</b> <span title="no metaprogram running yet">(no program)</span>`;
  const { ast, valid } = parseMetaprogram(text);
  if (!valid) return `${scopeTag('global')} Current turn length: <b>&mdash;</b> <span title="the metaprogram has parse errors">(program invalid)</span>`;
  const { seconds, beats, beatSeconds } = cycleLength({ cycles: ast.cycles, tempo: ast.tempo, metrics: wc });
  const targetS = timingTargetSeconds(ast.cycles, wc);
  const { metric, factor, fixed } = ast.cycles;
  // Spell the arithmetic out. On a LAN the driving metric is a fraction of a
  // millisecond and the scale factor is in the thousands, so "WCL 1ms" next to
  // a 10 s turn reads as a contradiction unless the multiplication is on screen.
  const source = fixed != null
    ? `pinned ${fixed}s`
    : `${metric.toUpperCase()} ${preciseMs(wc[metric] ?? 0)}`;
  return `${scopeTag('global')} Current turn length: <b>${seconds.toFixed(3)}s</b> ` +
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
      <div class="ts-meta" title="WCL is worst-case one-way MOUTH-TO-EAR latency: both network legs + the measured de-jitter buffer + a fixed ${PIPELINE_ALLOWANCE_MS}ms encode/decode/device allowance. WCJ is worst-case RTP inter-arrival jitter on the media path. WCRTT is the worst measured round trip across the roster.">${scopeTag('global')} WCL <b>${preciseMs(wc.wcl)}</b> · WCJ <b>${preciseMs(wc.wcj)}</b> · WCRTT <b>${preciseMs(wc.wcrtt)}</b> · WCPL <b>${(wc.wcpl * 100).toFixed(1)}%</b>
        <span title="peers contributing samples">(${wc.sampleCount})</span></div>
      <div class="ts-meta">${cycleLengthReadout(wc)}</div>
    `;
  } catch (e) {
    console.error('[studio] network metrics block failed to render', e);
    body.innerHTML = `<div class="ts-meta">unavailable &mdash; ${escapeHtml(String((e && e.message) || e))}</div>`;
  }
}

subscribeFleetStatus((status) => {
  // The Bot Cluster panel that used to show this is gone (its actions moved
  // into botConfig({ spawn / remove / mute / camera / … })). Surface fleet
  // feedback — spawn counts, what the fleet made of a botConfig, a rejected
  // config, a teardown — on the shared status line instead.
  let line = '';
  if (status.action === 'spawn') {
    line = `spawned ${status.spawned}/${status.requested} for ${status.ownerIndex}` +
      (status.botConfig ? ` — ${status.botConfig}` : '') +
      (status.reason ? ` — ${status.reason}` : '');
  } else if (status.action === 'remove') {
    line = `removed ${status.removed} (${status.ownerIndex})${status.reason ? ` — ${status.reason}` : ''}`;
  } else if (status.action === 'config-error') {
    // A botConfig() typo on a retroactive-or-not edit — see
    // fleet-service.js's #handlePerformerEdit. Without this the edit just
    // silently fails to apply, indistinguishable from "reverted".
    line = `botConfig rejected (${status.ownerIndex}) — ${status.reason || 'invalid config'}`;
  } else if (status.action === 'teardown') {
    line = `fleet teardown — ${status.reason || ''}`;
    // The cluster is gone; let the same botConfig({ spawn: n }) rebuild it on
    // the next eval instead of being deduped away as "already done".
    resetBotClusterDirectives();
  }
  if (line) setStatus(line);
});

function createThemePickerSection() {
  const el = document.createElement('div');
  el.className = 'ts-section ts-theme-section';
  const t = getTheme();
  const check = (key, label) =>
    `<label class="ts-theme-check"><input type="checkbox" data-theme="${key}"${t[key] ? ' checked' : ''}> ${label}</label>`;
  const fontOptions = WEB_SAFE_FONTS.map((f) =>
    `<option value="${escapeHtml(f.value)}"${f.value === t.font ? ' selected' : ''}>${escapeHtml(f.label)}</option>`
  ).join('');
  el.innerHTML = `
    <div class="ts-section-head">
      <div class="ts-section-title">Personal Theme</div>
      <div class="ts-section-controls">
        <button class="ts-btn play ts-dwell-btn" data-action="apply-theme">Apply</button>
      </div>
    </div>
    <div class="ts-theme-checks">
      ${check('darkMode', 'Dark mode')}
      ${check('disableCss', 'Disable CSS changes')}
      ${check('invert', 'Invert')}
    </div>
    <div class="ts-theme-fields">
      <label class="ts-theme-field">Primary color:
        <input type="text" class="ts-theme-color" data-theme="primary" spellcheck="false"
          autocapitalize="off" placeholder="${DEFAULT_PRIMARY}" value="${escapeHtml(t.primary)}">
      </label>
      <label class="ts-theme-field">Secondary color:
        <input type="text" class="ts-theme-color" data-theme="secondary" spellcheck="false"
          autocapitalize="off" placeholder="${DEFAULT_SECONDARY}" value="${escapeHtml(t.secondary)}">
      </label>
      <label class="ts-theme-field">Font:
        <select class="ts-theme-font" data-theme="font">${fontOptions}</select>
      </label>
      <label class="ts-theme-field">Font scale:
        <input type="number" class="ts-theme-scale" data-theme="fontScale"
          min="${MIN_FONT_SCALE}" max="${MAX_FONT_SCALE}" step="0.1" inputmode="decimal"
          value="${escapeHtml(String(t.fontScale))}">
      </label>
    </div>
    <div class="ts-meta ts-theme-status"></div>
  `;

  const statusEl = el.querySelector('.ts-theme-status');
  el.querySelector('[data-action="apply-theme"]').addEventListener('click', () => {
    const patch = {};
    el.querySelectorAll('[data-theme]').forEach((node) => {
      patch[node.dataset.theme] = node.type === 'checkbox' ? node.checked : node.value.trim();
    });
    for (const field of ['primary', 'secondary']) {
      if (patch[field] && !isHexColor(patch[field])) {
        statusEl.textContent = `${field} colour must be a 3- or 6-digit hex like #1a1a1a`;
        return;
      }
    }
    // Empty means "back to the authored size" (handled as the default on apply);
    // a filled field has to be a number in range.
    if (patch.fontScale && !isFontScale(patch.fontScale)) {
      statusEl.textContent = `font scale must be a number from ${MIN_FONT_SCALE} to ${MAX_FONT_SCALE} (e.g. 2 = twice as large)`;
      return;
    }
    setTheme(patch);
    statusEl.textContent = 'Theme applied — this browser only';
  });
  return el;
}

function resolveSelectedPeer() {
  let peer = getPeerByJitsiId(selectedJitsiId);
  if (!peer && selectedPeerKey && selectedPeerKey !== 'local') {
    peer = getAllPeers().find(p => p.peerId === selectedPeerKey) || null;
    if (peer) selectedJitsiId = peer.jitsiId;
  }
  return peer;
}

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
  selectedPeerKey = isLocal ? 'local' : (peer.peerId || null);
  const peerKey = isLocal ? 'local' : String(peer.peerId || peer.jitsiId || '');

  if (container.dataset.peerKey !== peerKey) {
    const prevCodeEl = container.querySelector('.ts-code');
    const samePeer = !isLocal && container.dataset.jitsiId === (peer.jitsiId || '');
    const unsent = (samePeer && prevCodeEl && document.activeElement === prevCodeEl
      && prevCodeEl.value !== prevCodeEl.dataset.lastSynced)
      ? { value: prevCodeEl.value, selStart: prevCodeEl.selectionStart, selEnd: prevCodeEl.selectionEnd }
      : null;
    buildDetailShell(container, peer, peerKey, isLocal);
    container.dataset.jitsiId = peer.jitsiId || '';
    if (unsent) {
      const codeEl = container.querySelector('.ts-code');
      codeEl.value = unsent.value;
      codeEl.focus();
      codeEl.setSelectionRange(unsent.selStart, unsent.selEnd);
    }
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

  if (isLocal) container.appendChild(createThemePickerSection());

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
  const controls = isLocal
    ? `
      <div class="ts-section-controls">
        <button class="ts-btn play" data-action="play">Play</button>
        <button class="ts-btn stop" data-action="stop">Stop</button>
        <button class="ts-btn ghost" data-action="load-samples" title="Load a folder of audio files (and any JSON/CSV/TSV inside it) into Strudel">Samples</button>
        <input type="file" class="ts-samples-input" webkitdirectory style="display:none">
        <button class="ts-btn ghost" data-action="load-data" title="Load JSON/CSV/TSV files as data packs — reference a column as &quot;Name:3&quot;">Data</button>
        <input type="file" class="ts-data-input" accept=".json,.csv,.tsv" multiple style="display:none">
        <button class="ts-btn ghost" data-action="load-files" title="Load images/video/audio/pdf/txt (10MB each) to reference from image()/video()/textFile()/pdfFile()/soundFile()">Files</button>
        <input type="file" class="ts-files-input" accept=".gif,.jpeg,.jpg,.png,.svg,.bmp,.mp4,.m4a,.mov,.txt,.pdf,.wav,.mp3,.ogg" multiple style="display:none">
        <span class="ts-shortcuts">Ctrl+Enter to eval · Ctrl+. to stop · Ctrl+/ to comment</span>
      </div>`
    : `
      <div class="ts-section-controls">
        <button class="ts-btn eval" data-action="remote-eval">Eval</button>
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
    const wireUpload = (buttonSelector, inputSelector, uploadFn, onResult) => {
      const button = el.querySelector(buttonSelector);
      const input = el.querySelector(inputSelector);
      if (!button || !input) return;
      button.addEventListener('click', () => { uploadPending = true; input.click(); });
      input.addEventListener('cancel', () => { uploadPending = false; });
      input.addEventListener('change', async () => {
        try {
          const files = input.files;
          if (!files || !files.length) return;
          setStatus('Loading…');
          await uploadFn(files, onResult);
          input.value = '';
        } finally {
          uploadPending = false;
        }
      });
    };
    const onSamplesLoaded = async ({ audio, images, packs, errors }) => {
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
    };
    wireUpload('[data-action="load-samples"]', '.ts-samples-input', uploadSamplesToDB, onSamplesLoaded);
    wireUpload('[data-action="load-data"]', '.ts-data-input', uploadSamplesToDB, onSamplesLoaded);
    wireUpload('[data-action="load-files"]', '.ts-files-input', uploadChatFilesToDB, ({ count, errors }) => {
      if (!count) {
        setStatus(errors.length ? errors[0] : 'No supported files found');
        return;
      }
      setStatus(`Loaded ${count} file${count === 1 ? '' : 's'}`
        + ' — use image()/video()/textFile()/pdfFile()/soundFile() in patterns'
        + (errors.length ? ` (${errors.length} rejected)` : ''));
    });

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

  updateMetricsSection(container.querySelector('.ts-metrics-section'), peer, '');

  // The Personal Theme card is user-driven (Apply) and reads its values from
  // the store at build time — nothing to patch per tick.

  patchLocalProgramSection(container.querySelector('.ts-local-program-section'), peer, isLocal);

  const status = isLocal ? lastStatus : (peer.muted ? 'Muted' : (peer.playing ? 'Playing' : 'Idle'));
  container.querySelector('.ts-status').textContent = status;
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
  muteBtnEl.textContent = peer.muted ? 'Muted' : 'Mute';
  muteBtnEl.classList.toggle('on', !!peer.muted);

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
        b.truncated ? ' — truncated to fit the memory budget' : ''}">${label}${b.truncated ? ' (truncated)' : ''}</button>`;
  };
  const openBank = sampleBanks.find(b => b.name === expandedBank);
  const sampleList = openBank ? `
    <div class="ts-sample-list">
      ${openBank.samples.map((s, i) => `
        <span class="ts-sample-item">
          <span class="ts-sample-idx">${openBank.kind === 'audio' ? i : i + 1}</span>
          <span class="ts-sample-label"${s.preview ? ` title="${escapeHtml(s.preview)}"` : ''}>${escapeHtml(s.label)}</span>
          ${s.length != null ? `<span class="ts-sample-len">${s.length}${s.truncated ? ' (truncated)' : ''}</span>` : ''}
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
        ? "Add 'personal editor' as the first line of your editor"
        : `This editor opens with '${dir.phrase}', not 'personal editor'`);
      return;
    }
    if (detectNotation(stripDirective(code)) === 'mixed') {
      setStatus('This buffer mixes mini ($: … .method(…)) and mondo ($ … / # …) — write it in one or the other');
      return;
    }
  }
  setStatus('Starting…');
  try {
    await bootAudioEngine();
    if (typeof code === 'string') {
      sendLocalPattern(code);
      try {
        applyBotClusterDirectives(code);
      } catch (e) {
        console.error('[studio] botConfig cluster directives failed', e);
      }
    }
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

async function onCaptureClick() {
  const local = getLocalPeer();
  if (!local || !local.jitsiId) return;
  if (getExternalStreamLabel(local.jitsiId)) {
    // Detach order matters: stop propagating to the room first (restores the
    // original outgoing mic track) THEN tear down the local chain hookup, so
    // Jitsi never sees a stopped track on the wire.
    await stopPropagatingExternalStream();
    detachExternalStreamForPeer(local.jitsiId);
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

    const audioConstraints = {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    await attachExternalStreamForPeer(local.jitsiId, stream, label, { monitorLocally: false });
    const propagated = await propagateExternalStreamToRoom(stream);
    setStatus(propagated ? `Capturing ${label} → room` : `Capturing ${label} (local only — no Jitsi mic hook)`);
    renderAll();
  } catch (e) {
    console.error('[studio] capture failed', e);
    setStatus('Capture failed: ' + (e && e.message ? e.message : e));
  }
}

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
    <div class="ts-jpattern" style="padding: 0 14px; display:flex; flex-direction:column; gap:12px;">
    </div>
    <div class="ts-detail"></div>
  `;
  document.body.appendChild(overlay);

  // Unconditional and independent of the metaprogram/moderator state above —
  // see panic-button.js for why this is a full rejoin rather than an
  // in-place room switch.
  overlay.querySelector('.ts-panic-btn').addEventListener('click', panicToMainRoom);

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