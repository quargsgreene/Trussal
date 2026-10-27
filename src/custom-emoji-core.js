// custom-emoji-core.js
// Uploaded emoji, as data: what an emoji's name may be, how it is written in
// text (a :shortcode:), and how a painted word splits into text and emoji. No
// DOM, no IndexedDB, no sidecar — unit tested in test/custom-emoji-core.test.js.
// Readers:
//   - custom-emoji.js        — upload, storage, sharing with the room, <img>s
//   - on-screen-keyboard.js  — the emoji keyboard's "Mine" page
//   - speech.js              — a :shortcode: is read as its name, not spelled
//
// An emoji travels as base64 on its owner's sidecar record (the same way a
// data pack does), so it is capped small: MAX_EMOJI_BYTES each, MAX_EMOJI per
// person. latency-instrument/server.js mirrors both caps.

export const MAX_EMOJI = 64;
export const MAX_EMOJI_BYTES = 64 * 1024;
// The size a large upload is scaled down to (longest side, in pixels).
export const EMOJI_SIZE = 96;
export const EMOJI_MIMES = Object.freeze(['image/png', 'image/gif', 'image/webp', 'image/jpeg']);

export const EMOJI_NAME_RE = /^[a-z0-9_]{1,32}$/;
// A shortcode in running text: the name between colons, as in Slack/Discord.
export const SHORTCODE_RE = /:([a-z0-9_]{1,32}):/g;

export function shortcode(name) {
  return `:${name}:`;
}

// A filename → a free emoji name: lower-case, extension dropped, anything
// outside [a-z0-9_] folded to "_", and a numeric suffix if `taken` has it.
export function emojiNameFromFilename(filename, taken = new Set()) {
  const base = String(filename ?? '')
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28) || 'emoji';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

export function isValidEmoji(e) {
  return !!e
    && typeof e.name === 'string' && EMOJI_NAME_RE.test(e.name)
    && typeof e.mime === 'string' && EMOJI_MIMES.includes(e.mime)
    && typeof e.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(e.data)
    && base64ByteLength(e.data) <= MAX_EMOJI_BYTES;
}

// A list as it may arrive from a peer → the valid entries, first of each name
// kept, at most MAX_EMOJI.
export function sanitizeEmojiList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (out.length >= MAX_EMOJI) break;
    if (!isValidEmoji(e) || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, mime: e.mime, data: e.data });
  }
  return out;
}

export function base64ByteLength(b64) {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

// Text → [{ text } | { emoji: name }], splitting out every :shortcode: that
// `known(name)` accepts. Anything else — an unknown name, "bd:3" — stays text.
export function splitShortcodes(text, known) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(SHORTCODE_RE)) {
    if (!known(m[1])) continue;
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ emoji: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

// What a word sounds like with its shortcodes read as names ("party_cat" →
// "party cat"), for the browser's voice.
export function speakableShortcodes(text) {
  return String(text ?? '').replace(SHORTCODE_RE, (_, name) => ` ${name.replace(/_+/g, ' ')} `)
    .replace(/\s+/g, ' ').trim();
}

// And without them, for the IPA voice, which has no way to say a picture.
export function stripShortcodes(text) {
  return String(text ?? '').replace(SHORTCODE_RE, ' ').replace(/\s+/g, ' ').trim();
}
