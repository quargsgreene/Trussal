// in-call-toolbar.js — Trussal's own in-call toolbar.
//
// The Jitsi web app drew the meeting's control bar (mic, camera, screen share,
// chat, reactions, participants, hang up). Replacing the app shell
// (public/index.html) removed it, so this module rebuilds those controls
// Trussal-native, wired to the backend-neutral seams the rest of the bundle
// already uses:
//
//   * mic        — the lib-jitsi-meet conference's muteAudio/unmuteAudio, with
//                  published-audio.js's unpublish/publish as the fallback.
//   * camera     — published-video.js's ensureVideoPublished/unpublishVideo
//                  (which publish the Trussal canvas, never the raw camera).
//   * screen     — the Hydra source's initScreen (hydra-video.js wraps it so a
//                  shared screen also publishes the Hydra output).
//   * chat       — chat-panel.js's toggleChatPanel.
//   * reactions  — reactions-core.js's table, fired onto the Trussal overlay
//                  and relayed over the WS sidecar (peer-state.sendReaction).
//   * participants — a side panel over the conference roster.
//   * leave      — leave the conference and return to the lobby.
//
// Styling lives in in-call-toolbar.css, imported as raw text and injected once
// (the same mechanism studio.js/chat-panel.js use) — no inline style attributes.

import { getConference, isInMeeting } from './meeting-adapter.js';
import {
  ensureAudioPublished,
  unpublishAudio,
  hasPublishedAudioTrack,
} from './published-audio.js';
import {
  ensureVideoPublished,
  unpublishVideo,
  hasPublishedVideoTrack,
} from './published-video.js';
import { toggleChatPanel } from './chat-panel.js';
import { REACTIONS } from './reactions-core.js';
import { showReaction } from './reaction-overlay.js';
import { sendReaction, getLocalPeer, getAllPeers } from './peer-state.js';
import { subscribeParticipants } from './participants.js';
import { humanUiWanted } from './video-panel-core.js';
import { toggleVideoLayout, getVideoLayout } from './video-panel.js';
import toolbarStyles from './in-call-toolbar.css';

const TOOLBAR_ID = 'trussal-toolbar';
const PICKER_ID = 'trussal-reaction-picker';
const PEOPLE_ID = 'trussal-participants-panel';
const STYLE_ID = 'trussal-in-call-toolbar-style';

const roster = new Map(); // id -> { id, displayName, isLocal }

let toolbarEl = null;
let pickerEl = null;
let peopleEl = null;
let peopleListEl = null;
let peopleOpen = false;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = toolbarStyles;
  (doc.head || doc.body).appendChild(style);
}

function button(action, label, title) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tic-btn';
  el.dataset.action = action;
  el.textContent = label;
  el.title = title;
  el.setAttribute('aria-pressed', 'false');
  return el;
}

function buildToolbar() {
  toolbarEl = document.createElement('div');
  toolbarEl.id = TOOLBAR_ID;
  toolbarEl.setAttribute('role', 'toolbar');

  const mic = button('mic', 'Mic', 'Mute or unmute your microphone');
  const camera = button('camera', 'Camera', 'Start or stop publishing your video');
  const screen = button('screen', 'Share', 'Share your screen with the room');
  const view = button('view', 'Speaker', 'Switch between tile view and speaker view');
  const chat = button('chat', 'Chat', 'Open the chat panel');
  const react = button('reactions', 'React', 'Send a reaction');
  const people = button('participants', 'People', 'Show who is in the meeting');
  const leave = button('leave', 'Leave', 'Leave the meeting');
  leave.classList.add('tic-danger');

  toolbarEl.append(mic, camera, screen, view, chat, react, people, leave);

  toolbarEl.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target.closest('.tic-btn') : null;
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    handleAction(target.dataset.action);
  });

  document.body.appendChild(toolbarEl);
  return toolbarEl;
}

function buildPicker() {
  pickerEl = document.createElement('div');
  pickerEl.id = PICKER_ID;
  pickerEl.className = 'tic-popover';
  pickerEl.setAttribute('role', 'menu');
  for (const r of Object.values(REACTIONS)) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tic-reaction';
    el.dataset.reaction = r.id;
    el.textContent = r.emoji;
    el.title = r.label;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fireReaction(r.id);
      closePicker();
    });
    pickerEl.appendChild(el);
  }
  document.body.appendChild(pickerEl);
  return pickerEl;
}

