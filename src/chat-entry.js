// chat-entry.js — Trussal-native replacement for the old "make sure the
// performer is in Jitsi's chat panel" helper.
//
// There is no Jitsi chat panel any more: Trussal owns one (chat-panel.js), and
// it is always in the document, so "entering the chat" is just opening the
// panel and attaching the caller's container to its log. The nickname step the
// Jitsi version needed (Jitsi gates its message log behind a display name) has
// no equivalent — Trussal's panel has no prompt — so the fallback name is only
// used as a byline when the local participant has no display name of its own.

import {
  openChatPanel,
  attachToChatLog,
  ensureChatPanel,
  localChatName,
  setLocalChatName,
} from './chat-panel.js';

export { openChatPanel, attachToChatLog } from './chat-panel.js';

const MAX_TRIES = 40;
const INTERVAL_MS = 500;

export function localParticipantName() {
  return localChatName();
}

// Name the local participant's chat byline when they have no display name of
// their own. Returns whether a usable name is set now. Trussal's chat has no
// "must have a name" gate, so a false return is not an error.
export function setNickname(name) {
  return setLocalChatName(name);
}

export function ensureChatEntry(container, fallbackName, isActive = () => true) {
  ensureChatPanel();
  let tries = 0;
  const attempt = () => {
    if (!isActive()) return;
    tries++;
    if (!localChatName() && fallbackName) setLocalChatName(fallbackName);
    openChatPanel();
    if (attachToChatLog(container)) return;
    if (tries >= MAX_TRIES) return;
    setTimeout(attempt, INTERVAL_MS);
  };
  attempt();
}
