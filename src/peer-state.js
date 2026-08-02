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
// Bots set this global (before the bundle loads) so they announce themselves as
// bots and the room can drive/mute them from the studio without hijacking humans.
const LOCAL_IS_BOT = !!(typeof window !== 'undefined' && window.__trussalIsBot);
// The aggregator bot sets this (before the bundle loads) so it announces itself
// as the room's audio aggregator. Every other client silences all non-aggregator
// peers locally so the aggregator's assembled master is the sole audio source.
const LOCAL_IS_AGGREGATOR = !!(typeof window !== 'undefined' && window.__trussalIsAggregator);
// Bots spawned on a user's behalf carry their owner's room index so the
// sidecar can assign them a cluster suffix (e.g. owner 1 → bots 1a, 1b, …).
const LOCAL_OWNER_INDEX = (typeof window !== 'undefined' && typeof window.__trussalBotOwnerIndex === 'string')
  ? window.__trussalBotOwnerIndex : null;

const localPeer = {
  peerId: null,
  roomIndex: null,
  jitsiId: null,
  displayName: null,
  isLocal: true,
  isBot: LOCAL_IS_BOT,
  isAggregator: LOCAL_IS_AGGREGATOR,
  muted: false,
  pattern: '',
  effects: { distortion: false, noise: false, reverb: false },
  playing: false,
  rtt: null,
  jitter: null,
  packetLoss: null,
  rtcRtt: null,
  rtcJitter: null,
  jitterBufferMs: null,
  pipelineMs: null,
  canEditMetaprogram: !LOCAL_IS_BOT,
  canWriteModulation: !LOCAL_IS_BOT
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
let activeNetCyclesToken = null; // aggregator's current ring turn (nc-active)
let activeNetCyclesIndex = null; // ring-slot index of that turn (repeats-aware)
let activeNetCyclesKind = null;  // 'rest' when the turn is a written `~`, else null
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

// A persistent per-browser identity, so a genuine leave→rejoin (which mints a
// fresh Jitsi endpoint id each time) is recognized by the sidecar and handed
// back the SAME room index it held before — keeping the returning peer in the
// aggregator's rotation and the metaprogram's slot (see indexByStableId in
// latency-instrument/server.js). Persisted in localStorage so it survives the
// tab close a real rejoin implies; a fresh one per browser keeps it unique.
// Bots are excluded: their storage is ephemeral (a fresh container each spawn),
// so a UUID here would never actually recur — they keep the fresh-index path.
function stableClientId() {
  try {
    const KEY = 'trussal:clientId';
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch (e) {
    // Storage blocked (private mode / disabled) — fall back to the fresh-index
    // behavior rather than a per-session id that would falsely reclaim.
    return null;
  }
}

function sendHelloIfReady() {
  if (helloSent || !ws || ws.readyState !== WebSocket.OPEN) return;
  const local = getLocalParticipant();
  if (!local) return;
  const hello = {
    type: 'hello',
    jitsiId: local.id,
    displayName: local.displayName,
    isBot: LOCAL_IS_BOT,
    isAggregator: LOCAL_IS_AGGREGATOR
  };
  if (LOCAL_IS_BOT && LOCAL_OWNER_INDEX) hello.ownerIndex = LOCAL_OWNER_INDEX;
  if (!LOCAL_IS_BOT) {
    const stableId = stableClientId();
    if (stableId) hello.stableId = stableId;
  }
  ws.send(JSON.stringify(hello));
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
  if (typeof patch.muted === 'boolean') peer.muted = patch.muted;
  if (typeof patch.rtt === 'number' || patch.rtt === null) peer.rtt = patch.rtt;
  if (typeof patch.jitter === 'number' || patch.jitter === null) peer.jitter = patch.jitter;
  if (typeof patch.packetLoss === 'number' || patch.packetLoss === null) peer.packetLoss = patch.packetLoss;
  if (typeof patch.rtcRtt === 'number' || patch.rtcRtt === null) peer.rtcRtt = patch.rtcRtt;
  if (typeof patch.rtcJitter === 'number' || patch.rtcJitter === null) peer.rtcJitter = patch.rtcJitter;
  if (typeof patch.jitterBufferMs === 'number' || patch.jitterBufferMs === null) peer.jitterBufferMs = patch.jitterBufferMs;
  if (typeof patch.pipelineMs === 'number' || patch.pipelineMs === null) peer.pipelineMs = patch.pipelineMs;
  if (typeof patch.canEditMetaprogram === 'boolean') peer.canEditMetaprogram = patch.canEditMetaprogram;
  if (typeof patch.canWriteModulation === 'boolean') peer.canWriteModulation = patch.canWriteModulation;
}

function defaultPeer(peerId) {
  return {
    peerId,
    roomIndex: null,
    jitsiId: null,
    displayName: null,
    isBot: false,
    isAggregator: false,
    muted: false,
    pattern: '',
    effects: { distortion: false, noise: false, reverb: false },
    playing: false,
    rtt: null,
    jitter: null,
    packetLoss: null,
    rtcRtt: null,
    rtcJitter: null,
    jitterBufferMs: null,
    pipelineMs: null,
    canEditMetaprogram: true,
    canWriteModulation: true
  };
}

function upsertPeer(record) {
  const existing = peersByPeerId.get(record.peerId) || defaultPeer(record.peerId);
  if (record.roomIndex !== undefined) existing.roomIndex = record.roomIndex;
  if (record.jitsiId !== undefined) existing.jitsiId = record.jitsiId;
  if (record.displayName !== undefined) existing.displayName = record.displayName;
  if (record.isBot !== undefined) existing.isBot = !!record.isBot;
  if (record.isAggregator !== undefined) existing.isAggregator = !!record.isAggregator;
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
      // `you` carries our own server-assigned room index (immutable for the
      // meeting) — the server never repeats our record in later broadcasts.
      if (msg.you && msg.you.roomIndex != null) {
        localPeer.roomIndex = msg.you.roomIndex;
        emit('peer-upsert', localPeer);
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

    case 'fleet-status':
      // Fleet service reporting back (spawn results, ceiling hits, teardown).
      emit('fleet-status', msg);
      break;

    case 'crdt-update':
      // Shared metaprogram doc sync (Yjs update, base64). Consumed by
      // MetaprogrammerCrdtSync; peer-state just relays it off the socket.
      if (typeof msg.update === 'string') {
        emit('crdt-update', { update: msg.update, authorIndex: msg.authorIndex ?? null, modality: msg.modality });
      }
      break;

    case 'crdt-state':
      // Late-joiner catch-up: full doc history.
      if (Array.isArray(msg.updates)) emit('crdt-state', { updates: msg.updates });
      break;

    case 'nc-active':
      // Aggregator's current ring turn — the participant token whose audio is
      // streaming this slot, plus the ring-slot index that disambiguates a
      // token listed more than once. Surfaced as a DOM event so the metaprogram
      // highlighter can outline the exact occurrence.
      //
      // A REST arrives as kind:'rest' with no token, and its index addresses
      // the program's rests rather than its participants — the room is resting
      // at that written `~`. No token and no kind means no turn at all, which
      // clears the outline.
      activeNetCyclesToken = typeof msg.token === 'string' ? msg.token : null;
      activeNetCyclesIndex = Number.isInteger(msg.index) ? msg.index : null;
      activeNetCyclesKind = msg.kind === 'rest' ? 'rest' : null;
      document.dispatchEvent(new CustomEvent('trussal-netcycles-active', {
        detail: {
          token: activeNetCyclesToken,
          index: activeNetCyclesIndex,
          kind: activeNetCyclesKind,
        }
      }));
      break;

    case 'remote-control': {
      // We are the target of an operator action (only bots receive these — the
      // server gates on isBot). Reflect it on our local record and surface it as
      // a DOM event so the bot page can re-evaluate its Strudel / mute its audio.
      if (msg.action === 'pattern' && typeof msg.code === 'string') {
        localPeer.pattern = msg.code;
        document.dispatchEvent(new CustomEvent('trussal-remote-pattern', { detail: { code: msg.code } }));
        emit('peer-upsert', localPeer);
      } else if (msg.action === 'mute') {
        localPeer.muted = !!msg.muted;
        document.dispatchEvent(new CustomEvent('trussal-remote-mute', { detail: { muted: localPeer.muted } }));
        emit('peer-upsert', localPeer);
      }
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
  if (event === 'local-leave') {
    // We've left the Jitsi conference but the tab is still open (see
    // participants.js) — nothing else here reacts to a Jitsi-level departure,
    // so left unhandled this WS would stay open indefinitely under the old
    // jitsiId: the sidecar never sees a close (no peer-leave broadcast, so a
    // departed peer's slot — e.g. the aggregator's rotation — never frees),
    // and a same-tab rejoin would find `ws` still set and skip re-announcing
    // (sendHelloIfReady() is a no-op once helloSent), leaving the sidecar
    // pinned to the stale identity forever. Close explicitly so the server
    // sees a real disconnect now, and so the next 'local' (rejoin) takes the
    // `!ws` branch below and opens a fresh connection with a fresh hello.
    wantConnection = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch (e) {}
      ws = null;
    }
    helloSent = false;
    localPeer.jitsiId = null;
    return;
  }
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

// The participant token the aggregator is streaming this turn (nc-active), or
// null if unknown / no aggregator has reported. Also emitted as the DOM event
// 'trussal-netcycles-active' on each change.
export function getActiveNetCyclesToken() { return activeNetCyclesToken; }

// The ring-slot index of that turn, disambiguating a token listed more than
// once (null when unknown). Indexes the program's PARTICIPANTS normally and
// its RESTS when the turn is a rest — see getActiveNetCyclesKind.
export function getActiveNetCyclesIndex() { return activeNetCyclesIndex; }

// 'rest' when the current turn is a written `~` (no participant is streaming
// and the index addresses the rests), null otherwise.
export function getActiveNetCyclesKind() { return activeNetCyclesKind; }

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
export function getLocalMetrics() {
  return {
    rtt: localRtt, jitter: localJitter, packetLoss: localPeer.packetLoss,
    rtcRtt: localPeer.rtcRtt, rtcJitter: localPeer.rtcJitter
  };
}

const NET_STAT_FIELDS = ['rtcRtt', 'rtcJitter', 'packetLoss', 'jitterBufferMs', 'pipelineMs'];

// RTCStats-derived sample from NetStats.js. rtt/jitter keep their WS
// ping/pong semantics (fallback path); rtcRtt/rtcJitter (media path) and
// packetLoss ride the same `metrics` broadcast so every browser computes
// identical worst-case values.
//
// rtcJitter is the RTP inter-arrival jitter of the audio actually being
// played, so it belongs to the same media path as rtcRtt and the de-jitter
// buffer that WCL is built from. The WS ping/pong `jitter` measures the
// signalling leg to the sidecar instead, and stays only as the fallback for
// a peer with no RTCStats sample yet.
//
// Each field is three-state. A NUMBER sets it; an explicit `null` means
// "looked, nothing there" and CLEARS it, locally and over the wire; an ABSENT
// key means "not reporting on this field" and leaves it untouched. That last
// distinction is what lets the two callers compose — NetStats always passes
// all four of its fields (null where the stat was missing) while
// PipelineLatency sends `{ pipelineMs }` alone, and neither clobbers the
// other. Only the keys actually supplied are broadcast.
//
// Without the clear, a value that stops being measured is rebroadcast
// forever: a peer left alone in a room has no inbound-rtp at all, but the
// candidate pair still yields rtcRtt, so every poll would keep re-sending the
// last jitter reading and pin the room's WCJ — and so its turn length — to a
// measurement with nothing behind it.
export function sendLocalNetStats(sample = {}) {
  const msg = { type: 'metrics' };
  let reported = false;
  for (const key of NET_STAT_FIELDS) {
    const value = sample[key];
    if (value === undefined) continue;
    localPeer[key] = (typeof value === 'number' && isFinite(value)) ? value : null;
    msg[key] = localPeer[key];
    reported = true;
  }
  if (!reported) return;
  safeSend(msg);
  emit('local-metrics', getLocalMetrics());
  emit('peer-upsert', localPeer);
}

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

// Operator → another peer. The server applies these only to bot targets, then
// relays the action to the bot and broadcasts the resulting state to everyone.
export function sendRemotePattern(targetPeerId, code) {
  if (!targetPeerId) return;
  const c = typeof code === 'string' ? code : '';
  safeSend({ type: 'remote-control', targetPeerId, action: 'pattern', code: c });
  // Optimistically reflect the edit on the local cache + UI. Without this the
  // editor snaps back to the old pattern on the next (frequent, metrics-driven)
  // re-render, before the server's confirming peer-update round-trips back.
  const peer = peersByPeerId.get(targetPeerId);
  if (peer) {
    peer.pattern = c;
    emit('peer-upsert', peer);
  }
}

export function sendRemoteMute(targetPeerId, muted) {
  if (!targetPeerId) return;
  safeSend({ type: 'remote-control', targetPeerId, action: 'mute', muted: !!muted });
}

// Shared metaprogram doc: outbound Yjs update (base64). `snapshot` marks a
// full-state update that subsumes history server-side; `modality` records
// how the edit was made (keyboard / head-cursor / gesture / bot / mcp).
export function sendCrdtUpdate(update, { snapshot = false, modality = 'keyboard', channel = 'metaprogram' } = {}) {
  if (typeof update !== 'string' || !update) return;
  safeSend({ type: 'crdt-update', update, snapshot, modality, channel });
}

// Research telemetry: appended to the server-side session JSONL, never
// relayed to peers (scheduler cycle boundaries, health actions, …).
export function sendResearchEvent(kind, data = null) {
  if (typeof kind !== 'string' || !kind) return;
  safeSend({ type: 'research-event', kind, data });
}

// Ask the fleet service for cluster changes on our behalf. The server stamps
// the request with our room index; bots cannot send these.
export function sendFleetRequest(action, { count, targets } = {}) {
  const msg = { type: 'fleet-request', action };
  if (typeof count === 'number') msg.count = count;
  if (targets !== undefined) msg.targets = targets;
  safeSend(msg);
}

// Owner-side permission grant for a bot in one's cluster.
export function sendBotPermission(targetPeerId, perms) {
  if (!targetPeerId || !perms) return;
  const msg = { type: 'bot-permission', targetPeerId };
  if (typeof perms.canEditMetaprogram === 'boolean') msg.canEditMetaprogram = perms.canEditMetaprogram;
  if (typeof perms.canWriteModulation === 'boolean') msg.canWriteModulation = perms.canWriteModulation;
  safeSend(msg);
}
