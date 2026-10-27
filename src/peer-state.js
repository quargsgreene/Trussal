// WebSocket peer state bus.
//
// Owns the WS connection to the latency sidecar. Tracks roster + state for
// every peer in the room, keyed by their Jitsi user id (so the audio engine
// and the UI can correlate to APP.conference's participant list). Also keeps
// the existing ping/pong RTT measurement and broadcasts our local metrics so
// every browser drives each peer's effects chain from that peer's network
// conditions.
//
// State is now held in stable-state.js to survive HMR updates.

import { getRoomNameFromUrl } from './get-room-name-from-url.js';
import { subscribeParticipants, getLocalParticipant } from './participants.js';
import { setPeerPacks, removePeerPacks } from './data-ref.js';
import { hasTextCycles } from './text-cycles-core.js';
import { sanitizeEmojiList } from './custom-emoji-core.js';
import { textLog, clip } from './text-debug.js';
import { detectNotation, mondoToMini } from './notation.js';
import { sanitizeInhabitMap, turnTokenFor } from './inhabit-core.js';
import { sanitizePermissionsConfig } from './permissions-config.js';

// Import all state and helpers from stable-state (with ss_ prefix to avoid conflicts)
import {
  getWs as ss_getWs, setWs as ss_setWs,
  getWsConfig as ss_getWsConfig, setWsConfig as ss_setWsConfig,
  getPeersByPeerId as ss_getPeersByPeerId, getPeerIdByJitsiId as ss_getPeerIdByJitsiId, getLocalPeer as ss_getLocalPeer, getSubscribers as ss_getSubscribers,
  getAggregatorSlotTaken as ss_getAggregatorSlotTaken, setAggregatorSlotTaken as ss_setAggregatorSlotTaken,
  getActiveJPatternToken as ss_getActiveJPatternToken, setActiveJPatternToken as ss_setActiveJPatternToken,
  getActiveJPatternIndex as ss_getActiveJPatternIndex, setActiveJPatternIndex as ss_setActiveJPatternIndex,
  getActiveJPatternKind as ss_getActiveJPatternKind, setActiveJPatternKind as ss_setActiveJPatternKind,
  getMyPeerId as ss_getMyPeerId, setMyPeerId as ss_setMyPeerId,
  getHelloSent as ss_getHelloSent, setHelloSent as ss_setHelloSent,
  getPingTimer as ss_getPingTimer, setPingTimer as ss_setPingTimer,
  getReconnectTimer as ss_getReconnectTimer, setReconnectTimer as ss_setReconnectTimer,
  getReconnectDelay as ss_getReconnectDelay, setReconnectDelay as ss_setReconnectDelay,
  getLastPongAt as ss_getLastPongAt, setLastPongAt as ss_setLastPongAt,
  getCurrentRoom as ss_getCurrentRoom, setCurrentRoom as ss_setCurrentRoom,
  getWantConnection as ss_getWantConnection, setWantConnection as ss_setWantConnection,
  getPendingSends as ss_getPendingSends, getRttSamples as ss_getRttSamples,
  getLocalRtt as ss_getLocalRtt, setLocalRtt as ss_setLocalRtt,
  getLocalJitter as ss_getLocalJitter, setLocalJitter as ss_setLocalJitter,
  MAX_RECONNECT_DELAY, PONG_TIMEOUT_MS,
  subscribe, emit, defaultPeer,
} from './stable-state.js';

// Local constants (read from window at module load)
const LOCAL_IS_BOT = !!(typeof window !== 'undefined' && window.__trussalIsBot);
const LOCAL_IS_AGGREGATOR = !!(typeof window !== 'undefined' && window.__trussalIsAggregator);
const LOCAL_AGGREGATOR_CLAIM_TOKEN = (typeof window !== 'undefined' && typeof window.__trussalAggregatorClaimToken === 'string')
  ? window.__trussalAggregatorClaimToken : null;
const LOCAL_OWNER_INDEX = (typeof window !== 'undefined' && typeof window.__trussalBotOwnerIndex === 'string')
  ? window.__trussalBotOwnerIndex : null;

// Walkie Talkie Mode (walkie-talkie.js): whether this browser is in it, and
// the room's latest walkie roster from the sidecar. Module state rather than
// stable-state because walkie-talkie.js re-sends both on its own boot.
let localWalkie = false;
let walkieRoster = [];

// The `# inhabit` guest → host map the sidecar last relayed (see
// inhabit-core.js). Module state, like the walkie roster: the sidecar re-sends
// it on every (re)connect's hello.
let inhabitMap = {};

// This participant's own permissionsConfig (permissions.js), carried on every
// hello so the sidecar never applies the defaults to a reconnecting browser
// that has narrowed them. null until permissions.js has read one.
let localPermissionsConfig = null;

// --- Internal Helpers -------------------------------------------------------