function buildPeoplePanel() {
  peopleEl = document.createElement('div');
  peopleEl.id = PEOPLE_ID;
  peopleEl.className = 'tic-people';
  peopleEl.innerHTML = `
    <div class="tic-people-header">
      <span>Participants</span>
      <button type="button" class="tic-people-close" aria-label="Close participants">×</button>
    </div>
    <div class="tic-people-list"></div>
  `;
  peopleListEl = peopleEl.querySelector('.tic-people-list');
  const close = peopleEl.querySelector('.tic-people-close');
  if (close) close.addEventListener('click', () => setPeopleOpen(false));
  document.body.appendChild(peopleEl);
  return peopleEl;
}

export function ensureToolbar() {
  if (toolbarEl && typeof document !== 'undefined' && document.contains(toolbarEl)) return toolbarEl;
  if (typeof document === 'undefined' || !document.body) return null;
  ensureStyle(document);

  toolbarEl = document.getElementById(TOOLBAR_ID);
  if (!toolbarEl) buildToolbar();
  if (!document.getElementById(PICKER_ID)) buildPicker();
  if (!document.getElementById(PEOPLE_ID)) buildPeoplePanel();
  return toolbarEl;
}

// --- Control state ----------------------------------------------------------

function isMicMuted() {
  const conf = getConference();
  if (conf && typeof conf.isLocalAudioMuted === 'function') {
    try { return !!conf.isLocalAudioMuted(); } catch (e) { /* fall through */ }
  }
  return !hasPublishedAudioTrack();
}

function isCameraOn() {
  if (hasPublishedVideoTrack()) return true;
  const conf = getConference();
  if (conf && typeof conf.isLocalVideoMuted === 'function') {
    try { return !conf.isLocalVideoMuted(); } catch (e) { /* fall through */ }
  }
  return false;
}

