// walkie-talkie.js — Walkie Talkie Mode.
//
// A checkbox in the Personal Theme settings (theme-context.js `walkieTalkie`).
// While it is checked, this participant:
//
//   * talks with every OTHER Walkie Talkie Mode participant over bare camera +
//     microphone — the real devices, via published-video.js's openCamera(),
//     not the Hydra canvas or Strudel output the meeting carries — in a small
//     screen in the bottom-left corner. The media goes browser to browser
//     over a mesh of RTCPeerConnections; the sidecar only relays the
//     signalling ('walkie-signal'), and only between walkie peers.
//   * has, as far as the rest of the meeting knows, LEFT. The sidecar sends
//     every non-walkie participant a peer-leave (server.js hiddenFrom), so
//     the aggregator drops them from its rotation exactly as it would a
//     departure, and studios, the metaprogram and every other roster consumer
//     stop seeing them. Their Jitsi session stays up, so the browsers left
//     behind also hide their Jitsi tile and hold their audio silent (from the
//     'walkie-roster' broadcast); and this browser silences the whole meeting
//     for itself (latency-instrument.js setMeetingMuted).
//   * is NOT counted as gone for ending the meeting: the fleet service still
//     sees them as a present human, so a room where every human is in Walkie
//     Talkie Mode keeps its aggregator and is not torn down. Their own bot
//     cluster does follow the ordinary owner-left grace (fleet-service.js
//     #setWalkie), as it would had they really left.
//
// Unchecking it reverses all of that: the sidecar announces a fresh peer-join
// and the meeting picks them back up where it left off.

import { getTheme, subscribeTheme } from './theme-context.js';
import { subscribeParticipants, getLocalParticipant } from './participants.js';
import {
  subscribePeerState, setLocalWalkie, getWalkieRoster, sendWalkieSignal, getMyPeerId,
} from './peer-state.js';
import { setWalkieAwayPeers, setMeetingMuted } from './latency-instrument.js';
import { openCamera } from './published-video.js';
import {
  isOfferer, walkieAwayJitsiIds, walkiePartners, diffConnections, iceServersFrom, walkieLabel,
} from './walkie-talkie-core.js';

const PANEL_ID = 'trussal-walkie';
const AWAY_ATTR = 'data-trussal-walkie-away';
// Jitsi re-renders its tiles, dropping nothing it didn't put there itself but
// also creating fresh ones for late joiners — re-mark on the same 1s poll the
// rest of the codebase uses for Jitsi's DOM.
const AWAY_SWEEP_MS = 1000;
const MEDIA_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
};

let active = false;
let inCall = !!getLocalParticipant();
let localStream = null;
let mediaRequest = null;     // in-flight openCamera() promise
let mediaError = null;       // why there is no localStream, for the status line
let micOn = true;
let camOn = true;
let panel = null;
let awayJitsiIds = [];
const conns = new Map();     // remote peerId -> connection record (see openConnection)

// --- Hiding walkie participants from a non-walkie view ----------------------

function sweepAwayTiles() {
  const doc = globalThis.document;
  if (!doc) return;
  const want = new Set(awayJitsiIds);
  doc.querySelectorAll(`[${AWAY_ATTR}]`).forEach((el) => {
    if (!want.has(el.getAttribute(AWAY_ATTR))) el.removeAttribute(AWAY_ATTR);
  });
  for (const id of want) {
    const tile = doc.getElementById(`participant_${id}`);
    if (tile && tile.getAttribute(AWAY_ATTR) !== id) tile.setAttribute(AWAY_ATTR, id);
  }
}

function refreshAway() {
  awayJitsiIds = walkieAwayJitsiIds(getWalkieRoster(), { localWalkie: active, myPeerId: getMyPeerId() });
  setWalkieAwayPeers(awayJitsiIds);
  sweepAwayTiles();
}

// --- Local media ------------------------------------------------------------

async function ensureLocalStream() {
  if (localStream || mediaRequest) return mediaRequest;
  mediaError = null;
  mediaRequest = openCamera(MEDIA_CONSTRAINTS)
    .catch(() => openCamera({ audio: MEDIA_CONSTRAINTS.audio }))  // no camera → voice only
    .then((stream) => {
      mediaRequest = null;
      if (!active) { stream.getTracks().forEach((t) => t.stop()); return null; }
      localStream = stream;
      applyTrackToggles();
      for (const conn of conns.values()) addLocalTracks(conn);
      renderPanel();
      return stream;
    })
    .catch((e) => {
      mediaRequest = null;
      mediaError = (e && e.name === 'NotAllowedError')
        ? 'camera and microphone blocked — listening only'
        : 'no camera or microphone — listening only';
      console.warn('[walkie] could not open camera/microphone', e);
      renderPanel();
      return null;
    });
  return mediaRequest;
}