function safeSend(msg) {
  const ws = ss_getWs();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    ss_getPendingSends().push(msg);
    return;
  }
  try { ws.send(JSON.stringify(msg)); } catch (e) { console.warn('[peer-state] send failed', e); }
}

function flushPending() {
  const ws = ss_getWs();
  const pending = ss_getPendingSends();
  while (pending.length && ws && ws.readyState === WebSocket.OPEN) {
    const msg = pending.shift();
    try { ws.send(JSON.stringify(msg)); } catch (e) { pending.unshift(msg); break; }
  }
}

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
    return null;
  }
}

function sendHelloIfReady() {
  if (ss_getHelloSent()) return;
  const ws = ss_getWs();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const local = getLocalParticipant();
  if (!local) return;
  const hello = {
    type: 'hello',
    jitsiId: local.id,
    displayName: local.displayName,
    isBot: LOCAL_IS_BOT,
    isAggregator: LOCAL_IS_AGGREGATOR
  };
  if (LOCAL_IS_AGGREGATOR && LOCAL_AGGREGATOR_CLAIM_TOKEN) hello.claimToken = LOCAL_AGGREGATOR_CLAIM_TOKEN;
  if (localPermissionsConfig) hello.permissionsConfig = localPermissionsConfig;
  if (LOCAL_IS_BOT && LOCAL_OWNER_INDEX) hello.ownerIndex = LOCAL_OWNER_INDEX;
  if (!LOCAL_IS_BOT) {
    const stableId = stableClientId();
    if (stableId) hello.stableId = stableId;
    // Carried on the hello so a reconnect never briefly reappears to the room.
    if (localWalkie) hello.walkie = true;
  }
  ws.send(JSON.stringify(hello));
  ss_setHelloSent(true);
  // A reconnect lands on a fresh sidecar record: put our uploaded emoji back
  // on it, so the room (and anyone who joins later) can still draw them.
  if (ss_getLocalPeer().customEmoji?.length) {
    ws.send(JSON.stringify({ type: 'custom-emoji', emoji: ss_getLocalPeer().customEmoji }));
  }
  flushPending();
}

function scheduleReconnect() {
  if (!ss_getWantConnection() || !ss_getCurrentRoom()) return;
  if (ss_getReconnectTimer()) return;
  const delay = ss_getReconnectDelay();
  ss_setReconnectDelay(Math.min(ss_getReconnectDelay() * 2, MAX_RECONNECT_DELAY));
  const timer = setTimeout(() => {
    ss_setReconnectTimer(null);
    openSocket();
  }, delay);
  ss_setReconnectTimer(timer);
}

