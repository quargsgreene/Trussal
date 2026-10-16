// reactions-core.js — pure logic for Reaction patterns: the abbreviation
// table a reaction() mini-notation atom resolves against, and the
// default/clamped unreact() duration. No DOM, no Strudel — runs identically
// in the browser bundle and under node:test. The browser glue (dispatching
// Jitsi's own reaction, and the JPattern turn gate) lives in reactions.js.
//
// A reaction() atom is always one of the abbreviations below, never the full
// Jitsi name — a name like "Thumbs Up" contains a space and so is not a
// legal mini-notation atom (krill.pegjs's bare-atom grammar has no room for
// one; see text-cycles-core.js for the fuller version of this problem). The
// abbreviations exist for exactly that reason, so — unlike word() — a
// reaction() pattern needs no atom minting at all.

export const REACTIONS = {
  tu: { id: 'like', label: 'Thumbs Up', emoji: '👍' },
  su: { id: 'surprised', label: 'Surprise', emoji: '😲' },
  si: { id: 'silence', label: 'Silence', emoji: '🤫' },
  la: { id: 'laugh', label: 'Laugh', emoji: '😂' },
  b: { id: 'boo', label: 'Boo', emoji: '👎' },
  h: { id: 'heart', label: 'Heart', emoji: '❤️' },
  c: { id: 'clap', label: 'Clap', emoji: '👏' },
};

// A reaction() call in any position, including chained — the same shape as
// text-cycles-core.js's WORD_CALL_RE.
export const REACTION_CALL_RE = /(?:^|[^\w$])reaction\s*\(/;

const BY_ID = Object.fromEntries(Object.values(REACTIONS).map((r) => [r.id, r]));

// The abbreviation, or Jitsi's own reaction id, case-insensitively — either
// is a legal bare mini-notation atom. Anything else is unresolved rather
// than guessed.
export function resolveReaction(token) {
  const key = String(token ?? '').trim().toLowerCase();
  if (!key) return null;
  return REACTIONS[key] || BY_ID[key] || null;
}

export const DEFAULT_UNREACT_MS = 4000;
const MIN_UNREACT_MS = 200;
const MAX_UNREACT_MS = 30000;

// Clamped so a mistyped or patterned-to-extremes unreact() cannot leave a
// reaction stuck on screen indefinitely, or clear faster than Jitsi's own
// reaction animation can be read.
export function resolveUnreactMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_UNREACT_MS;
  return Math.min(MAX_UNREACT_MS, Math.max(MIN_UNREACT_MS, n));
}
