// WebSocket peer state bus.
//
// Owns the WS connection to the latency sidecar. Tracks roster + state for
// every peer in the room, keyed by their Jitsi user id (so the audio engine
// and the UI can correlate to APP.conference's participant list). Also keeps
// the existing ping/pong RTT measurement and broadcasts our local metrics so
// every browser drives each peer's effects chain from that peer's network
// conditions.

import { getRoomNameFromUrl } from './jamulus.js';
import { subscribeParticipants, getLocalParticipant } from './participants.js';

const subscribers = new Set();

// Indexed two ways: peerId (WS-assigned) is authoritative for routing; jitsiId
// is what the UI / audio engine looks up against APP.conference.
const peersByPeerId = new Map();
const peerIdByJitsiId = new Map();

// The local peer is tracked separately because the server never echoes our own
// state back to us. Stays in sync with what we broadcast so the studio UI and
// the Strudel stack treat the local user identically to remote peers.
const localPeer = {
  peerId: null,
  jitsiId: null,
  displayName: null,
  isLocal: true,
  pattern: '',
  effects: { distortion: false, noise: false, reverb: false },
  playing: false,
  rtt: null,
  jitter: null
};

let ws = null;
let wantConnection = false;
let myPeerId = null;
let helloSent = false;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let lastPongAt = 0;
let currentRoom = null;
const MAX_RECONNECT_DELAY = 15000;
const PONG_TIMEOUT_MS = 8000;

const rttSamples = [];
let localRtt = null;
let localJitter = null;

// Buffer outgoing messages while we wait for hello / reconnect.
const pendingSends = [];

function emit(event, payload) {
  subscribers.forEach(fn => {
    try { fn(event, payload); } catch (e) { console.warn('[peer-state] subscriber threw', e); }
  });
}

function safeSend(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pendingSends.push(msg);
    return;
  }
  try { ws.send(JSON.stringify(msg)); } catch (e) { console.warn('[peer-state] send failed', e); }
}

function flushPending() {
  while (pendingSends.length && ws && ws.readyState === WebSocket.OPEN) {
    const msg = pendingSends.shift();
    try { ws.send(JSON.stringify(msg)); } catch (e) { pendingSends.unshift(msg); break; }
  }
}

function sendHelloIfReady() {
  if (helloSent || !ws || ws.readyState !== WebSocket.OPEN) return;
  const local = getLocalParticipant();
  if (!local) return;
  ws.send(JSON.stringify({
    type: 'hello',
    jitsiId: local.id,
    displayName: local.displayName
  }));
  helloSent = true;
  flushPending();
}