function openSocket() {
  if (!ss_getWantConnection() || !ss_getCurrentRoom()) return;
  if (ss_getReconnectTimer()) { clearTimeout(ss_getReconnectTimer()); ss_setReconnectTimer(null); }

  const ws = ss_getWs();
  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try { ws.close(); } catch (e) {}
    ss_setWs(null);
  }
  if (ss_getPingTimer()) { clearInterval(ss_getPingTimer()); ss_setPingTimer(null); }
  ss_setHelloSent(false);

  // Discard all remote peer state from the previous room
  ss_getPeersByPeerId().clear();
  ss_getPeerIdByJitsiId().clear();

  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${loc.host}/ws?room=${encodeURIComponent(ss_getCurrentRoom())}&role=player`;

  let socket;
  try { socket = new WebSocket(url); }
  catch (e) { console.warn('[peer-state] WS construct failed', e); scheduleReconnect(); return; }
  ss_setWs(socket);

  socket.onopen = () => {
    ss_setReconnectDelay(1000);
    ss_setLastPongAt(Date.now());
    sendHelloIfReady();
    if (ss_getPingTimer()) clearInterval(ss_getPingTimer());
    const timer = setInterval(() => {
      const ws = ss_getWs();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - ss_getLastPongAt() > PONG_TIMEOUT_MS) {
        try { ws.close(); } catch (e) {}
        return;
      }
      ws.send(JSON.stringify({ type: 'ping', sentAt: Date.now() }));
    }, 2000);
    ss_setPingTimer(timer);
  };

  socket.onclose = () => {
    if (ss_getPingTimer()) { clearInterval(ss_getPingTimer()); ss_setPingTimer(null); }
    ss_setWs(null);
    ss_setHelloSent(false);
    scheduleReconnect();
  };

  socket.onerror = () => {
    const ws = ss_getWs();
    try { if (ws) ws.close(); } catch (e) {}
  };

  socket.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    handleMessage(msg);
  };
}

function applyPatch(peer, patch) {
  if (!patch) return;
  if (typeof patch.pattern === 'string') {
    if (patch.pattern !== peer.pattern && (hasTextCycles(patch.pattern) || hasTextCycles(peer.pattern))) {
      textLog('peer-state:pattern-in', {
        peer: peer.peerId,
        jitsiId: peer.jitsiId,
        isBot: peer.isBot,
        declaresText: hasTextCycles(patch.pattern),
        code: clip(patch.pattern),
      });
    }
    peer.pattern = patch.pattern;
  }
  if (typeof patch.compiledCss === 'string') peer.compiledCss = patch.compiledCss;
  if (patch.effects) peer.effects = {
    distortion: !!patch.effects.distortion,
    noise: !!patch.effects.noise,
    reverb: !!patch.effects.reverb
  };
  if (typeof patch.playing === 'boolean') peer.playing = patch.playing;
  if (typeof patch.muted === 'boolean') peer.muted = patch.muted;
  if (typeof patch.videoOn === 'boolean') peer.videoOn = patch.videoOn;
  if (typeof patch.rtt === 'number' || patch.rtt === null) peer.rtt = patch.rtt;
  if (typeof patch.jitter === 'number' || patch.jitter === null) peer.jitter = patch.jitter;
  if (typeof patch.packetLoss === 'number' || patch.packetLoss === null) peer.packetLoss = patch.packetLoss;
  if (typeof patch.rtcRtt === 'number' || patch.rtcRtt === null) peer.rtcRtt = patch.rtcRtt;
  if (typeof patch.rtcJitter === 'number' || patch.rtcJitter === null) peer.rtcJitter = patch.rtcJitter;
  if (typeof patch.jitterBufferMs === 'number' || patch.jitterBufferMs === null) peer.jitterBufferMs = patch.jitterBufferMs;
  if (typeof patch.pipelineMs === 'number' || patch.pipelineMs === null) peer.pipelineMs = patch.pipelineMs;
  if (typeof patch.canEditMetaprogram === 'boolean') peer.canEditMetaprogram = patch.canEditMetaprogram;
  if (typeof patch.canWriteModulation === 'boolean') peer.canWriteModulation = patch.canWriteModulation;
  // Uploaded emoji (custom-emoji.js), re-validated here: they arrive from
  // another browser and end up as <img> sources in this one.
  if (Array.isArray(patch.customEmoji)) peer.customEmoji = sanitizeEmojiList(patch.customEmoji);
  // What this peer's own permissionsConfig(...) lets others do with it.
  if (patch.permissionsConfig && typeof patch.permissionsConfig === 'object') {
    peer.permissionsConfig = sanitizePermissionsConfig(patch.permissionsConfig);
  }
  if (Array.isArray(patch.dataPacks)) {
    peer.dataPacks = patch.dataPacks;
    setPeerPacks(peer.peerId, patch.dataPacks);
  }
}

function upsertPeer(record) {
  const existing = ss_getPeersByPeerId().get(record.peerId) || defaultPeer(record.peerId);
  if (record.roomIndex !== undefined) existing.roomIndex = record.roomIndex;
  if (record.jitsiId !== undefined) existing.jitsiId = record.jitsiId;
  if (record.displayName !== undefined) existing.displayName = record.displayName;
  if (record.isBot !== undefined) existing.isBot = !!record.isBot;
  if (record.isAggregator !== undefined) existing.isAggregator = !!record.isAggregator;
  applyPatch(existing, record);
  ss_getPeersByPeerId().set(existing.peerId, existing);
  if (existing.jitsiId) ss_getPeerIdByJitsiId().set(existing.jitsiId, existing.peerId);
  return existing;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      ss_setMyPeerId(msg.peerId || null);
      if (ss_getMyPeerId() && ss_getLocalPeer().dataPacks.length) setPeerPacks(ss_getMyPeerId(), ss_getLocalPeer().dataPacks);
      sendHelloIfReady();
      emit('connected', { peerId: ss_getMyPeerId() });
      break;

    case 'roster':
      if (Array.isArray(msg.peers)) {
        for (const p of msg.peers) {
          const peer = upsertPeer(p);
          emit('peer-upsert', peer);
        }
      }
      if (msg.you && msg.you.roomIndex != null) {
        ss_getLocalPeer().roomIndex = msg.you.roomIndex;
        emit('peer-upsert', ss_getLocalPeer());
      }
      // A roster answers every (re)connect's hello — the point at which
      // anything this browser keeps on the room (backing files) must be
      // re-sent, in case the sidecar restarted without it.
      emit('roster', null);
      break;

    case 'peer-join': {
      if (!msg.peer) break;
      const peer = upsertPeer(msg.peer);
      emit('peer-upsert', peer);
      break;
    }

    case 'peer-leave': {
      const peer = ss_getPeersByPeerId().get(msg.peerId);
      if (peer) {
        ss_getPeersByPeerId().delete(peer.peerId);
        if (peer.jitsiId) ss_getPeerIdByJitsiId().delete(peer.jitsiId);
        removePeerPacks(peer.peerId);
        emit('peer-leave', peer);
      }
      break;
    }

    case 'peer-update': {
      const peer = ss_getPeersByPeerId().get(msg.peerId);
      if (!peer) break;
      applyPatch(peer, msg.patch);
      emit('peer-upsert', peer);
      break;
    }

    case 'walkie-roster':
      walkieRoster = Array.isArray(msg.peers) ? msg.peers : [];
      emit('walkie-roster', walkieRoster);
      break;

    case 'walkie-signal':
      if (typeof msg.from === 'string') emit('walkie-signal', { from: msg.from, data: msg.data });
      break;

    case 'scss-compiled':
      ss_getLocalPeer().compiledCss = typeof msg.css === 'string' ? msg.css : '';
      emit('peer-upsert', ss_getLocalPeer());
      break;

    case 'scss-error':
      console.error('[css-cycles] the sidecar refused our SCSS:', msg.message);
      document.dispatchEvent(new CustomEvent('trussal-css-errors', { detail: [String(msg.message ?? '')] }));
      break;

    case 'fleet-status':
      emit('fleet-status', msg);
      break;

    case 'aggregator-slot-taken':
      if (!ss_getAggregatorSlotTaken()) {
        ss_setAggregatorSlotTaken(true);
        console.warn('[peer-state] another aggregator already holds this room\'s slot; standing down');
      }
      emit('aggregator-slot-taken', msg);
      break;

    case 'chat-file':
      emit('chat-file', {
        fromIndex: msg.fromIndex ?? null,
        kind: msg.kind,
        name: msg.name,
        mime: msg.mime,
        data: msg.data,
        post: !!msg.post,
      });
      break;

    case 'prebake':
      // A meeting prebake (see meeting-prebake.js): sent once when someone
      // uploads one, and again by the sidecar to every later joiner.
      if (msg.prebake && typeof msg.id === 'string') {
        emit('prebake', {
          id: msg.id,
          prebake: msg.prebake,
          fromIndex: msg.fromIndex ?? null,
          elapsed: Number.isFinite(msg.elapsed) ? msg.elapsed : 0,
        });
      }
      break;

    case 'no-code-library':
      // The room's No Code snippet library (see no-code.js): sent whole on
      // every upload, and by the sidecar to every later joiner.
      if (Array.isArray(msg.snippets)) emit('no-code-library', { snippets: msg.snippets, fromIndex: msg.fromIndex ?? null });
      break;

    case 'no-code-board':
      if (msg.board && typeof msg.board === 'object') emit('no-code-board', { board: msg.board, fromIndex: msg.fromIndex ?? null });
      break;

    case 'no-code-run':
      if (Number.isInteger(msg.rev)) emit('no-code-run', { rev: msg.rev, fromIndex: msg.fromIndex ?? null });
      break;

    case 'poll-vote':
      emit('poll-vote', {
        pollId: msg.pollId,
        option: msg.option ?? null,
        previousOption: msg.previousOption ?? null,
        voterToken: msg.voterToken,
      });
      break;

    case 'breakout-request':
      // A breakout()/assign() voice fired in its author's browser (see
      // breakout.js); only the elected moderator browser acts on it.
      if ((msg.fn === 'breakout' || msg.fn === 'assign') && msg.spec && typeof msg.spec === 'object') {
        emit('breakout-request', { fn: msg.fn, spec: msg.spec, fromIndex: msg.fromIndex ?? null });
      }
      break;

    case 'meeting-move':
      // A meeting() voice fired in some browser (see meeting-move.js) — this
      // one included, or the home meeting of someone it moved here — stamped
      // by the sidecar. Every browser checks whether it is named.
      if (msg.spec && typeof msg.spec === 'object' && typeof msg.origin === 'string' && Number.isFinite(msg.at)) {
        emit('meeting-move', { spec: msg.spec, origin: msg.origin, at: msg.at, fromIndex: msg.fromIndex ?? null });
      }
      break;

    case 'panic':
      // Someone pressed the breakout-room panic button (panic-button.js).
      emit('panic', {
        fromIndex: msg.fromIndex ?? null,
        token: typeof msg.token === 'string' ? msg.token : null,
        displayName: typeof msg.displayName === 'string' ? msg.displayName : null,
        room: typeof msg.room === 'string' ? msg.room : null,
      });
      break;

    case 'inhabit':
      inhabitMap = sanitizeInhabitMap(msg.map);
      emit('inhabit', { map: { ...inhabitMap } });
      break;

    case 'inhabit-relay':
      // Between a guest and its host only — the sidecar checked the pair.
      if (typeof msg.from === 'string' && typeof msg.kind === 'string') {
        emit('inhabit-relay', { from: msg.from, fromIndex: msg.fromIndex ?? null, kind: msg.kind, data: msg.data ?? null });
      }
      break;

    case 'editor-crdt-update':
      if (typeof msg.host === 'string' && typeof msg.update === 'string') {
        emit('editor-crdt-update', { host: msg.host, update: msg.update, authorIndex: msg.authorIndex ?? null });
      }
      break;

    case 'editor-crdt-state':
      if (typeof msg.host === 'string' && Array.isArray(msg.updates)) {
        emit('editor-crdt-state', { host: msg.host, updates: msg.updates.filter((u) => typeof u === 'string') });
      }
      break;

    case 'crdt-update':
      if (typeof msg.update === 'string') {
        emit('crdt-update', { update: msg.update, authorIndex: msg.authorIndex ?? null, modality: msg.modality });
      }
      break;

    case 'crdt-state':
      if (Array.isArray(msg.updates)) emit('crdt-state', { updates: msg.updates });
      break;

    case 'jp-active':
      ss_setActiveJPatternToken(typeof msg.token === 'string' ? msg.token : null);
      ss_setActiveJPatternIndex(Number.isInteger(msg.index) ? msg.index : null);
      ss_setActiveJPatternKind(msg.kind === 'rest' ? 'rest' : null);
      document.dispatchEvent(new CustomEvent('trussal-jpattern-active', {
        detail: {
          token: ss_getActiveJPatternToken(),
          index: ss_getActiveJPatternIndex(),
          kind: ss_getActiveJPatternKind(),
        }
      }));
      break;

    case 'remote-control': {
      if (msg.action === 'pattern' && typeof msg.code === 'string') {
        const code = detectNotation(msg.code) === 'mondo' ? mondoToMini(msg.code) : msg.code;
        ss_getLocalPeer().pattern = code;
        document.dispatchEvent(new CustomEvent('trussal-remote-pattern', {
          detail: { code, samples: msg.samples },
        }));
        emit('peer-upsert', ss_getLocalPeer());
      } else if (msg.action === 'mute') {
        ss_getLocalPeer().muted = !!msg.muted;
        document.dispatchEvent(new CustomEvent('trussal-remote-mute', { detail: { muted: ss_getLocalPeer().muted } }));
        emit('peer-upsert', ss_getLocalPeer());
      } else if (msg.action === 'video') {
        ss_getLocalPeer().videoOn = !!msg.videoOn;
        document.dispatchEvent(new CustomEvent('trussal-remote-video', { detail: { videoOn: ss_getLocalPeer().videoOn } }));
        emit('peer-upsert', ss_getLocalPeer());
      } else if (msg.action === 'stop') {
        document.dispatchEvent(new CustomEvent('trussal-remote-stop', { detail: { stopped: !!msg.stopped } }));
      }
      break;
    }

    case 'pong': {
      ss_setLastPongAt(Date.now());
      const rtt = (typeof msg.clientSentAt === 'number') ? Date.now() - msg.clientSentAt : msg.rtt;
      if (typeof rtt !== 'number' || !isFinite(rtt) || rtt < 0) break;
      const samples = ss_getRttSamples();
      samples.push(rtt);
      if (samples.length > 5) samples.shift();
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / samples.length;
      const newRtt = rtt;
      const newJitter = Math.sqrt(variance);
      ss_setLocalRtt(newRtt);
      ss_setLocalJitter(newJitter);
      ss_getLocalPeer().rtt = newRtt;
      ss_getLocalPeer().jitter = newJitter;
      safeSend({ type: 'metrics', rtt: newRtt, jitter: newJitter });
      emit('local-metrics', { rtt: newRtt, jitter: newJitter });
      emit('peer-upsert', ss_getLocalPeer());
      break;
    }
  }
}

// --- Participant Subscription ---

subscribeParticipants((event, payload) => {
  if (event === 'local-leave') {
    ss_setWantConnection(false);
    if (ss_getReconnectTimer()) { clearTimeout(ss_getReconnectTimer()); ss_setReconnectTimer(null); }
    if (ss_getPingTimer()) { clearInterval(ss_getPingTimer()); ss_setPingTimer(null); }
    const ws = ss_getWs();
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch (e) {}
      ss_setWs(null);
    }
    ss_setHelloSent(false);
    ss_getLocalPeer().jitsiId = null;
    return;
  }
  if (event === 'local' || event === 'local-update') {
    if (payload && payload.id) {
      ss_getLocalPeer().jitsiId = payload.id;
      ss_getLocalPeer().displayName = payload.displayName;
      emit('peer-upsert', ss_getLocalPeer());
    }
    const room = getRoomNameFromUrl();
    if (!room) return;
    if (room !== ss_getCurrentRoom()) {
      ss_setCurrentRoom(room);
      ss_setWantConnection(true);
      openSocket();
    } else if (event === 'local-update' && ss_getWs() && ss_getWs().readyState === WebSocket.OPEN) {
      ss_setHelloSent(false);
      sendHelloIfReady();
    } else if (!ss_getWs()) {
      ss_setWantConnection(true);
      openSocket();
    }
  }
});

window.addEventListener('online', () => {
  if (!ss_getWantConnection()) return;
  ss_setReconnectDelay(1000);
  if (ss_getReconnectTimer()) { clearTimeout(ss_getReconnectTimer()); ss_setReconnectTimer(null); }
  openSocket();
});

// --- Public API -----------------------------------------------------------

export function subscribePeerState(fn) {
  const subs = ss_getSubscribers();
  subs.add(fn);
  if (ss_getLocalPeer().jitsiId) fn('peer-upsert', ss_getLocalPeer());
  for (const p of ss_getPeersByPeerId().values()) fn('peer-upsert', p);
  if (ss_getLocalRtt() != null) fn('local-metrics', { rtt: ss_getLocalRtt(), jitter: ss_getLocalJitter() });
  return () => subs.delete(fn);
}

export function getPeerByJitsiId(jitsiId) {
  if (!jitsiId) return null;
  if (ss_getLocalPeer().jitsiId === jitsiId) return ss_getLocalPeer();
  const peerId = ss_getPeerIdByJitsiId().get(jitsiId);
  return peerId ? ss_getPeersByPeerId().get(peerId) || null : null;
}

export function getLocalPeerExported() { return ss_getLocalPeer(); }

// Re-export with original name for backward compatibility
export { getLocalPeerExported as getLocalPeer };

// True once the sidecar has refused this page's aggregator hello because the
// room already has an aggregator ('aggregator-slot-taken'). Only ever true on
// an aggregator page, and only ever false for the room's one real aggregator.
export function isAggregatorSlotTaken() { return ss_getAggregatorSlotTaken(); }

// The participant token the aggregator is streaming this turn (jp-active), or
// null if unknown / no aggregator has reported. Also emitted as the DOM event
// 'trussal-jpattern-active' on each change.
export function getActiveJPatternToken() { return ss_getActiveJPatternToken(); }

// The ring-slot index of that turn, disambiguating a token listed more than
// once (null when unknown). Indexes the program's PARTICIPANTS normally and
// its RESTS when the turn is a rest — see getActiveJPatternKind.
export function getActiveJPatternIndex() { return ss_getActiveJPatternIndex(); }

// 'rest' when the current turn is a written `~` (no participant is streaming
// and the index addresses the rests), null otherwise.
export function getActiveJPatternKind() { return ss_getActiveJPatternKind(); }

// The one rule for "is it this peer's turn right now" — shared by every
// silent-by-construction renderer (Text Cycles, CSS Cycles) that needs to
// mirror the mutual exclusion Strudel/Hydra already give audio and video.
// Compares against roomIndex the same way Metaprogrammer.js#peerByToken does
// on the audio side, so a browser rendering both Strudel and these voices
// never disagrees with itself about whose turn it is.
//
// Fails OPEN (true) when there is no live turn signal yet (no aggregator has
// reported, or the peer has no roomIndex) — an unknown state must not hide a
// performer's own output before their token is even assigned.
//
// A participant inhabiting another (`# inhabit`) has taken the host's place
// in the rotation: its turn is the host's turn, and its own token's turn
// passes it by.
export function isPeerJPatternTurn(jitsiId) {
  if (ss_getActiveJPatternToken() == null) return true;
  const peer = getPeerByJitsiId(jitsiId);
  if (!peer || peer.roomIndex == null) return true;
  return turnTokenFor(String(peer.roomIndex), inhabitMap) === String(ss_getActiveJPatternToken());
}

