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
  sendLocalPlaying
} from './peer-state.js';
import { bootStrudelOnUserGesture, stopStrudel, DEFAULT_PATTERN } from './strudel.js';
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
    #${OVERLAY_ID} .ts-fx { display:flex; gap:10px; flex-wrap:wrap; font-size: 12px; color: #b9d1c1; }
    #${OVERLAY_ID} .ts-fx label { display:flex; align-items:center; gap:4px; cursor:pointer; }
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
    #${OVERLAY_ID} .ts-status { font-size: 11px; font-family: monospace; color: #7aa68a; }
    #${OVERLAY_ID} select.ts-select {
      background: #050f0a; color: #d6f5e2;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 4px; padding: 3px 6px; font-size: 11px;
      max-width: 220px;
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
  if (isLocal) {
    return `
      <div class="ts-fx">
        <label><input type="checkbox" data-fx="distortion" ${e.distortion ? 'checked' : ''}/> Distortion</label>
        <label><input type="checkbox" data-fx="noise"      ${e.noise      ? 'checked' : ''}/> Noise</label>
        <label><input type="checkbox" data-fx="reverb"     ${e.reverb     ? 'checked' : ''}/> Reverb</label>
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
        <span class="ts-shortcuts">Ctrl+Enter to eval · Ctrl+. to stop</span>
      </div>`
    : `<div class="ts-section-controls"><span class="ts-readonly-badge">READ ONLY</span></div>`;

  const playing = peer.playing ? 'Playing' : 'Idle';
  const status = isLocal ? lastStatus : playing;

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
      ${codeBlock}
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
        sendLocalPattern(codeEl.value);
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
      }
    });
  }
  container.querySelectorAll('input[type="checkbox"][data-fx]').forEach(cb => {
    cb.addEventListener('change', () => {
      sendLocalEffects({
        distortion: !!container.querySelector('input[data-fx="distortion"]').checked,
        noise:      !!container.querySelector('input[data-fx="noise"]').checked,
        reverb:     !!container.querySelector('input[data-fx="reverb"]').checked
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
}

async function onEvalAndPlay(code) {
  setStatus('Starting…');
  try {
    await bootAudioEngine();
    if (typeof code === 'string') sendLocalPattern(code);
    await bootStrudelOnUserGesture();
    sendLocalPlaying(true);
    setStatus('Playing');
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
      const active = document.activeElement;
      const isCodeFocused = active && active.classList && active.classList.contains('ts-code');
      const codeValue = isCodeFocused ? active.value : null;
      const selStart = isCodeFocused ? active.selectionStart : null;
      const selEnd   = isCodeFocused ? active.selectionEnd   : null;
      const scrollTop = isCodeFocused ? active.scrollTop : null;

      renderDetail(detail);

      if (isCodeFocused) {
        const next = detail.querySelector('.ts-code');
        if (next) {
          if (codeValue != null) next.value = codeValue;
          next.focus();
          if (selStart != null && selEnd != null) {
            try { next.setSelectionRange(selStart, selEnd); } catch (e) {}
          }
          if (scrollTop != null) next.scrollTop = scrollTop;
        }
      }
    }
  });
}

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
      <button class="ts-close" type="button">✕</button>
    </div>
    <div class="ts-strip"></div>
    <div class="ts-detail"></div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.ts-close').addEventListener('click', () => {
    overlay.style.display = 'none';
  });

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

  bootAudioEngine().catch(e => console.warn('[studio] audio boot deferred', e));
}

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
