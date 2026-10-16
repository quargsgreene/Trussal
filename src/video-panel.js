// video-panel.js — Trussal's own in-call video layout.
//
// The Jitsi web app rendered the meeting's video surfaces: a large video (the
// active speaker / the Aggregator's feed) and a filmstrip of participant tiles.
// Replacing the app shell (public/index.html) removed them, and lib-jitsi-meet
// itself renders NO per-participant video elements — it only carries the tracks.
// This module rebuilds the layout:
//
//   * `#largeVideoContainer > #largeVideoWrapper > video#largeVideo` for the
//     large video, and
//   * `#filmstrip` holding one tile per participant, each tile `id`ed
//     `participant_<jitsiId>` and carrying a muted `<video>` for that
//     participant's stream.
//
// Those ids are not cosmetic: Grid.js marks `#participant_<jitsiId>`, and
// remote-tracks.js / live-capture.js read `#participant_<jitsiId> video`, so the
// panel is what makes the Grid overlay and bot capture work again. The tile
// videos are muted — remote audio is played by lib-jitsi-meet's own <audio>
// elements and routed through the audio engine, never by this panel.
//
// The panel also asserts JVB receiver constraints (see video-panel-core.js):
// without a visible tile asking for a participant's video, the bridge never
// forwards it, so binding alone would leave every remote tile black.
//
// Styling lives in video-panel.css, imported as raw text and injected once (the
// same mechanism studio.js/chat-panel.js use) — no inline style attributes.

import { subscribeParticipants } from './participants.js';
import { getConference, isInMeeting } from './meeting-adapter.js';
import { getRemoteVideoStream } from './remote-tracks.js';
import { getPublishedVideoTrack } from './published-video.js';
import { subscribePeerState, getAllPeers } from './peer-state.js';
import {
  tileIdFor,
  remoteVideoIdFor,
  orderPanelParticipants,
  chooseLargeVideoId,
  normalizeLayout,
  receiverConstraintsPayload,
  humanUiWanted,
} from './video-panel-core.js';
import videoPanelStyles from './video-panel.css';

const PANEL_ID = 'trussal-video-panel';
const FILMSTRIP_ID = 'filmstrip';
const LARGE_VIDEO_ID = 'largeVideo';
const LARGE_NAME_ID = 'largeVideoName';
const STYLE_ID = 'trussal-video-panel-style';

// The conference roster (participants.js): id -> { id, displayName, isLocal }.
// The authoritative participant list; enriched with aggregator flags from the
// sidecar peer records on each sync.
const roster = new Map();

let panelEl = null;
let filmstripEl = null;
let largeVideoEl = null;
let largeNameEl = null;

// A participant the user pinned into the large video by clicking their tile.
// Null means "choose automatically" (Aggregator, then first remote, then local).
let pinnedId = null;

// Which layout the panel draws: 'speaker' (a large video plus a filmstrip) or
// 'tiles' (an even grid of every participant, Jitsi's "tile view"). Persisted
// so the choice survives a reload.
const VIEW_STORAGE_KEY = 'trussal.videoView.v1';
let layout = readStoredLayout();

function readStoredLayout() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'speaker';
    return normalizeLayout(window.localStorage.getItem(VIEW_STORAGE_KEY));
  } catch (e) { return 'speaker'; }
}

function persistLayout() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(VIEW_STORAGE_KEY, layout);
    }
  } catch (e) { /* storage disabled — the choice just will not persist */ }
}

let syncScheduled = false;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = videoPanelStyles;
  (doc.head || doc.body).appendChild(style);
}

function createVideoElement(id) {
  const video = document.createElement('video');
  video.id = id;
  video.className = 'vp-video';
  video.autoplay = true;
  video.muted = true; // audio is never played by this panel — see the header
  video.playsInline = true;
  // Older browsers/tests expose the attribute rather than the property.
  if (typeof video.setAttribute === 'function') video.setAttribute('playsinline', '');
  return video;
}

// Build the panel DOM once. Idempotent; returns the panel element (or null
// where there is no body yet).
export function ensureVideoPanel() {
  if (panelEl && typeof document !== 'undefined' && document.contains(panelEl)) return panelEl;
  if (typeof document === 'undefined' || !document.body) return null;
  ensureStyle(document);

  panelEl = document.getElementById(PANEL_ID);
  if (!panelEl) {
    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.innerHTML = `
      <div id="${FILMSTRIP_ID}" class="vp-filmstrip"></div>
      <div id="largeVideoContainer">
        <div id="largeVideoWrapper"></div>
        <div class="vp-large-name" id="${LARGE_NAME_ID}"></div>
      </div>
    `;
    document.body.appendChild(panelEl);
  }

  const wrapper = panelEl.querySelector('#largeVideoWrapper');
  largeVideoEl = panelEl.querySelector('#' + LARGE_VIDEO_ID);
  if (!largeVideoEl && wrapper) {
    largeVideoEl = createVideoElement(LARGE_VIDEO_ID);
    largeVideoEl.className = 'vp-video vp-large-video';
    wrapper.appendChild(largeVideoEl);
  }
  largeNameEl = panelEl.querySelector('#' + LARGE_NAME_ID);
  filmstripEl = panelEl.querySelector('#' + FILMSTRIP_ID);
  applyLayoutClass();
  return panelEl;
}