// The `# inhabit` guest → host map in force (a copy).
export function getInhabitMap() { return { ...inhabitMap }; }

export function getAllPeers() {
  const all = [];
  const seenJitsiIds = new Set();
  const local = ss_getLocalPeer();
  if (local.jitsiId) {
    all.push(local);
    seenJitsiIds.add(local.jitsiId);
  }
  for (const p of ss_getPeersByPeerId().values()) {
    if (!p.jitsiId || seenJitsiIds.has(p.jitsiId)) continue;
    seenJitsiIds.add(p.jitsiId);
    all.push(p);
  }
  return all;
}

export function getLocalMetrics() {
  return {
    rtt: ss_getLocalRtt(), jitter: ss_getLocalJitter(), packetLoss: ss_getLocalPeer().packetLoss,
    rtcRtt: ss_getLocalPeer().rtcRtt, rtcJitter: ss_getLocalPeer().rtcJitter
  };
}

const NET_STAT_FIELDS = ['rtcRtt', 'rtcJitter', 'packetLoss', 'jitterBufferMs', 'pipelineMs'];

export function sendLocalNetStats(sample = {}) {
  const msg = { type: 'metrics' };
  let reported = false;
  for (const key of NET_STAT_FIELDS) {
    const value = sample[key];
    if (value === undefined) continue;
    ss_getLocalPeer()[key] = (typeof value === 'number' && isFinite(value)) ? value : null;
    msg[key] = ss_getLocalPeer()[key];
    reported = true;
  }
  if (!reported) return;
  safeSend(msg);
  emit('local-metrics', getLocalMetrics());
  emit('peer-upsert', ss_getLocalPeer());
}