function stopLocalStream() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  mediaError = null;
}

function applyTrackToggles() {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; });
  localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; });
}

// --- Peer connections (perfect negotiation) ---------------------------------
//
// Either side may need to (re)negotiate — the camera can arrive after the
// connection opened — so this is the standard "perfect negotiation" pattern:
// both sides offer when they need to, and on a collision the polite side
// (the non-offerer by isOfferer) yields. The sidecar relays in order over one
// socket, so a description always lands before its candidates.

function addLocalTracks(conn) {
  if (!localStream) return;
  const sending = new Set(conn.pc.getSenders().map((s) => s.track).filter(Boolean));
  for (const track of localStream.getTracks()) {
    if (!sending.has(track)) conn.pc.addTrack(track, localStream);
  }
}

function openConnection(peer) {
  const pc = new RTCPeerConnection({ iceServers: iceServersFrom(globalThis.config) });
  const conn = {
    peer,
    pc,
    polite: !isOfferer(getMyPeerId(), peer.peerId),
    makingOffer: false,
    ignoreOffer: false,
    stream: null,
    state: 'connecting',
  };
  conns.set(peer.peerId, conn);
  const signal = (data) => sendWalkieSignal(peer.peerId, data);

  pc.onicecandidate = ({ candidate }) => { if (candidate) signal({ candidate: candidate.toJSON() }); };
  pc.onnegotiationneeded = async () => {
    try {
      conn.makingOffer = true;
      await pc.setLocalDescription();
      signal({ description: pc.localDescription && pc.localDescription.toJSON() });
    } catch (e) {
      console.warn('[walkie] offer failed for', peer.peerId, e);
    } finally {
      conn.makingOffer = false;
    }
  };
  pc.ontrack = (ev) => {
    if (!conn.stream) conn.stream = ev.streams[0] || new MediaStream();
    if (!conn.stream.getTracks().includes(ev.track)) conn.stream.addTrack(ev.track);
    renderPanel();
  };
  pc.onconnectionstatechange = () => {
    conn.state = pc.connectionState;
    if (pc.connectionState === 'failed') pc.restartIce();
    renderPanel();
  };

  if (localStream) addLocalTracks(conn);
  else if (!conn.polite) {
    // Nothing to send yet, but the impolite side still opens the call so
    // this browser hears the others while its own devices are pending.
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
  }
  return conn;
}

function closeConnection(peerId) {
  const conn = conns.get(peerId);
  if (!conn) return;
  conns.delete(peerId);
  conn.pc.onicecandidate = conn.pc.onnegotiationneeded = conn.pc.ontrack = conn.pc.onconnectionstatechange = null;
  try { conn.pc.close(); } catch (e) { /* already closed */ }
}