export function getVideoPanelElement() {
  if (panelEl && typeof document !== 'undefined' && document.contains(panelEl)) return panelEl;
  return (typeof document !== 'undefined') ? document.getElementById(PANEL_ID) : null;
}

// A MediaStream for the local participant's published video, or null when
// nothing is published (camera still off). The published track is the Trussal
// canvas, so the local tile shows exactly what the room receives. The stream is
// cached by the underlying track id: rebuilding one on every sync would hand
// the <video> a fresh object each tick and rebind (flicker) even though the
// media is unchanged.
let localCache = { trackId: null, stream: null };

function localVideoStream() {
  const track = getPublishedVideoTrack();
  const mediaStreamTrack = track
    ? (typeof track.getTrack === 'function' ? track.getTrack() : (track.track || null))
    : null;
  if (!mediaStreamTrack) {
    localCache = { trackId: null, stream: null };
    return null;
  }
  if (localCache.trackId === mediaStreamTrack.id && localCache.stream) return localCache.stream;
  let stream = null;
  try { stream = new MediaStream([mediaStreamTrack]); } catch (e) { stream = null; }
  localCache = { trackId: mediaStreamTrack.id, stream };
  return stream;
}

function streamFor(p) {
  if (p.isLocal) return localVideoStream();
  return getRemoteVideoStream(p.id);
}

function bindVideo(videoEl, stream) {
  if (!videoEl) return;
  if (videoEl.srcObject === stream) return;
  videoEl.srcObject = stream || null;
  if (stream) {
    const played = videoEl.play && videoEl.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }
}

// The participant list the panel renders, in stable order, with the aggregator
// flag attached from the sidecar's peer records (participants.js does not carry
// it).
function currentList() {
  const aggregatorIds = new Set();
  const botIds = new Set();
  try {
    for (const p of getAllPeers()) {
      if (!p || !p.jitsiId) continue;
      if (p.isAggregator) aggregatorIds.add(p.jitsiId);
      if (p.isBot) botIds.add(p.jitsiId);
    }
  } catch (e) { /* peer state not ready yet — no aggregator/bot flags this pass */ }

  const raw = [];
  for (const p of roster.values()) {
    if (!p || !p.id) continue;
    raw.push({
      ...p,
      isAggregator: aggregatorIds.has(p.id),
      isBot: botIds.has(p.id),
    });
  }
  return orderPanelParticipants(raw);
}

function createTile(p) {
  const tile = document.createElement('div');
  tile.id = tileIdFor(p.id);
  tile.className = 'vp-tile';
  tile.dataset.participantId = p.id;

  const video = createVideoElement(p.isLocal ? 'localVideo' : remoteVideoIdFor(p.id));
  const label = document.createElement('div');
  label.className = 'vp-tile-label';

  tile.appendChild(video);
  tile.appendChild(label);
  tile.addEventListener('click', () => {
    pinnedId = (pinnedId === p.id) ? null : p.id; // click the pinned tile to unpin
    syncPanel();
  });
  return tile;
}

function updateTile(tile, p, largeId) {
  tile.className = 'vp-tile'
    + (p.isLocal ? ' is-local' : '')
    + (p.id === largeId ? ' is-large' : '');
  const label = tile.querySelector('.vp-tile-label');
  if (label) {
    const name = p.displayName || (p.isLocal ? 'You' : 'Participant');
    label.textContent = p.isBot ? `${name} (bot)` : name;
  }
  const video = tile.querySelector('video');
  const stream = streamFor(p);
  bindVideo(video, stream);
  tile.classList.toggle('is-off', !stream);
}

// Reconcile the filmstrip: drop departed tiles, create new ones, and re-append
// in list order so the DOM order matches currentList().
function renderTiles(list, largeId) {
  if (!filmstripEl) return;
  const wanted = new Set();
  for (const p of list) {
    wanted.add(tileIdFor(p.id));
    let tile = document.getElementById(tileIdFor(p.id));
    if (!tile || tile.parentNode !== filmstripEl) {
      if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
      tile = createTile(p);
    }
    updateTile(tile, p, largeId);
    filmstripEl.appendChild(tile); // move-to-end = list order
  }
  for (const child of Array.from(filmstripEl.children)) {
    if (!wanted.has(child.id)) child.remove();
  }
}