// Enter or leave Walkie Talkie Mode on the sidecar. The relay does the
// "left the meeting" part: everyone outside the walkie group gets a
// peer-leave now and a peer-join when this is turned off again.
export function setLocalWalkie(on) {
  const next = !!on && !LOCAL_IS_BOT;
  if (next === localWalkie) return;
  localWalkie = next;
  safeSend({ type: 'walkie', on: next });
}

export function isLocalWalkie() { return localWalkie; }
export function getMyPeerId() { return ss_getMyPeerId(); }
export function getWalkieRoster() { return walkieRoster.slice(); }

// One WebRTC signalling message (offer/answer/candidate) to another walkie
// peer, relayed point to point by the sidecar.
export function sendWalkieSignal(toPeerId, data) {
  if (!toPeerId) return;
  safeSend({ type: 'walkie-signal', to: toPeerId, data });
}

export function sendLocalPattern(code) {
  const next = typeof code === 'string' ? code : '';
  if (next !== ss_getLocalPeer().pattern && (hasTextCycles(next) || hasTextCycles(ss_getLocalPeer().pattern))) {
    textLog('peer-state:pattern-out', {
      declaresText: hasTextCycles(next),
      playing: ss_getLocalPeer().playing,
      roomIndex: ss_getLocalPeer().roomIndex,
      code: clip(next),
    });
  }
  ss_getLocalPeer().pattern = next;
  safeSend({ type: 'pattern', code: ss_getLocalPeer().pattern });
  emit('peer-upsert', ss_getLocalPeer());
}

