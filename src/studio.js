// Unified Trussal Studio UI.
//
// One toggleable overlay surfaces a participant strip + a detail panel split
// into a Latency Effects card and a Strudel card. Every participant gets a
// chip with effect indicators, play state, and an "audio routed" dot — making
// it obvious that each person owns their own chain and editor.

import { getRoomNameFromUrl } from './jamulus.js';
import {
  subscribeParticipants,
  getLocalParticipant,
  getRemoteParticipants
} from './participants.js';
import {
  subscribePeerState,
  getAllPeers,
  getPeerByJitsiId,
  getLocalPeer,
  sendLocalPattern,
  sendLocalEffects,
  sendLocalPlaying,
} from './peer-state.js';
import { bootStrudelOnUserGesture, stopStrudel, refreshLocalSamples, rebakeStrudel, DEFAULT_PATTERN, updateSliderValue } from './strudel.js';
import { uploadSamplesToDB, getSampleBanks, clearSamplesDB } from './user-samples.js';
import { injectFacialGestureToggle, refreshFacialGestureButtons, toggleButtonCode } from './facial-gesture.js';
import { injectHydraVideoToggle, MODE_SPLIT, MODE_DIRECT, setMode as setHydraVideoMode, getMode as getHydraVideoMode } from './hydra-video.js';
import { tickKbdUi } from './on-screen-keyboard.js';
import {
  bootAudioEngine,
  subscribeAudioRouting,
  isAudioRoutedFor,
  attachExternalStreamForPeer,
  detachExternalStreamForPeer,
  getExternalStreamLabel,
  listAudioInputDevices,
  propagateExternalStreamToRoom,
  stopPropagatingExternalStream,
  isPropagatingToRoom
} from './latency-instrument.js';

const BUTTON_ID  = 'trussal-studio-toggle';
const OVERLAY_ID = 'trussal-studio-overlay';
const STYLE_ID   = 'trussal-studio-style';
const STORAGE_KEY = 'trussal.studio.pattern';

let selectedJitsiId = null;
let initedRoom = null;
let codeDebounce = null;
let lastStatus = 'Idle';
let routedSet = new Set();
let sampleBanks = []; // [{name, count}] — kept in sync after every load/delete
let currentSliders = []; // most recent slider configs from strudel eval