async function onSignal({ from, data }) {
  if (!active || !data) return;
  let conn = conns.get(from);
  if (!conn) {
    // They saw the roster change before we did.
    const peer = walkiePartners(getWalkieRoster(), getMyPeerId()).find((p) => p.peerId === from);
    conn = openConnection(peer || { peerId: from });
    renderPanel();
  }
  const { pc } = conn;
  try {
    if (data.description) {
      const offer = data.description.type === 'offer';
      const collision = offer && (conn.makingOffer || pc.signalingState !== 'stable');
      conn.ignoreOffer = !conn.polite && collision;
      if (conn.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (offer) {
        await pc.setLocalDescription();
        sendWalkieSignal(from, { description: pc.localDescription && pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (e) {
        if (!conn.ignoreOffer) throw e;
      }
    }
  } catch (e) {
    console.warn('[walkie] signalling failed with', from, e);
  }
}

function syncConnections() {
  if (!active) return;
  const partners = walkiePartners(getWalkieRoster(), getMyPeerId());
  const { add, remove } = diffConnections(conns.keys(), partners);
  remove.forEach(closeConnection);
  for (const peer of partners) {
    const conn = conns.get(peer.peerId);
    if (conn) conn.peer = peer;                     // a rename since the last roster
    else if (add.includes(peer.peerId)) openConnection(peer);
  }
  renderPanel();
}

// --- The corner screen ------------------------------------------------------

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Walkie Talkie');
  panel.innerHTML = `
    <div class="tw-head">
      <span class="tw-title">Walkie Talkie</span>
      <button type="button" class="tw-btn" data-act="mic"></button>
      <button type="button" class="tw-btn" data-act="cam"></button>
      <button type="button" class="tw-btn" data-act="min" aria-label="Minimise"></button>
    </div>
    <div class="tw-grid"></div>
    <div class="tw-status"></div>
  `;
  panel.addEventListener('click', (ev) => {
    const act = ev.target && ev.target.closest && ev.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'mic') micOn = !micOn;
    else if (act.dataset.act === 'cam') camOn = !camOn;
    else if (act.dataset.act === 'min') panel.classList.toggle('tw-min');
    applyTrackToggles();
    renderPanel();
  });
  (document.body || document.documentElement).appendChild(panel);
  return panel;
}

// One tile per stream, reused across renders so a playing <video> is never
// torn down and restarted by an unrelated roster change.
function tileFor(grid, key, { label, stream, self, state }) {
  let tile = grid.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!tile) {
    tile = document.createElement('figure');
    tile.className = 'tw-tile';
    tile.dataset.key = key;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (self) { video.muted = true; tile.classList.add('tw-self'); }
    const caption = document.createElement('figcaption');
    tile.append(video, caption);
    grid.appendChild(tile);
  }
  const video = tile.querySelector('video');
  if (video.srcObject !== (stream || null)) {
    video.srcObject = stream || null;
    if (stream) video.play().catch(() => { /* autoplay refused — the next gesture's render retries */ });
  }
  tile.querySelector('figcaption').textContent =
    state && state !== 'connected' ? `${label} (${state})` : label;
  return tile;
}

function renderPanel() {
  if (!active) return;
  const el = ensurePanel();
  el.querySelector('[data-act="mic"]').textContent = micOn ? 'Mic on' : 'Mic off';
  el.querySelector('[data-act="mic"]').setAttribute('aria-pressed', String(!micOn));
  el.querySelector('[data-act="cam"]').textContent = camOn ? 'Cam on' : 'Cam off';
  el.querySelector('[data-act="cam"]').setAttribute('aria-pressed', String(!camOn));
  el.querySelector('[data-act="min"]').textContent = el.classList.contains('tw-min') ? '+' : '–';

  const grid = el.querySelector('.tw-grid');
  const keep = new Set(['self']);
  tileFor(grid, 'self', { label: 'You', stream: localStream, self: true });
  for (const [peerId, conn] of conns) {
    keep.add(peerId);
    tileFor(grid, peerId, { label: walkieLabel(conn.peer), stream: conn.stream, state: conn.state });
  }
  grid.querySelectorAll('.tw-tile').forEach((tile) => {
    if (!keep.has(tile.dataset.key)) tile.remove();
  });

  let status = '';
  if (mediaError) status = mediaError;
  else if (!localStream) status = 'opening camera and microphone…';
  if (!conns.size) status = status ? `${status} · no one else is in Walkie Talkie Mode yet` : 'No one else is in Walkie Talkie Mode yet';
  el.querySelector('.tw-status').textContent = status;
}

function removePanel() {
  if (!panel) return;
  panel.querySelectorAll('video').forEach((v) => { v.srcObject = null; });
  panel.remove();
  panel = null;
}

// --- On / off -----------------------------------------------------------------

function setActive(on) {
  if (on === active) return;
  active = on;
  setLocalWalkie(on);
  setMeetingMuted(on);
  refreshAway();
  if (on) {
    renderPanel();
    ensureLocalStream();
    syncConnections();
  } else {
    [...conns.keys()].forEach(closeConnection);
    stopLocalStream();
    removePanel();
  }
}

function evaluate() {
  setActive(!!getTheme().walkieTalkie && inCall);
}

if (typeof window !== 'undefined' && !window.__trussalIsBot && !window.__trussalIsAggregator) {
  subscribeTheme(evaluate);
  subscribeParticipants((event) => {
    if (event === 'local') { inCall = true; evaluate(); }
    else if (event === 'local-leave') { inCall = false; evaluate(); }
  });
  subscribePeerState((event, payload) => {
    if (event === 'walkie-roster') { refreshAway(); syncConnections(); }
    else if (event === 'walkie-signal') onSignal(payload);
    else if (event === 'connected') {
      // A reconnect is a new sidecar identity on both ends of every call.
      [...conns.keys()].forEach(closeConnection);
      renderPanel();
    }
  });
  setInterval(sweepAwayTiles, AWAY_SWEEP_MS);
  evaluate();
}