export function sendLocalScss(scss) {
  safeSend({ type: 'scss', source: typeof scss === 'string' ? scss : '' });
}

export function sendPeerScss(targetPeerId, scss) {
  if (!targetPeerId) return;
  safeSend({ type: 'scss', targetPeerId, source: typeof scss === 'string' ? scss : '' });
}

export function sendLocalDataPacks(packs) {
  const list = Array.isArray(packs) ? packs : [];
  ss_getLocalPeer().dataPacks = list;
  if (ss_getMyPeerId()) setPeerPacks(ss_getMyPeerId(), list);
  safeSend({ type: 'datapacks', packs: list });
  emit('peer-upsert', ss_getLocalPeer());
}

// This browser's uploaded emoji → its sidecar record, mirrored to the room
// and held there for late joiners (see custom-emoji.js).
export function sendLocalCustomEmoji(list) {
  const emoji = sanitizeEmojiList(list);
  ss_getLocalPeer().customEmoji = emoji;
  if (ss_getHelloSent()) safeSend({ type: 'custom-emoji', emoji });
  emit('peer-upsert', ss_getLocalPeer());
}

export function sendLocalEffects(effects) {
  ss_getLocalPeer().effects = {
    distortion: !!effects.distortion,
    noise: !!effects.noise,
    reverb: !!effects.reverb
  };
  safeSend({ type: 'effects', state: ss_getLocalPeer().effects });
  emit('peer-upsert', ss_getLocalPeer());
}