async function refreshSampleBanks() {
  sampleBanks = await getSampleBanks().catch(() => []);
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

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed; right: 16px; bottom: 88px;
      width: min(640px, 92vw); max-height: 78vh;
      background: rgba(8, 14, 12, 0.96);
      color: #d6f5e2;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      z-index: 999999;
      font-family: sans-serif;
      display: flex; flex-direction: column;
      box-shadow: 0 16px 40px rgba(0,0,0,0.5);
    }
    #${OVERLAY_ID} .ts-header {
      display:flex; align-items:center; justify-content:space-between;
      padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #${OVERLAY_ID} .ts-title { font-weight: 600; color:#1ff466; letter-spacing: 0.5px; font-size: 0.95rem; }
    #${OVERLAY_ID} .ts-title small { color:#7aa68a; font-weight: 400; margin-left:8px; }
    #${OVERLAY_ID} .ts-close { border:none; background:transparent; color:#fff; font-size: 1.1rem; cursor:pointer; }
    #${OVERLAY_ID} .ts-collapse-btn { margin-left: auto; }
    #${OVERLAY_ID} .ts-strip {
      display:flex; gap:8px; padding: 10px 12px;
      overflow-x:auto; overflow-y:hidden;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      scrollbar-width: thin;
    }
    #${OVERLAY_ID} .ts-chip {
      flex: 0 0 auto;
      display:flex; flex-direction:column; align-items:stretch; gap:4px;
      min-width: 104px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      font-family: inherit; color: inherit;
      text-align: left;
    }
    #${OVERLAY_ID} .ts-chip:hover { background: rgba(255,255,255,0.07); }
    #${OVERLAY_ID} .ts-chip.selected {
      border-color: var(--ts-chip-color, #1ff466);
      background: rgba(31,244,102,0.08);
    }
    #${OVERLAY_ID} .ts-chip-row { display:flex; align-items:center; gap:8px; }
    #${OVERLAY_ID} .ts-avatar {
      width: 24px; height: 24px; border-radius: 50%;
      background: var(--ts-chip-color, #1ff466);
      color: #050f0a; font-weight: 700; font-size: 12px;
      display:flex; align-items:center; justify-content:center; flex-shrink: 0;
    }
    #${OVERLAY_ID} .ts-name { font-size: 12px; min-width: 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 84px; }
    #${OVERLAY_ID} .ts-name.you { color: #1ff466; font-weight: 600; }
    #${OVERLAY_ID} .ts-routed {
      font-size: 10px; padding: 1px 4px; border-radius: 3px;
      background: rgba(255,255,255,0.06); color: #5d7264;
    }
    #${OVERLAY_ID} .ts-routed.on { background: rgba(255,140,40,0.18); color: #ffac6b; }
    #${OVERLAY_ID} .ts-indicators { display:flex; gap:4px; font-family: monospace; font-size: 10px; align-items:center; }
    #${OVERLAY_ID} .ts-ind {
      padding: 1px 5px; border-radius: 3px;
      background: rgba(255,255,255,0.05); color: #5d7264;
      letter-spacing: 0.5px;
    }
    #${OVERLAY_ID} .ts-ind.on { background: rgba(31,244,102,0.2); color: #1ff466; }
    #${OVERLAY_ID} .ts-play { font-size: 10px; color: #5d7264; }
    #${OVERLAY_ID} .ts-play.on { color: #1ff466; }

    #${OVERLAY_ID} .ts-detail {
      padding: 12px 14px; display:flex; flex-direction:column; gap:12px;
      overflow-y:auto; min-height: 0;
    }
    #${OVERLAY_ID} .ts-detail-header { display:flex; align-items:center; gap:8px; }
    #${OVERLAY_ID} .ts-detail-name { font-weight: 600; color: var(--ts-detail-color, #1ff466); font-size: 0.95rem; }
    #${OVERLAY_ID} .ts-readonly-badge {
      font-size: 10px; padding: 2px 6px; border-radius: 3px;
      background: rgba(255,255,255,0.08); color: #b9d1c1; letter-spacing: 0.5px;
    }
    #${OVERLAY_ID} .ts-section {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      background: rgba(255,255,255,0.02);
      padding: 10px 12px;
      display: flex; flex-direction: column; gap: 8px;
    }
    #${OVERLAY_ID} .ts-section-head {
      display:flex; align-items:center; justify-content:space-between;
      gap: 8px;
    }
    #${OVERLAY_ID} .ts-section-title {
      font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
      color: #7aa68a; font-weight: 600;
    }
    #${OVERLAY_ID} .ts-section-controls { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    #${OVERLAY_ID} .ts-btn {
      padding: 4px 10px; border-radius: 999px; border:none; cursor:pointer;
      font-weight: 600; font-size: 12px;
    }
    #${OVERLAY_ID} .ts-btn.play  { background: #1ff466; color: #050f0a; }
    #${OVERLAY_ID} .ts-btn.stop  { background: #2a2a2a; color: #fff; }
    #${OVERLAY_ID} .ts-btn.ghost { background: rgba(255,255,255,0.08); color: #d6f5e2; }
    #${OVERLAY_ID} .ts-btn.ghost.on { background: rgba(255,140,40,0.2); color: #ffac6b; }
    #${OVERLAY_ID} .ts-fx { display:flex; gap:6px; flex-wrap:wrap; align-items:center; font-size: 12px; color: #b9d1c1; }
    #${OVERLAY_ID} .ts-fx-btn {
      padding:3px 10px; border-radius:999px;
      border:1px solid rgba(255,255,255,0.15); background:transparent; color:#7aa68a;
      font-size:11px; cursor:pointer;
      transition:border-color 0.15s, color 0.15s, background 0.15s;
    }
    #${OVERLAY_ID} .ts-fx-btn:hover { color:#d6f5e2; border-color:rgba(255,255,255,0.3); }
    #${OVERLAY_ID} .ts-fx-btn.on { color:#1ff466; border-color:rgba(31,244,102,0.4); background:rgba(31,244,102,0.08); }
    #${OVERLAY_ID} .ts-fx-btn.strudel-dwell-hover { border-color:#ffcc00; color:#ffcc00; }
    #${OVERLAY_ID} .ts-fx-btn.strudel-btn-active  { border-color:#68d391; color:#68d391; }
    #${OVERLAY_ID} .ts-hv-mode-btn {
      padding:2px 8px; border-radius:999px;
      border:1px solid rgba(255,255,255,0.12); background:transparent; color:#5d7264;
      font-size:10px; cursor:pointer;
      transition:border-color 0.15s, color 0.15s, background 0.15s;
    }
    #${OVERLAY_ID} .ts-hv-mode-btn:hover { color:#d6f5e2; }
    #${OVERLAY_ID} .ts-hv-mode-btn.on { color:#7dcfff; border-color:rgba(125,207,255,0.4); background:rgba(125,207,255,0.08); }
    #${OVERLAY_ID} .ts-meta { font-size: 11px; font-family: monospace; color: #7aa68a; }
    #${OVERLAY_ID} .ts-meta b { color: #b9d1c1; font-weight: 600; }
    #${OVERLAY_ID} .ts-shortcuts { font-size: 11px; color: #5d7264; font-family: monospace; }
    #${OVERLAY_ID} .ts-code, #${OVERLAY_ID} .ts-pre {
      background: #050f0a; color:#1ff466;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;
      padding: 8px; box-sizing: border-box;
      min-height: 160px; max-height: 280px;
      width: 100%; resize: vertical;
      white-space: pre-wrap; overflow:auto;
    }
    #${OVERLAY_ID} .ts-code:focus { outline: 1px solid rgba(31,244,102,0.5); }
    @keyframes ts-eval-pulse {
      0%   { box-shadow: 0 0 0 3px rgba(31,244,102,0.85); }
      100% { box-shadow: 0 0 0 0   rgba(31,244,102,0); }
    }
    #${OVERLAY_ID} .ts-code.ts-eval-flash {
      animation: ts-eval-pulse 0.55s ease-out forwards;
    }
    #${OVERLAY_ID} .ts-status { font-size: 11px; font-family: monospace; color: #7aa68a; }
    #${OVERLAY_ID} select.ts-select {
      background: #050f0a; color: #d6f5e2;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 4px; padding: 3px 6px; font-size: 11px;
      max-width: 220px;
    }

    #${OVERLAY_ID} .ts-voice-btns {
      display: flex; flex-wrap: wrap; gap: 4px; min-height: 0;
    }
    #${OVERLAY_ID} .ts-voice-btn {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.15);
      background: transparent; color: #7aa68a;
      font-size: 11px; font-family: monospace; cursor: pointer;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
    }
    #${OVERLAY_ID} .ts-voice-btn:hover { color: #d6f5e2; border-color: rgba(255,255,255,0.3); }
    #${OVERLAY_ID} .ts-voice-btn.on { color: #1ff466; border-color: rgba(31,244,102,0.4); background: rgba(31,244,102,0.08); }

    #${OVERLAY_ID} .ts-sample-banks {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      font-size: 11px; font-family: monospace;
    }
    #${OVERLAY_ID} .ts-sample-bank {
      padding: 1px 7px; border-radius: 3px;
      background: rgba(31,244,102,0.1); color: #1ff466;
      border: 1px solid rgba(31,244,102,0.25);
      white-space: nowrap;
    }
    #${OVERLAY_ID} .ts-sample-banks-del {
      margin-left: auto; padding: 1px 8px; border-radius: 3px; border: none; cursor: pointer;
      background: rgba(255,80,80,0.12); color: #ff7070; font-size: 11px; font-family: monospace;
    }
    #${OVERLAY_ID} .ts-sample-banks-del:hover { background: rgba(255,80,80,0.22); }

    #${OVERLAY_ID} .ts-sliders {
      display: flex; flex-wrap: wrap; gap: 10px 16px;
    }
    #${OVERLAY_ID} .ts-slider-row {
      display: flex; flex-direction: column; gap: 3px;
      min-width: 100px; flex: 1 1 100px;
    }
    #${OVERLAY_ID} .ts-slider-label {
      font-size: 10px; font-family: monospace; color: #7aa68a;
      display: flex; justify-content: space-between; gap: 6px;
    }
    #${OVERLAY_ID} .ts-slider-input {
      width: 100%; cursor: pointer; accent-color: #1ff466;
      height: 16px;
    }

    #hydra-canvas {
      z-index: 100;
    }

    #${BUTTON_ID} {
      position: fixed; bottom: 80px; right: 20px;
      z-index: 9999;
      padding: 0.5rem 0.9rem;
      border-radius: 999px;
      border: none;
      background: #1ff466;
      color: #050f0a;
      font-weight: 600;
      cursor: pointer;
      display: none;
    }
  `;
  document.head.appendChild(style);
}

function chipColor(jitsiId, isLocal) {
  return isLocal ? '#1ff466' : `hsl(${hueFor(jitsiId)}, 60%, 60%)`;
}

function renderChip(peer, selected) {
  const isLocal = !!peer.isLocal;
  const color = chipColor(peer.jitsiId, isLocal);
  const e = peer.effects || {};
  const routed = routedSet.has(peer.jitsiId);
  return `
    <button class="ts-chip${selected ? ' selected' : ''}" data-jid="${peer.jitsiId || ''}" style="--ts-chip-color:${color};">
      <div class="ts-chip-row">
        <div class="ts-avatar">${initial(peer.displayName)}</div>
        <div class="ts-name${isLocal ? ' you' : ''}">${isLocal ? 'You' : escapeHtml(peer.displayName || 'Participant')}</div>
      </div>
      <div class="ts-indicators">
        <span class="ts-ind${e.distortion ? ' on' : ''}">D</span>
        <span class="ts-ind${e.noise ? ' on' : ''}">N</span>
        <span class="ts-ind${e.reverb ? ' on' : ''}">R</span>
        <span class="ts-play${peer.playing ? ' on' : ''}">${peer.playing ? '▶' : '■'}</span>
        <span class="ts-routed${routed ? ' on' : ''}" title="${routed ? 'Audio routed through chain' : 'No live audio source'}">🎙</span>
      </div>
    </button>
  `;
}

function renderStrip(container) {
  const peers = getAllPeers();
  container.innerHTML = peers.map(p => renderChip(p, p.jitsiId === selectedJitsiId)).join('');
  container.querySelectorAll('.ts-chip').forEach(el => {
    el.addEventListener('click', () => {
      const jid = el.getAttribute('data-jid');
      if (!jid) return;
      selectedJitsiId = jid;
      renderAll();
    });
  });
}

function effectsBlock(peer, isLocal) {
  const e = peer.effects || {};
  const hvMode = getHydraVideoMode();
  if (isLocal) {
    return `
      <div class="ts-fx">
        <button class="ts-fx-btn ts-fx-dwell-btn${e.distortion ? ' on' : ''}" data-fx="distortion">Distortion</button>
        <button class="ts-fx-btn ts-fx-dwell-btn${e.noise      ? ' on' : ''}" data-fx="noise">Noise</button>
        <button class="ts-fx-btn ts-fx-dwell-btn${e.reverb     ? ' on' : ''}" data-fx="reverb">Reverb</button>
      </div>
      <div class="ts-fx" style="margin-top:4px;">
        <span style="font-size:10px;color:#5d7264;">video mode:</span>
        <button class="ts-hv-mode-btn${hvMode === MODE_SPLIT  ? ' on' : ''}" data-hv-mode="${MODE_SPLIT}">split</button>
        <button class="ts-hv-mode-btn${hvMode === MODE_DIRECT ? ' on' : ''}" data-hv-mode="${MODE_DIRECT}">→ s0</button>
      </div>`;
  }
  return `
    <div class="ts-fx">
      <span class="ts-ind${e.distortion ? ' on' : ''}">Distortion</span>
      <span class="ts-ind${e.noise ? ' on' : ''}">Noise</span>
      <span class="ts-ind${e.reverb ? ' on' : ''}">Reverb</span>
    </div>`;
}

function metricsLine(peer) {
  const rtt = typeof peer.rtt === 'number' ? `${peer.rtt.toFixed(0)}ms` : '–';
  const jitter = typeof peer.jitter === 'number' ? peer.jitter.toFixed(2) : '–';
  const extLabel = getExternalStreamLabel(peer.jitsiId);
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
  return `<div class="ts-meta">RTT <b>${rtt}</b> · jitter <b>${jitter}</b> · ${routedTxt}</div>`;
}

function renderDetail(container) {
  let peer = getPeerByJitsiId(selectedJitsiId);
  if (!peer) {
    const local = getLocalPeer();
    if (local && local.jitsiId) {
      selectedJitsiId = local.jitsiId;
      peer = local;
    }
  }
  if (!peer) {
    container.innerHTML = `<div class="ts-meta">Waiting for participant data…</div>`;
    return;
  }

  const isLocal = !!peer.isLocal;
  const color = chipColor(peer.jitsiId, isLocal);
  container.style.setProperty('--ts-detail-color', color);

  const extLabel = getExternalStreamLabel(peer.jitsiId);
  const captureBtn = isLocal
    ? `<button class="ts-btn ghost${extLabel ? ' on' : ''}" data-action="capture">${extLabel ? '⏏ Detach input' : '🎙 Capture extra input'}</button>`
    : '';

  const codeBlock = isLocal
    ? `<textarea class="ts-code" spellcheck="false">${escapeHtml(peer.pattern || '')}</textarea>`
    : `<pre class="ts-pre">${escapeHtml(peer.pattern || '/* (no pattern yet) */')}</pre>`;

  const strudelControls = isLocal
    ? `
      <div class="ts-section-controls">
        <button class="ts-btn play" data-action="play">▶ Play</button>
        <button class="ts-btn stop" data-action="stop">■ Stop</button>
        <button class="ts-btn ghost" data-action="load-samples" title="Load a folder of audio files into Strudel">⬆ Samples</button>
        <input type="file" class="ts-samples-input" webkitdirectory style="display:none">
        <span class="ts-shortcuts">Ctrl+Enter to eval · Ctrl+. to stop</span>
      </div>`
    : `<div class="ts-section-controls"><span class="ts-readonly-badge">READ ONLY</span></div>`;

  const playing = peer.playing ? 'Playing' : 'Idle';
  const status = isLocal ? lastStatus : playing;

  const sampleBanksRow = isLocal && sampleBanks.length > 0 ? `
    <div class="ts-sample-banks">
      ${sampleBanks.map(b => `<span class="ts-sample-bank">${escapeHtml(b.name)} (${b.count})</span>`).join('')}
      <button class="ts-sample-banks-del" data-action="delete-samples">× delete all user samples</button>
    </div>` : '';

  container.innerHTML = `
    <div class="ts-detail-header">
      <div class="ts-detail-name">${isLocal ? 'You' : escapeHtml(peer.displayName || 'Participant')}</div>
      ${isLocal ? '' : '<span class="ts-readonly-badge">READ ONLY</span>'}
    </div>

    <div class="ts-section">
      <div class="ts-section-head">
        <div class="ts-section-title">Latency Effects</div>
        <div class="ts-section-controls">${captureBtn}</div>
      </div>
      ${effectsBlock(peer, isLocal)}
      ${metricsLine(peer)}
    </div>

    <div class="ts-section">
      <div class="ts-section-head">
        <div class="ts-section-title">Strudel</div>
        ${strudelControls}
      </div>
      ${sampleBanksRow}
      ${codeBlock}
      ${isLocal ? '<div class="ts-sliders"></div>' : ''}
      ${isLocal ? '<div class="ts-voice-btns"></div>' : ''}
    </div>

    <div class="ts-status">${escapeHtml(status)}</div>
  `;

  if (!isLocal) return;

  const codeEl = container.querySelector('.ts-code');
  if (codeEl) {
    codeEl.addEventListener('input', () => {
      clearTimeout(codeDebounce);
      codeDebounce = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, codeEl.value); } catch (e) {}
      }, 200);
      renderVoiceButtons(container, codeEl.value);
    });
    codeEl.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key === 'Enter') {
        e.preventDefault();
        onEvalAndPlay(codeEl.value);
      } else if (meta && e.key === '.') {
        e.preventDefault();
        onStopClick();
      }
    });
  }
  container.querySelectorAll('.ts-fx-dwell-btn[data-fx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const peer = getPeerByJitsiId(selectedJitsiId);
      const e = peer?.effects || {};
      const fx = btn.dataset.fx;
      sendLocalEffects({ distortion: !!e.distortion, noise: !!e.noise, reverb: !!e.reverb, [fx]: !e[fx] });
    });
  });
  container.querySelectorAll('.ts-hv-mode-btn[data-hv-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      setHydraVideoMode(btn.dataset.hvMode);
      // Re-render to reflect new mode button state without full renderAll.
      container.querySelectorAll('.ts-hv-mode-btn').forEach(b => {
        b.classList.toggle('on', b.dataset.hvMode === getHydraVideoMode());
      });
    });
  });
  const playBtn = container.querySelector('[data-action="play"]');
  if (playBtn) playBtn.addEventListener('click', () => {
    const code = container.querySelector('.ts-code');
    onEvalAndPlay(code ? code.value : peer.pattern || '');
  });
  const stopBtn = container.querySelector('[data-action="stop"]');
  if (stopBtn) stopBtn.addEventListener('click', onStopClick);
  const captureBtnEl = container.querySelector('[data-action="capture"]');
  if (captureBtnEl) captureBtnEl.addEventListener('click', onCaptureClick);

  const loadSamplesBtn = container.querySelector('[data-action="load-samples"]');
  const samplesInput = container.querySelector('.ts-samples-input');
  if (loadSamplesBtn && samplesInput) {
    loadSamplesBtn.addEventListener('click', () => samplesInput.click());
    samplesInput.addEventListener('change', async () => {
      const files = samplesInput.files;
      if (!files || !files.length) return;
      setStatus('Loading samples…');
      await uploadSamplesToDB(files, async (count) => {
        if (count === 0) { setStatus('No audio files found'); return; }
        await refreshLocalSamples();
        await refreshSampleBanks();
        setStatus(`Loaded ${count} sample${count === 1 ? '' : 's'} — use s("foldername") in patterns`);
      });
      samplesInput.value = '';
    });
  }

  const deleteBtn = container.querySelector('[data-action="delete-samples"]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!window.confirm('Delete all imported user samples?')) return;
      setStatus('Deleting samples…');
      await clearSamplesDB();
      sampleBanks = [];
      await rebakeStrudel();
      setStatus('User samples deleted');
      renderAll();
    });
  }
}

async function onEvalAndPlay(code) {
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
// Jamulus output) and route it through TWO places at once:
//   1. The local user's effects chain → self-monitoring through the local
//      speakers.
//   2. The outgoing Jitsi mic via an audio mixing effect → every other peer
//      receives it as part of our mic stream and renders it through OUR
//      per-peer chain on their side, so the room hears the processed signal.
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
    await attachExternalStreamForPeer(local.jitsiId, stream, label);
    const propagated = await propagateExternalStreamToRoom(stream);
    setStatus(propagated ? `Capturing ${label} → room` : `Capturing ${label} (local only — no Jitsi mic hook)`);
    renderAll();
  } catch (e) {
    console.error('[studio] capture failed', e);
    setStatus('Capture failed: ' + (e && e.message ? e.message : e));
  }
}

const BTN_MARKER = ' // strudel-btn';

function parseVoiceButtons(code) {
  const buttons = [];
  const re = /^\*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(.+)$/mg;
  let m;
  while ((m = re.exec(code)) !== null) {
    const voiceCode = `${m[1]}: ${m[2].trim()}`;
    const isActive = code.includes(`\n${voiceCode}${BTN_MARKER}`);
    buttons.push({ name: m[1], voiceCode, isActive });
  }
  return buttons;
}

function renderVoiceButtons(container, code) {
  const area = container.querySelector('.ts-voice-btns');
  if (!area) return;
  const buttons = parseVoiceButtons(code);
  if (!buttons.length) { area.innerHTML = ''; return; }
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  area.innerHTML = buttons.map(b => {
    const label = b.name.length > 18 ? b.name.slice(0, 18) + '…' : b.name;
    return `<button class="ts-voice-btn${b.isActive ? ' on' : ''}" data-voice-code="${esc(b.voiceCode).replace(/"/g,'&quot;')}">▶ ${esc(label)}</button>`;
  }).join('');
  area.querySelectorAll('.ts-voice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleButtonCode(btn.dataset.voiceCode);
      const ta = document.querySelector(`#${OVERLAY_ID} .ts-code`);
      if (ta) renderVoiceButtons(container, ta.value);
    });
  });
}

