// chat-panel.js — Trussal's own chat panel.
//
// Replaces the Jitsi web app's chat window (and the window.APP Redux store it
// was driven through). Two kinds of traffic land in it:
//
//   * Program output — words (text-cycles.js), attachments (file-cycles.js) and
//     polls (polls.js). Every browser evaluates every peer's program, so these
//     need no messages at all: each renderer paints its own containers LOCALLY
//     and only needs somewhere to live. That somewhere is this panel.
//   * Plain chat lines — typed here and relayed over the existing WS sidecar
//     bus (peer-state.js's sendChatMessage / the 'chat-message' relay), the same
//     transport every other cross-peer feature already uses. No XMPP, no store.
//
// The panel OWNS the log ids the program renderers key off — #chatconversation
// and the #messagesListEnd sentinel — so they attach here unchanged. It is built
// at module load and stays in the document (hidden while closed), so those ids
// always exist and there is no "the chat panel is unmounted" state to wait out.

import {
  sendChatMessage as sendBusChatMessage,
  subscribePeerState,
  getAllPeers,
} from './peer-state.js';
import { getLocalParticipant } from './participants.js';
import { normaliseChatMessage, chatByline, MAX_CHAT_MESSAGE_LENGTH } from './chat-core.js';
import chatStyles from './chat-panel.css';

const PANEL_ID = 'trussal-chat-panel';
const LAUNCHER_ID = 'trussal-chat-launcher';
const LOG_ID = 'chatconversation';
const SENTINEL_ID = 'messagesListEnd';
const STYLE_ID = 'trussal-chat-panel-style';
const NAME_STORAGE_KEY = 'trussal.chatName.v1';
const MAX_MESSAGES = 200;

let panelEl = null;
let logEl = null;
let nameOverride = null;

function safeStorage() {
  try { return (typeof window !== 'undefined' && window.localStorage) || null; }
  catch (e) { return null; } // storage can throw when disabled by the browser
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = chatStyles;
  (doc.head || doc.body).appendChild(style);
}

// The local participant's chat byline. Prefers the display name the meeting
// backend reports (the name chosen at prejoin), then the sidecar peer record,
// then a name set locally by setLocalChatName().
export function localChatName() {
  try {
    const p = getLocalParticipant();
    const fromParticipant = p && typeof p.displayName === 'string' ? p.displayName.trim() : '';
    if (fromParticipant) return fromParticipant;
  } catch (e) { /* fall through to the other sources */ }
  try {
    const local = getAllPeers().find((peer) => peer && peer.isLocal);
    const fromPeer = local && typeof local.displayName === 'string' ? local.displayName.trim() : '';
    if (fromPeer) return fromPeer;
  } catch (e) { /* fall through */ }
  if (nameOverride) return nameOverride;
  const stored = safeStorage();
  if (stored) {
    try { const s = stored.getItem(NAME_STORAGE_KEY); if (s && s.trim()) return s.trim(); } catch (e) { /* ignore */ }
  }
  return null;
}

// Name the local participant when the backend reports none (the JPattern room
// index token, typically). Returns whether a usable name is set now.
export function setLocalChatName(name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean === 'You') return !!localChatName();
  nameOverride = clean;
  const stored = safeStorage();
  if (stored) { try { stored.setItem(NAME_STORAGE_KEY, clean); } catch (e) { /* ignore */ } }
  return true;
}

// The name for a peer identified by its sidecar room index (what the relay
// stamps on a forwarded line). Null when no peer matches.
function nameForIndex(fromIndex) {
  if (fromIndex == null) return null;
  try {
    const peer = getAllPeers().find((p) => p && String(p.roomIndex) === String(fromIndex));
    return peer && typeof peer.displayName === 'string' ? peer.displayName.trim() || null : null;
  } catch (e) { return null; }
}