export function sendLocalPlaying(playing) {
  ss_getLocalPeer().playing = !!playing;
  safeSend({ type: playing ? 'play' : 'stop' });
  emit('peer-upsert', ss_getLocalPeer());
}

export function sendRemotePattern(targetPeerId, code) {
  if (!targetPeerId) return;
  const c = typeof code === 'string' ? code : '';
  safeSend({ type: 'remote-control', targetPeerId, action: 'pattern', code: c });
  const peer = ss_getPeersByPeerId().get(targetPeerId);
  if (peer) {
    peer.pattern = c;
    emit('peer-upsert', peer);
  }
}

export function sendRemoteMute(targetPeerId, muted) {
  if (!targetPeerId) return;
  safeSend({ type: 'remote-control', targetPeerId, action: 'mute', muted: !!muted });
}

export function sendRemoteStop(targetPeerId, stopped) {
  if (!targetPeerId) return;
  safeSend({ type: 'remote-control', targetPeerId, action: 'stop', stopped: !!stopped });
}

export function sendRemoteVideo(targetPeerId, videoOn) {
  if (!targetPeerId) return;
  safeSend({ type: 'remote-control', targetPeerId, action: 'video', videoOn: !!videoOn });
}

export function sendCrdtUpdate(update, { snapshot = false, modality = 'keyboard', channel = 'metaprogram' } = {}) {
  if (typeof update !== 'string' || !update) return;
  safeSend({ type: 'crdt-update', update, snapshot, modality, channel });
}

export function sendResearchEvent(kind, data = null) {
  if (typeof kind !== 'string' || !kind) return;
  safeSend({ type: 'research-event', kind, data });
}

