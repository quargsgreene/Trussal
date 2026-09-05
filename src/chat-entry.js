// chat-entry.js — shared "make sure the performer is IN Jitsi's chat panel"
// bootstrap for silent-by-construction voices that render into the chat log
// (file-cycles.js, polls.js). Text Cycles solves this same problem with its
// own richer, debug-instrumented version (text-cycles.js's ensureChatEntry) —
// not reused here because it is wired into text-debug.js's word-specific
// logging channel; this is the plain version for anything else that just
// needs a nickname, an open panel, and a container attached to
// #chatconversation. See text-cycles.js's file doc comment for why any of
// this is necessary at all (Jitsi gates the message log behind a nickname).

const CHAT_ENTRY_MAX_TRIES = 40;
const CHAT_ENTRY_INTERVAL_MS = 500;

function jitsiState() {
  const store = typeof window !== 'undefined' ? window.APP?.store : null;
  return store && typeof store.getState === 'function' ? store.getState() : null;
}

function localParticipantName() {
  const state = jitsiState();
  const name = state?.['features/base/participants']?.local?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

// Exactly what Jitsi's own nickname form dispatches — see text-cycles.js's
// setNickname for the fuller rationale.
function setNickname(name) {
  const store = typeof window !== 'undefined' ? window.APP?.store : null;
  if (!store || typeof store.dispatch !== 'function') return false;
  store.dispatch({ type: 'SETTINGS_UPDATED', settings: { displayName: name } });
  return true;
}

function openChatPanel() {
  try {
    window.APP?.store?.dispatch({ type: 'OPEN_CHAT' });
  } catch (e) {
    console.warn('[chat-entry] could not open the chat panel', e);
  }
}

// Attach `container` inside #chatconversation, before the #messagesListEnd
// sentinel Jitsi's own scroll-to-bottom observer watches — the same
// insertion point text-cycles.js's ensureContainer uses. Leaves the
// container wherever it already is while chat is closed (the panel is
// unmounted entirely then); the caller keeps painting into a detached node
// until it reopens. Returns whether the container is attached.
export function attachToChatLog(container) {
  const log = document.getElementById('chatconversation');
  if (log && container.parentNode !== log) {
    const sentinel = document.getElementById('messagesListEnd');
    if (sentinel && sentinel.parentNode === log) log.insertBefore(container, sentinel);
    else log.appendChild(container);
  }
  return container.parentNode === log && !!log;
}

// Take a fallback nickname (only if the local participant has none of their
// own — Jitsi shows a nickname prompt INSTEAD of the message list otherwise),
// open the panel, and keep retrying the attach until it succeeds or the tries
// run out. `isActive()` lets the caller abandon the loop once its own voice
// has stopped, so a performer who stops mid-retry does not keep polling.
export function ensureChatEntry(container, fallbackName, isActive = () => true) {
  let tries = 0;
  const attempt = () => {
    if (!isActive()) return;
    tries++;
    if (!localParticipantName() && fallbackName) setNickname(fallbackName);
    openChatPanel();
    if (attachToChatLog(container)) return;
    if (tries >= CHAT_ENTRY_MAX_TRIES) return;
    setTimeout(attempt, CHAT_ENTRY_INTERVAL_MS);
  };
  attempt();
}