function scrollToEnd() {
  if (!logEl) return;
  // Follow the conversation only if the reader is already at the bottom, so
  // scrolling back through history is not yanked away by the next line.
  if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function appendMessage({ name, text, own = false }) {
  if (!logEl) return;
  const bubble = document.createElement('div');
  bubble.className = 'tc-msg' + (own ? ' tc-msg-own' : '');

  const byline = document.createElement('div');
  byline.className = 'tc-msg-name';
  byline.textContent = chatByline(name, own ? 'You' : 'participant');

  const body = document.createElement('div');
  body.className = 'tc-msg-body';
  // textContent — a chat line is user-controlled and must never be markup.
  body.textContent = text;

  bubble.appendChild(byline);
  bubble.appendChild(body);

  const sentinel = logEl.querySelector('#' + SENTINEL_ID);
  if (sentinel && sentinel.parentNode === logEl) logEl.insertBefore(bubble, sentinel);
  else logEl.appendChild(bubble);

  const messages = logEl.querySelectorAll('.tc-msg');
  for (let i = 0; i < messages.length - MAX_MESSAGES; i++) messages[i].remove();

  scrollToEnd();
}

// Build the panel + launcher once. Idempotent; returns the panel element (or
// null where there is no DOM yet).
export function ensureChatPanel() {
  if (panelEl && document.contains(panelEl)) return panelEl;
  if (typeof document === 'undefined' || !document.body) return null;
  ensureStyle(document);

  panelEl = document.getElementById(PANEL_ID);
  if (!panelEl) {
    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.className = 'tc-panel';
    panelEl.innerHTML = `
      <div class="tc-panel-header">
        <span class="tc-panel-title">Chat</span>
        <button type="button" class="tc-panel-close" aria-label="Close chat">×</button>
      </div>
      <div class="tc-panel-log" id="${LOG_ID}">
        <div id="${SENTINEL_ID}"></div>
      </div>
      <form class="tc-panel-form">
        <input class="tc-panel-input" type="text" maxlength="${MAX_CHAT_MESSAGE_LENGTH}"
               placeholder="Message" autocomplete="off" aria-label="Message"/>
        <button type="submit" class="tc-panel-send">Send</button>
      </form>
    `;
    document.body.appendChild(panelEl);

    const close = panelEl.querySelector('.tc-panel-close');
    if (close) close.addEventListener('click', () => closeChatPanel());

    const form = panelEl.querySelector('.tc-panel-form');
    const input = panelEl.querySelector('.tc-panel-input');
    if (form) {
      form.addEventListener('submit', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        sendChatMessage(input ? input.value : '');
        if (input) input.value = '';
      });
    }
  }
  logEl = panelEl.querySelector('#' + LOG_ID);

  if (!document.getElementById(LAUNCHER_ID)) {
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.id = LAUNCHER_ID;
    launcher.textContent = 'Chat';
    launcher.addEventListener('click', () => toggleChatPanel());
    document.body.appendChild(launcher);
  }

  return panelEl;
}

export function getChatLogElement() {
  if (logEl && document.contains(logEl)) return logEl;
  return (typeof document !== 'undefined') ? document.getElementById(LOG_ID) : null;
}

export function isChatPanelOpen() {
  const el = (typeof document !== 'undefined') ? document.getElementById(PANEL_ID) : null;
  return !!(el && el.classList && el.classList.contains('is-open'));
}

export function openChatPanel() {
  const el = ensureChatPanel();
  if (el && el.classList) el.classList.add('is-open');
  scrollToEnd();
}

export function closeChatPanel() {
  const el = (typeof document !== 'undefined') ? document.getElementById(PANEL_ID) : null;
  if (el && el.classList) el.classList.remove('is-open');
}

export function toggleChatPanel() {
  if (isChatPanelOpen()) closeChatPanel();
  else openChatPanel();
}

// Attach `container` inside the chat log, before the #messagesListEnd sentinel
// the scroll logic keeps last. Returns whether it is attached.
export function attachToChatLog(container) {
  const log = getChatLogElement();
  if (!log || !container) return false;
  if (container.parentNode === log) return true;
  const sentinel = log.querySelector('#' + SENTINEL_ID);
  if (sentinel && sentinel.parentNode === log) log.insertBefore(container, sentinel);
  else log.appendChild(container);
  return container.parentNode === log;
}

// Send a plain chat line: render it locally (we are not on the relay's
// recipient list) and hand it to the bus for everyone else.
export function sendChatMessage(text) {
  const clean = normaliseChatMessage(text);
  if (!clean) return false;
  appendMessage({ name: localChatName(), text: clean, own: true });
  sendBusChatMessage(clean);
  return true;
}

subscribePeerState((event, payload) => {
  if (event !== 'chat-message') return;
  const text = normaliseChatMessage(payload && payload.text);
  if (!text) return;
  appendMessage({ name: nameForIndex(payload.fromIndex), text });
});

// Build as soon as the module loads, so #chatconversation exists before any
// Strudel program (and so any renderer's first attach succeeds). Deferred to
// DOMContentLoaded when the body is not ready yet.
if (typeof document !== 'undefined') {
  if (document.body) ensureChatPanel();
  else document.addEventListener('DOMContentLoaded', () => ensureChatPanel());
}
