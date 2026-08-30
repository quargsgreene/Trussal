// Room index + bot-cluster suffix rules for JPattern.
//
// Humans get a sequential integer index in join order, immutable for the
// meeting and never reused after a leave. Bots get their owner's index plus
// a letter suffix: the 1st bot in a cluster is `a`, the 26th `z`; only once
// all 26 letters are exhausted for a position does the sequence grow, by
// appending one more letter starting again at `a` — so the 27th is `za`,
// the 28th `zb`, the 52nd `zz`, the 53rd `zza` (never `ab`, never `0zz`).
//
// CommonJS on purpose: the sidecar (CJS, node:20) is the assignment
// authority, the browser bundle imports it through esbuild's CJS interop,
// and the fleet service consumes it via Node's require(cjs)-from-ESM
// interop.

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// Reserved index for the room's audio aggregator. The aggregator joins the
// room like any bot but is not a performer: it must not occupy a slot in the
// human integer sequence (users read `$ participants` integer tokens as
// "humans in join order" — an aggregator holding one makes that token a
// permanently-silent placeholder), and it must never be schedulable. `pi` is
// structurally outside both spaces: it fails the participant-token grammar
// (`\d+[a-z]*`), so the metaprogram can never list it, and it cannot collide
// with a cluster token, which always leads with the owner's integer. Being
// non-numeric it also sorts index-less (Infinity) in the aggregator election,
// which still wins when it is the room's only aggregator — the sidecar's
// claim gate guarantees there is at most one.
const AGGREGATOR_ROOM_INDEX = 'pi';

// 0-based ordinal within a cluster → suffix string.
function botSuffix(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError('botSuffix() requires a non-negative integer');
  }
  const zs = Math.floor(ordinal / 26);
  const last = ordinal % 26;
  return 'z'.repeat(zs) + LETTERS[last];
}

// suffix string → 0-based ordinal; null when the suffix is invalid.
function suffixToOrdinal(suffix) {
  if (!isValidBotSuffix(suffix)) return null;
  const zs = suffix.length - 1;
  return zs * 26 + LETTERS.indexOf(suffix[suffix.length - 1]);
}

// Valid cluster suffixes are exactly: zero or more `z`s then one letter.
// Rejects the spec's bad examples: `bcd`-style runs, and `zz` is only valid
// as the 52nd suffix (z-prefix + final z), never as the 28th.
function isValidBotSuffix(suffix) {
  return typeof suffix === 'string' && /^z*[a-z]$/.test(suffix);
}

// A participant token is a human index (`3`) or a bot index (`3zb`).
function isValidParticipantToken(token) {
  if (typeof token !== 'string') return false;
  const m = token.match(/^(\d+)([a-z]*)$/);
  if (!m) return false;
  if (m[2] === '') return true;
  return isValidBotSuffix(m[2]);
}

// `1zb` → { ownerIndex: 1, suffix: 'zb', ordinal: 27 }; `4` → { ownerIndex: 4,
// suffix: null, ordinal: null }; invalid tokens → null.
function parseParticipantToken(token) {
  if (!isValidParticipantToken(token)) return null;
  const m = token.match(/^(\d+)([a-z]*)$/);
  const ownerIndex = parseInt(m[1], 10);
  if (m[2] === '') return { ownerIndex, suffix: null, ordinal: null };
  return { ownerIndex, suffix: m[2], ordinal: suffixToOrdinal(m[2]) };
}

module.exports = {
  AGGREGATOR_ROOM_INDEX,
  botSuffix,
  suffixToOrdinal,
  isValidBotSuffix,
  isValidParticipantToken,
  parseParticipantToken
};