function scheduleReconnect() {
  if (!wantConnection || !currentRoom) return;
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function openSocket() {
  if (!wantConnection || !currentRoom) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  helloSent = false;

  // Discard all remote peer state from the previous room so stale entries
  // don't bleed into the new room's participant strip.
  peersByPeerId.clear();
  peerIdByJitsiId.clear();

  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${loc.host}/ws?room=${encodeURIComponent(currentRoom)}&role=player`;

  let socket;
  try { socket = new WebSocket(url); }
  catch (e) { console.warn('[peer-state] WS construct failed', e); scheduleReconnect(); return; }
  ws = socket;

  ws.onopen = () => {
    reconnectDelay = 1000;
    lastPongAt = Date.now();
    sendHelloIfReady();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        try { ws.close(); } catch (e) {}
        return;
      }
      ws.send(JSON.stringify({ type: 'ping', sentAt: Date.now() }));
    }, 2000);
  };

  ws.onclose = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    ws = null;
    helloSent = false;
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { if (ws) ws.close(); } catch (e) {}
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    handleMessage(msg);
  };
}

function applyPatch(peer, patch) {
  if (!patch) return;
  if (typeof patch.pattern === 'string') peer.pattern = patch.pattern;
  if (patch.effects) peer.effects = {
    distortion: !!patch.effects.distortion,
    noise: !!patch.effects.noise,
    reverb: !!patch.effects.reverb
  };
  if (typeof patch.playing === 'boolean') peer.playing = patch.playing;
  if (typeof patch.rtt === 'number' || patch.rtt === null) peer.rtt = patch.rtt;
  if (typeof patch.jitter === 'number' || patch.jitter === null) peer.jitter = patch.jitter;
}

function defaultPeer(peerId) {
  return {
    peerId,
    jitsiId: null,
    displayName: null,
    pattern: '',
    effects: { distortion: false, noise: false, reverb: false },
    playing: false,
    rtt: null,
    jitter: null
  };
}

function upsertPeer(record) {
  const existing = peersByPeerId.get(record.peerId) || defaultPeer(record.peerId);
  if (record.jitsiId !== undefined) existing.jitsiId = record.jitsiId;
  if (record.displayName !== undefined) existing.displayName = record.displayName;
  applyPatch(existing, record);
  peersByPeerId.set(existing.peerId, existing);
  if (existing.jitsiId) peerIdByJitsiId.set(existing.jitsiId, existing.peerId);
  return existing;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myPeerId = msg.peerId || null;
      sendHelloIfReady();
      break;

    case 'roster':
      if (Array.isArray(msg.peers)) {
        for (const p of msg.peers) {
          const peer = upsertPeer(p);
          emit('peer-upsert', peer);
        }
      }
      break;

    case 'peer-join': {
      if (!msg.peer) break;
      const peer = upsertPeer(msg.peer);
      emit('peer-upsert', peer);
      break;
    }

    case 'peer-leave': {
      const peer = peersByPeerId.get(msg.peerId);
      if (peer) {
        peersByPeerId.delete(peer.peerId);
        if (peer.jitsiId) peerIdByJitsiId.delete(peer.jitsiId);
        emit('peer-leave', peer);
      }
      break;
    }

    case 'peer-update': {
      const peer = peersByPeerId.get(msg.peerId);
      if (!peer) break;
      applyPatch(peer, msg.patch);
      emit('peer-upsert', peer);
      break;
    }

    case 'pong': {
      lastPongAt = Date.now();
      const rtt = (typeof msg.clientSentAt === 'number') ? Date.now() - msg.clientSentAt : msg.rtt;
      if (typeof rtt !== 'number' || !isFinite(rtt) || rtt < 0) break;
      rttSamples.push(rtt);
      if (rttSamples.length > 5) rttSamples.shift();
      const mean = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
      const variance = rttSamples.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / rttSamples.length;
      localRtt = rtt;
      localJitter = Math.sqrt(variance);
      localPeer.rtt = localRtt;
      localPeer.jitter = localJitter;
      safeSend({ type: 'metrics', rtt: localRtt, jitter: localJitter });
      emit('local-metrics', { rtt: localRtt, jitter: localJitter });
      emit('peer-upsert', localPeer);
      break;
    }
  }
}

subscribeParticipants((event, payload) => {
  if (event === 'local' || event === 'local-update') {
    if (payload && payload.id) {
      localPeer.jitsiId = payload.id;
      localPeer.displayName = payload.displayName;
      emit('peer-upsert', localPeer);
    }
    // Local identity arrived (or changed). Connect to the room and announce.
    const room = getRoomNameFromUrl();
    if (!room) return;
    if (room !== currentRoom) {
      currentRoom = room;
      wantConnection = true;
      openSocket();
    } else if (event === 'local-update' && ws && ws.readyState === WebSocket.OPEN) {
      // Re-hello to update displayName server-side.
      helloSent = false;
      sendHelloIfReady();
    } else if (!ws) {
      wantConnection = true;
      openSocket();
    }
  }
});

window.addEventListener('online', () => {
  if (!wantConnection) return;
  reconnectDelay = 1000;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  openSocket();
});

// --- Public API -----------------------------------------------------------

export function subscribePeerState(fn) {
  subscribers.add(fn);
  if (localPeer.jitsiId) fn('peer-upsert', localPeer);
  for (const p of peersByPeerId.values()) fn('peer-upsert', p);
  if (localRtt != null) fn('local-metrics', { rtt: localRtt, jitter: localJitter });
  return () => subscribers.delete(fn);
}

export function getPeerByJitsiId(jitsiId) {
  if (!jitsiId) return null;
  if (localPeer.jitsiId === jitsiId) return localPeer;
  const peerId = peerIdByJitsiId.get(jitsiId);
  return peerId ? peersByPeerId.get(peerId) || null : null;
}

export function getLocalPeer() { return localPeer; }

export function getAllPeers() {
  const all = [];
  const seenJitsiIds = new Set();
  if (localPeer.jitsiId) {
    all.push(localPeer);
    seenJitsiIds.add(localPeer.jitsiId);
  }
  for (const p of peersByPeerId.values()) {
    // Skip our own echoed entry and any duplicate jitsiId (e.g. from a stale
    // server entry left over from a reconnect before the old socket closed).
    if (!p.jitsiId || seenJitsiIds.has(p.jitsiId)) continue;
    seenJitsiIds.add(p.jitsiId);
    all.push(p);
  }
  return all;
}

export function getMyPeerId() { return myPeerId; }
export function getLocalMetrics() { return { rtt: localRtt, jitter: localJitter }; }

export function sendLocalPattern(code) {
  localPeer.pattern = typeof code === 'string' ? code : '';
  safeSend({ type: 'pattern', code: localPeer.pattern });
  emit('peer-upsert', localPeer);
}

export function sendLocalEffects(effects) {
  localPeer.effects = {
    distortion: !!effects.distortion,
    noise: !!effects.noise,
    reverb: !!effects.reverb
  };
  safeSend({ type: 'effects', state: localPeer.effects });
  emit('peer-upsert', localPeer);
}

export function sendLocalPlaying(playing) {
  localPeer.playing = !!playing;
  safeSend({ type: playing ? 'play' : 'stop' });
  emit('peer-upsert', localPeer);
}
