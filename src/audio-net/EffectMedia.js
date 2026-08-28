// Which MEDIA a network-modulated `#` effect acts on.
//
// Every effect has a counterpart in each of the room's four output media, so
// `# room wcl 2` reverberates the mix, blurs the video, blurs the styled text
// and stretches its letter-spacing all at once. The optional trailing argument
// narrows that:
//
//   # room wcl 2 ["audio" "video"]           audio and video only
//   # room wcl 2 <["audio" "video"] ["video" "css"]@2>*3   ...and it patterns
//
// Unwritten means ALL FOUR — an effect is whole-room by default, and the
// argument is how a performer takes media away rather than how they opt in.
//
// The set is space-separated, never comma-separated: the metaprogram's
// sequences have always separated elements by whitespace, and one collection
// spelled differently from every other would be a second convention to learn.
//
// One reader, four consumers. The audio gate runs in the aggregator's master
// bus, the video gate in its mosaic compositor, and css/text in each browser's
// Text Cycles renderer — three processes that must agree about what
// `["audio" "video"]` selected on this cycle. A second copy of these rules
// could only drift, which is the same reason ECHO_SLOTS lives in Echo.js
// rather than in the grammar.
//
// Pure module: no DOM, no WebAudio, so it runs in the bundle, in bots, and
// under node:test.

import { evaluateValuePattern, isValuePattern } from './ValuePattern.js';

// Canonical order, and the whitelist the grammar validates against. The order
// is what normalizeMediaSet sorts into, so two spellings of the same set
// (`["video" "audio"]` and `["audio" "video"]`) produce equal arrays and the
// aggregator's JSON push-dedup sees no change between them.
export const MEDIA = Object.freeze(['audio', 'css', 'text', 'video']);

export function isMedium(name) {
  return MEDIA.includes(name);
}

// Dedupe into canonical order. Unknown names are dropped rather than kept:
// the parser has already rejected them with a line/col error, and carrying one
// into the resolved set would let it reach a consumer's `includes` check.
export function normalizeMediaSet(names) {
  return Object.freeze(MEDIA.filter(m => (names || []).includes(m)));
}

// The set in force at `cyclePos`.
//
// Three shapes reach this: nothing written (the whole-room default), one set
// (a frozen array of names), or a `<…>` pattern whose leaves are sets. A rest
// — written `~`, or drawn by a `?` — evaluates to null, which every other
// patterned argument reads as "no value here, use the effect's default"; the
// default here is all four media, so a rest widens rather than silences.
//
// An empty set cannot be written (the grammar rejects `[]`), but a pattern
// that somehow yields one is treated as the default for the same reason: an
// effect that acts on nothing at all is a directive with no meaning, and a
// performer who wants that deletes the line.
export function resolveMedia(mediaArg, cyclePos = 0) {
  if (mediaArg == null) return MEDIA;
  const value = isValuePattern(mediaArg) ? evaluateValuePattern(mediaArg, cyclePos) : mediaArg;
  if (value == null) return MEDIA;
  // A single bare name inside a pattern (`<"audio" "video">`) is a one-element
  // set — the brackets are what a set of several needs, not what makes it one.
  const names = typeof value === 'string' ? [value] : value;
  const set = normalizeMediaSet(names);
  return set.length ? set : MEDIA;
}

// Whether this effect acts on `medium` at this point on the cycle grid.
// Takes the whole chain entry, so a caller gates on the directive it is
// already holding rather than reaching for the argument itself.
export function entryAffects(entry, medium, cyclePos = 0) {
  return resolveMedia(entry && entry.media, cyclePos).includes(medium);
}