function setPressed(action, on) {
  const el = toolbarEl && toolbarEl.querySelector(`.tic-btn[data-action="${action}"]`);
  if (!el) return;
  el.classList.toggle('is-on', !!on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function syncState() {
  if (!toolbarEl) return;
  const muted = isMicMuted();
  setPressed('mic', !muted);
  const micEl = toolbarEl.querySelector('.tic-btn[data-action="mic"]');
  if (micEl) micEl.textContent = muted ? 'Unmute' : 'Mic';
  const on = isCameraOn();
  setPressed('camera', on);
  const camEl = toolbarEl.querySelector('.tic-btn[data-action="camera"]');
  if (camEl) camEl.textContent = on ? 'Stop video' : 'Camera';
  const tiles = getVideoLayout() === 'tiles';
  setPressed('view', tiles);
  const viewEl = toolbarEl.querySelector('.tic-btn[data-action="view"]');
  if (viewEl) viewEl.textContent = tiles ? 'Tiles' : 'Speaker';
}

// --- Actions ----------------------------------------------------------------

async function toggleMic() {
  const conf = getConference();
  const muted = isMicMuted();
  try {
    if (muted) {
      // Unmute. Prefer the conference's own unmute (keeps the track and its
      // negotiated state), then make sure a track is actually published — a
      // join that started muted may have no local audio track at all, which
      // unmuteAudio alone does not always create.
      if (conf && typeof conf.unmuteAudio === 'function') {
        try { await conf.unmuteAudio(); } catch (e) { console.warn('[in-call-toolbar] unmuteAudio failed', e); }
      }
      if (!hasPublishedAudioTrack()) await ensureAudioPublished();
    } else if (conf && typeof conf.muteAudio === 'function') {
      await conf.muteAudio(true);
    } else {
      await unpublishAudio();
    }
  } catch (e) {
    console.warn('[in-call-toolbar] toggling the microphone failed', e);
  }
  syncState();
}

async function toggleCamera() {
  try {
    if (isCameraOn()) await unpublishVideo();
    else await ensureVideoPublished();
  } catch (e) {
    console.warn('[in-call-toolbar] toggling the camera failed', e);
  }
  syncState();
}

function shareScreen() {
  const s0 = (typeof globalThis !== 'undefined') ? globalThis.s0 : null;
  if (s0 && typeof s0.initScreen === 'function') {
    try { s0.initScreen(); } catch (e) { console.warn('[in-call-toolbar] screen share failed', e); }
    return;
  }
  console.warn('[in-call-toolbar] screen share needs an initialised Hydra source (s0.initScreen)');
}

function fireReaction(id) {
  const idx = getLocalPeer() ? getLocalPeer().roomIndex : null;
  showReaction(id, idx);
  sendReaction(id);
}

function leaveMeeting() {
  try {
    const conf = getConference();
    if (conf && typeof conf.leave === 'function') conf.leave();
  } catch (e) {
    console.warn('[in-call-toolbar] leaving the conference failed', e);
  }
  try {
    window.location.href = `${window.location.origin}/`;
  } catch (e) { /* no window — nothing to navigate */ }
}

function handleAction(action) {
  switch (action) {
    case 'mic': toggleMic(); break;
    case 'camera': toggleCamera(); break;
    case 'screen': shareScreen(); break;
    case 'view': toggleVideoLayout(); syncState(); break;
    case 'chat': toggleChatPanel(); break;
    case 'reactions': togglePicker(); break;
    case 'participants': setPeopleOpen(!peopleOpen); break;
    case 'leave': leaveMeeting(); break;
    default: break;
  }
}

// --- Popovers ---------------------------------------------------------------

function togglePicker() {
  if (!pickerEl) ensureToolbar();
  if (!pickerEl) return;
  pickerEl.classList.toggle('is-open');
}

function closePicker() {
  if (pickerEl) pickerEl.classList.remove('is-open');
}

function setPeopleOpen(open) {
  peopleOpen = !!open;
  if (peopleOpen) renderPeople();
  if (peopleEl) peopleEl.classList.toggle('is-open', peopleOpen);
}

function renderPeople() {
  if (!peopleListEl) return;
  const botIds = new Set();
  const aggregatorIds = new Set();
  try {
    for (const p of getAllPeers()) {
      if (!p || !p.jitsiId) continue;
      if (p.isBot) botIds.add(p.jitsiId);
      if (p.isAggregator) aggregatorIds.add(p.jitsiId);
    }
  } catch (e) { /* peer state not ready — show names only */ }

  const entries = [...roster.values()];
  entries.sort((a, b) => (a.isLocal === b.isLocal ? 0 : a.isLocal ? -1 : 1));

  peopleListEl.textContent = '';
  for (const p of entries) {
    const row = document.createElement('div');
    row.className = 'tic-people-row';
    const name = document.createElement('span');
    name.className = 'tic-people-name';
    name.textContent = p.displayName || (p.isLocal ? 'You' : 'Participant');
    row.appendChild(name);
    if (aggregatorIds.has(p.id)) {
      const tag = document.createElement('span');
      tag.className = 'tic-tag tic-tag-aggregator';
      tag.textContent = 'aggregator';
      row.appendChild(tag);
    } else if (botIds.has(p.id)) {
      const tag = document.createElement('span');
      tag.className = 'tic-tag';
      tag.textContent = 'bot';
      row.appendChild(tag);
    }
    peopleListEl.appendChild(row);
  }
}

// --- Lifecycle --------------------------------------------------------------

function hideAll() {
  if (toolbarEl) toolbarEl.classList.add('is-hidden');
  if (pickerEl) pickerEl.classList.remove('is-open');
  if (peopleEl) peopleEl.classList.remove('is-open');
  peopleOpen = false;
}

export function tickToolbar() {
  if (typeof document === 'undefined' || !document.body) return;
  if (!humanUiWanted() || !isInMeeting()) { hideAll(); return; }
  const el = ensureToolbar();
  if (!el) return;
  el.classList.remove('is-hidden');
  if (peopleOpen) renderPeople();
  syncState();
}

subscribeParticipants((event, p) => {
  if (!p || !p.id) return;
  if (event === 'leave') roster.delete(p.id);
  else if (event === 'local-leave') roster.clear();
  else roster.set(p.id, { id: p.id, displayName: p.displayName, isLocal: event === 'local' || event === 'local-update' || !!p.isLocal });
  if (peopleOpen) renderPeople();
});

if (typeof document !== 'undefined') {
  if (document.readyState === 'complete' || document.readyState === 'interactive') tickToolbar();
  else document.addEventListener('DOMContentLoaded', tickToolbar);
}
setInterval(tickToolbar, 1000);
