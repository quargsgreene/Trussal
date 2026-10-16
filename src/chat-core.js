// chat-core.js — pure logic for Trussal's own chat (chat-panel.js): the
// message-length cap/trim. No DOM, no bus — runs identically in the browser
// bundle and under node:test.
//
// Trussal no longer has (or needs) the Jitsi web app's chat: the panel is
// Trussal's own (chat-panel.js) and plain messages ride the existing WS
// sidecar bus. This module holds the one rule both ends of that wire share —
// the sender trims/caps before sending and the sidecar re-caps before relaying,
// so a hand-crafted frame cannot exceed the limit.

export const MAX_CHAT_MESSAGE_LENGTH = 2000;

// Normalise a chat line: strings only, trimmed, capped. '' means "nothing to
// send" and is what both callers skip on.
export function normaliseChatMessage(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_CHAT_MESSAGE_LENGTH
    ? trimmed.slice(0, MAX_CHAT_MESSAGE_LENGTH)
    : trimmed;
}

// The name shown above a chat line. Falls back to the room's default label so a
// line is never byline-less.
export function chatByline(name, fallback = 'participant') {
  if (typeof name === 'string' && name.trim()) return name.trim();
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return 'participant';
}