function renderLarge(list, largeId) {
  const p = list.find((x) => x.id === largeId) || null;
  const stream = p ? streamFor(p) : null;
  bindVideo(largeVideoEl, stream);
  if (largeVideoEl) largeVideoEl.classList.toggle('is-off', !stream);
  if (largeNameEl) {
    largeNameEl.textContent = p ? (p.displayName || (p.isLocal ? 'You' : 'Participant')) : '';
  }
}

// Ask the bridge for every participant's video. Cheap and idempotent — the bot
// page re-asserts it every tick (see page-scripts.js) because lib-jitsi-meet
// no-ops an unchanged object — but peer state can change in bursts, so throttle
// to at most once per second rather than once per sync.
let lastConstraintsAt = 0;
const CONSTRAINTS_MIN_INTERVAL_MS = 900;

function applyReceiverConstraints() {
  const now = Date.now();
  if (now - lastConstraintsAt < CONSTRAINTS_MIN_INTERVAL_MS) return;
  lastConstraintsAt = now;

  const conf = getConference();
  if (!conf) return;
  const payload = receiverConstraintsPayload();
  const targets = [conf, conf._room];
  for (const target of targets) {
    if (target && typeof target.setReceiverConstraints === 'function') {
      try { target.setReceiverConstraints(payload); return; } catch (e) { /* try the next target */ }
    }
  }
  // Older lib-jitsi-meet surfaces.
  if (typeof conf.setLastN === 'function') { try { conf.setLastN(-1); } catch (e) { /* ignore */ } }
  const room = conf._room;
  if (room && typeof room.setReceiverVideoConstraint === 'function') {
    try { room.setReceiverVideoConstraint(360); } catch (e) { /* ignore */ }
  }
}

// Reconcile the whole panel against the current roster and media.
export function syncVideoPanel() {
  const list = currentList();
  const largeId = chooseLargeVideoId(list, { pinnedId });
  renderTiles(list, largeId);
  renderLarge(list, largeId);
  applyReceiverConstraints();
}

// --- Layout (speaker view vs tile view) -------------------------------------

function applyLayoutClass() {
  const el = getVideoPanelElement();
  if (el) el.classList.toggle('is-tiles', layout === 'tiles');
}

export function getVideoLayout() { return layout; }

export function setVideoLayout(next) {
  layout = normalizeLayout(next);
  persistLayout();
  applyLayoutClass();
  if (isInMeeting()) syncVideoPanel();
  return layout;
}

export function toggleVideoLayout() {
  return setVideoLayout(layout === 'tiles' ? 'speaker' : 'tiles');
}

function scheduleSync() {
  if (!humanUiWanted()) return;
  if (syncScheduled) return;
  syncScheduled = true;
  const run = () => { syncScheduled = false; if (isInMeeting()) syncVideoPanel(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

// The panel is human-facing chrome. Bots and the aggregator load this same
// bundle, but they run headless and composite their own video (bots/src/bot),
// so they must not grow a second copy of the layout; skip them entirely so a
// bot page's DOM is byte-for-byte what it was before this module existed.
export function tickVideoPanel() {
  if (typeof document === 'undefined' || !document.body) return;
  if (!humanUiWanted() || !isInMeeting()) {
    const el = getVideoPanelElement();
    if (el) el.classList.add('is-hidden');
    return;
  }
  const el = ensureVideoPanel();
  if (!el) return;
  el.classList.remove('is-hidden');
  applyLayoutClass();
  syncVideoPanel();
}

subscribeParticipants((event, p) => {
  if (!p || !p.id) return;
  if (event === 'local' || event === 'local-update') {
    // The local endpoint id can change under a live session (participants.js
    // clears its cache and re-emits 'local' when the conference identity
    // changes — a reconnect / rebuild — and it deliberately does NOT emit
    // 'local-leave', because that would navigate the tab back to the lobby).
    // Drop any earlier local entry, or the filmstrip keeps the stale tile and
    // draws two "You"s.
    for (const id of Array.from(roster.keys())) {
      if (id !== p.id && roster.get(id) && roster.get(id).isLocal) roster.delete(id);
    }
    roster.set(p.id, { id: p.id, displayName: p.displayName, isLocal: true });
  } else if (event === 'join' || event === 'update') roster.set(p.id, { id: p.id, displayName: p.displayName, isLocal: false });
  else if (event === 'leave') roster.delete(p.id);
  else if (event === 'local-leave') { roster.clear(); pinnedId = null; }
  scheduleSync();
});

// The aggregator flag arrives over the sidecar, not the conference roster;
// re-sync when peer state changes so the large video can switch to its feed.
subscribePeerState(() => scheduleSync());

if (typeof document !== 'undefined') {
  if (document.readyState === 'complete' || document.readyState === 'interactive') tickVideoPanel();
  else document.addEventListener('DOMContentLoaded', tickVideoPanel);
}
setInterval(tickVideoPanel, 1000);