function renderSliders(container, sliders) {
  const area = container.querySelector('.ts-sliders');
  if (!area) return;
  if (!sliders || !sliders.length) { area.innerHTML = ''; return; }
  area.innerHTML = sliders.map((s, i) => `
    <div class="ts-slider-row" data-slider-id="${escapeHtml(String(s.id))}">
      <div class="ts-slider-label">
        <span>slider ${i + 1}</span>
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
    if (detail) {
      const existingCodeEl = detail.querySelector('textarea.ts-code');
      const active = document.activeElement;
      const isCodeFocused = active && active === existingCodeEl;
      const codeValue = existingCodeEl ? existingCodeEl.value : null;
      const selStart = isCodeFocused ? active.selectionStart : null;
      const selEnd   = isCodeFocused ? active.selectionEnd   : null;
      const scrollTop = isCodeFocused ? active.scrollTop : null;

      renderDetail(detail);
      refreshFacialGestureButtons();

      const nextCodeEl = detail.querySelector('.ts-code');
      if (nextCodeEl && codeValue != null) {
        nextCodeEl.value = codeValue;
        if (isCodeFocused) {
          nextCodeEl.focus();
          if (selStart != null && selEnd != null) {
            try { nextCodeEl.setSelectionRange(selStart, selEnd); } catch (e) {}
          }
          if (scrollTop != null) nextCodeEl.scrollTop = scrollTop;
        }
      }

      if (nextCodeEl) renderVoiceButtons(detail, nextCodeEl.value);
      renderSliders(detail, currentSliders);
    }
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
    <div class="ts-detail"></div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.ts-close').addEventListener('click', () => {
    overlay.style.display = 'none';
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
    });
  }

  injectFacialGestureToggle(overlay.querySelector('.ts-header'));
  injectHydraVideoToggle(overlay.querySelector('.ts-header'));

  refreshSampleBanks();

  const localPeer = getLocalPeer();
  if (localPeer.jitsiId && !localPeer.pattern) {
    let seed = DEFAULT_PATTERN;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved.trim()) seed = saved;
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
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const overlay = ensureOverlay();
    if (!overlay) return;
    overlay.style.display = (overlay.style.display === 'none') ? 'flex' : 'none';
    if (overlay.style.display === 'flex') renderAll();
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
    initedRoom = null;
    return;
  }
  if (initedRoom !== room) {
    initedRoom = room;
    const local = getLocalParticipant();
    if (local && !selectedJitsiId) selectedJitsiId = local.id;
  }
  const btn = ensureToggle();
  if (btn) btn.style.display = 'block';

  tickKbdUi();
  bootAudioEngine().catch(e => console.warn('[studio] audio boot deferred', e));
}

// Keyboard module requests eval via this event.
document.addEventListener('trussal-kbd-eval', (e) => {
  const code = e.detail?.code;
  onEvalAndPlay(typeof code === 'string' ? code : (getLocalPeer()?.pattern ?? ''));
});

// Flash the code textarea border whenever an eval fires (from keyboard, gesture, or button).
document.addEventListener('trussal-eval', () => {
  const codeEl = document.querySelector(`#${OVERLAY_ID} .ts-code`);
  if (codeEl) {
    codeEl.classList.remove('ts-eval-flash');
    void codeEl.offsetWidth; // force reflow so the animation restarts each time
    codeEl.classList.add('ts-eval-flash');
  }
});

subscribeParticipants((event, payload) => {
  if (event === 'local' && payload && !selectedJitsiId) selectedJitsiId = payload.id;
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