export function sendFleetRequest(action, { count, targets, code, settings, requestId } = {}) {
  const msg = { type: 'fleet-request', action };
  if (typeof count === 'number') msg.count = count;
  if (targets !== undefined) msg.targets = targets;
  if (typeof code === 'string') msg.code = code;
  // The in-room Conductor panel's request/answer correlation. `settings` is
  // validated against the fleet's remote-tuning allowlist on the far side.
  if (settings !== undefined) msg.settings = settings;
  if (typeof requestId === 'string') msg.requestId = requestId;
  safeSend(msg);
}

export function sendSampleFile({ bank, name, data }) {
  if (typeof bank !== 'string' || typeof name !== 'string' || typeof data !== 'string') return;
  safeSend({ type: 'sample-file', bank, name, data });
}

export function sendChatFile({ kind, name, mime, data, post = false }) {
  if (typeof kind !== 'string' || typeof name !== 'string' || typeof mime !== 'string' || typeof data !== 'string') return;
  const msg = { type: 'chat-file', kind, name, mime, data };
  // `post` asks every receiver to render the bubble now, rather than only
  // caching the bytes for their own copy of the author's pattern to trigger.
  if (post) msg.post = true;
  safeSend(msg);
}

// One backing() file on its way to the aggregator, which plays it (see
// backing-core.js). The sidecar forwards it to the fleet only and keeps it on
// the room, so an aggregator that (re)joins later still gets it.
export function sendBackingFile({ kind, name, mime, data }) {
  if (typeof kind !== 'string' || typeof name !== 'string' || typeof mime !== 'string' || typeof data !== 'string') return;
  safeSend({ type: 'backing-file', kind, name, mime, data });
}

export function sendPrebake(prebake) {
  if (!prebake || typeof prebake !== 'object') return;
  safeSend({ type: 'prebake', prebake });
}

export function sendNoCodeLibrary(snippets) {
  if (!Array.isArray(snippets)) return;
  safeSend({ type: 'no-code-library', snippets });
}

export function sendNoCodeBoard(board) {
  if (!board || typeof board !== 'object' || !Array.isArray(board.lines)) return;
  safeSend({ type: 'no-code-board', board });
}

export function sendNoCodeRun(rev) {
  if (!Number.isInteger(rev)) return;
  safeSend({ type: 'no-code-run', rev });
}

export function sendPollVote({ pollId, option, previousOption, voterToken }) {
  if (typeof pollId !== 'string' || typeof voterToken !== 'string') return;
  safeSend({ type: 'poll-vote', pollId, option: option ?? null, previousOption: previousOption ?? null, voterToken });
}

// This participant's permissionsConfig (permissions.js): kept for the next
// hello, and sent now if the sidecar already knows this browser.
export function sendPermissionsConfig(config) {
  localPermissionsConfig = sanitizePermissionsConfig(config);
  ss_getLocalPeer().permissionsConfig = localPermissionsConfig;
  if (ss_getHelloSent()) safeSend({ type: 'permissions-config', config: localPermissionsConfig });
}

// `# inhabit` (inhabit.js). The static map this browser resolved from the
// applied program — the sidecar only takes it while no aggregator reports one.
export function sendInhabitMap(map) {
  safeSend({ type: 'inhabit', map: sanitizeInhabitMap(map) });
}

// One message to the other side of an inhabitation: `toPeerId` is the host
// (kinds 'chat' | 'route' | 'join') or one of its guests ('snapshot').
export function sendInhabitRelay(toPeerId, kind, data = null) {
  if (!toPeerId || typeof kind !== 'string') return;
  safeSend({ type: 'inhabit-relay', to: toPeerId, kind, data });
}

// One Yjs update to `host`'s personal-editor doc, and the request for the
// doc's history so far.
export function sendEditorCrdtUpdate(host, update, { snapshot = false } = {}) {
  if (typeof host !== 'string' || typeof update !== 'string' || !update) return;
  safeSend({ type: 'editor-crdt-update', host, update, snapshot });
}

export function requestEditorCrdtState(host) {
  if (typeof host !== 'string') return;
  safeSend({ type: 'editor-crdt-sync', host });
}

export function sendBreakoutRequest({ fn, spec }) {
  if ((fn !== 'breakout' && fn !== 'assign') || !spec || typeof spec !== 'object') return;
  safeSend({ type: 'breakout-request', fn, spec });
}

export function sendMeetingMove({ spec }) {
  if (!spec || typeof spec !== 'object') return;
  safeSend({ type: 'meeting-move', spec });
}

// `home` ({ meeting, token }) is where a meeting() pattern moved this
// participant from, and their token there — the sidecar tells that meeting too.
export function sendPanic({ token, displayName, room, home }) {
  safeSend({
    type: 'panic', token: token ?? null, displayName: displayName ?? null, room: room ?? null,
    homeMeeting: home?.meeting ?? null, homeToken: home?.token ?? null,
  });
}
