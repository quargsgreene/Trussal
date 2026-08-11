import { bootAudioEngine, attachNodeToChain, detachNodeFromChain, setJamulusMode } from './latency-instrument.js';
import { getLocalPeer } from './peer-state.js';

export const JAMULUS_ROOM_MAP = {
  "0":  { host: "jamulus.trussal.com", port: 22000 },
  "1":  { host: "jamulus.trussal.com", port: 22001 },
  "2":  { host: "jamulus.trussal.com", port: 22002 },
  "3":  { host: "jamulus.trussal.com", port: 22003 },
  "4":  { host: "jamulus.trussal.com", port: 22004 },
  "5":  { host: "jamulus.trussal.com", port: 22005 },
  "6":  { host: "jamulus.trussal.com", port: 22006 },
  "7":  { host: "jamulus.trussal.com", port: 22007 },
  "8":  { host: "jamulus.trussal.com", port: 22008 },
  "9":  { host: "jamulus.trussal.com", port: 22009 },
  "10": { host: "jamulus.trussal.com", port: 22010 }
};

function addJamulusWelcomePanel() {
    const body = document.body;
    if (!body || !body.classList || !body.classList.contains('welcome-page')) {
      return;
    }

    if (document.getElementById('jamulus-welcome-panel')) return;

    const container =
      document.querySelector('#welcome_page .welcome-page-content') ||
      document.querySelector('.welcome-page-content');

    if (!container) return;

    const panel = document.createElement('div');
    panel.id = 'jamulus-welcome-panel';
    panel.className = 'jamulus-panel';

    const items = Object.entries(JAMULUS_ROOM_MAP)
      .map(([room, info]) =>
        `<li><strong>${room}</strong> → ${info.host}:${info.port}</li>`
      )
      .join('');

    panel.innerHTML = `
      <h3>Jamulus rooms</h3>
      <p>These meeting links have dedicated Jamulus servers:</p>
      <ul>${items}</ul>
    `;

    container.prepend(panel);
}

function startJamulusBannerPolling() {
    attachJamulusBanner();
    setInterval(attachJamulusBanner, 3000);
  }

function attachJamulusBanner() {
    const room = getRoomNameFromUrl();
    if (!room) return;

    const mapping = window.JAMULUS_ROOM_MAP || {};
    const entry = mapping[room];

    if (!entry) return;
    if (document.getElementById('jamulus-info-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'jamulus-info-banner';
    banner.textContent =
      `Jamulus: ${entry.host}:${entry.port} (for low-latency audio)`;

    Object.assign(banner.style, {
      position: 'absolute',
      bottom: '10px',
      right: '10px',
      zIndex: 9999,
      background: 'rgba(0, 0, 0, 0.7)',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '4px',
      fontFamily: 'sans-serif',
      fontSize: '12px'
    }); 
    document.body.appendChild(banner);
  }

function startJamulusWelcomePanel() {
  addJamulusWelcomePanel();
  }

// Lowercased because Jitsi's own XMPP layer lowercases the MUC room name
// regardless of URL casing — every sidecar/fleet consumer of this room string
// (peer-state.js's WS room param, studio.js's spawn requests) has to agree
// with the one Jitsi itself actually joins, or /sdA and /sda silently split
// into two rosters and two bot clusters fighting over the same meeting.
export function getRoomNameFromUrl() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const roomName = parts.length ? parts[parts.length - 1] : null;
    return roomName ? roomName.toLowerCase() : roomName;
  }

export function renderJamulusWelcomePanelAndBanner() {
  const mapping = window.JAMULUS_ROOM_MAP || {};
  if (!Object.keys(mapping).length) {
    return;
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startJamulusWelcomePanel();
    // startJamulusBannerPolling();
  } else {
    window.addEventListener('DOMContentLoaded', startJamulusWelcomePanel);
    // window.addEventListener('DOMContentLoaded', startJamulusBannerPolling);
  }
}

// ---- Jamulus relay client ---------------------------------------------------
//
// Connects to the server-side relay at /jamulus-audio, feeds the incoming PCM
// stream into an AudioWorklet ring-buffer player, and routes that node directly
// into the local peer's Trussal effects chain (worklet → limiter → reverb).
// Mutes all Jitsi peer audio via setJamulusMode so the relay is the sole source.

let _relayWs        = null;
let _relayWorklet   = null;
let _relayWorkletLoaded = false;

async function ensureRelayWorklet(audioCtx) {
  if (!_relayWorkletLoaded) {
    await audioCtx.audioWorklet.addModule('/jamulus-relay-player.js');
    _relayWorkletLoaded = true;
  }
  return new AudioWorkletNode(audioCtx, 'jamulus-relay-processor', {
    numberOfOutputs:    1,
    outputChannelCount: [2],
  });
}

export async function connectJamulusRelay() {
  if (_relayWs) return; // already connected

  const local = getLocalPeer();
  if (!local || !local.jitsiId) throw new Error('No local peer identity yet');

  const room = getRoomNameFromUrl();
  if (!room) throw new Error('Not in a Jitsi room');

  const { audioCtx } = await bootAudioEngine();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const loc   = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const url   = `${proto}//${loc.host}/jamulus-audio?room=${encodeURIComponent(room)}`;

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  _relayWs = ws;

  // Wait for the relay-ready handshake before creating the worklet.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay connect timeout')), 20_000);
    const onMsg = (evt) => {
      if (typeof evt.data !== 'string') return;
      const msg = JSON.parse(evt.data);
      if (msg.type === 'relay-ready') {
        clearTimeout(timeout);
        ws.removeEventListener('message', onMsg);
        resolve();
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        ws.removeEventListener('message', onMsg);
        reject(new Error(msg.message || 'relay error'));
      }
    };
    ws.addEventListener('message', onMsg);
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket error')); };
    ws.onclose = () => { clearTimeout(timeout); reject(new Error('WebSocket closed')); };
  });

  const worklet = await ensureRelayWorklet(audioCtx);
  _relayWorklet = worklet;

  // Route incoming PCM chunks into the worklet ring buffer.
  ws.onmessage = (evt) => {
    if (typeof evt.data === 'string') {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'relay-stopped') disconnectJamulusRelay();
      return;
    }
    worklet.port.postMessage(evt.data, [evt.data]);
  };
  ws.onclose = () => {
    console.log('[jamulus] relay WebSocket closed');
    disconnectJamulusRelay();
  };

  // Wire worklet into the effects chain for the local peer.
  await attachNodeToChain(local.jitsiId, worklet, 'Jamulus relay');
  setJamulusMode(true);
  console.log('[jamulus] relay connected, room', room);
}

export function disconnectJamulusRelay() {
  if (_relayWs) {
    _relayWs.onmessage = null;
    _relayWs.onclose   = null;
    try { _relayWs.close(); } catch (_) {}
    _relayWs = null;
  }
  if (_relayWorklet) {
    try { _relayWorklet.disconnect(); } catch (_) {}
    _relayWorklet = null;
  }
  const local = getLocalPeer();
  if (local && local.jitsiId) {
    detachNodeFromChain(local.jitsiId);
    setJamulusMode(false);
  }
  console.log('[jamulus] relay disconnected');
}

export function isRelayConnected() {
  return !!_relayWs && _relayWs.readyState === WebSocket.OPEN;
}
