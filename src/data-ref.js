// data-ref.js — resolving `"Weather:3"` to a pattern of values.
//
// The one place that knows what a data-pack reference MEANS, shared by all four
// contexts that can hold one: Strudel and Text Cycles (via the string-literal
// rewrite in strudel.js), Hydra (via H() in hydra-params.js), and JPattern
// (via the metaprogram parser). They must not disagree, for the same reason
// hydra-code.js exists.
//
// A reference reads exactly like an audio bank's — bank name, colon, index —
// with two differences a performer needs to know:
//
//   * The index is 1-BASED and selects a column (CSV/TSV) or a top-level
//     property (JSON): "Weather:3" is the third column. Audio banks stay
//     0-based, because those are Strudel's own semantics and are not ours to
//     change; a data pack is a Trussal construct, so it follows the spec.
//   * A data sample is never a sound. Nothing here reaches superdough.
//
// Determinism is the constraint that shapes this module. The combined program
// is evaluated in every peer's browser and by the aggregator, so a reference
// must resolve to the same values everywhere:
//
//   * Packs are keyed by the peerId that owns them and looked up in sorted
//     peerId order, so two peers who both uploaded a "Weather.csv" resolve to
//     the SAME one on every client rather than each preferring their own.
//   * shuffle() draws from the seeded PRNG the rest of the room already shares.
//     Math.random() here would give every listener a different distortion.

import { seededRandom, hashSeed } from './audio-net/SeededRandom.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// peerId → { name: pack } for every pack that peer has loaded. Our own packs
// live here under our own peerId, under the same lookup rule as everyone
// else's — a local-wins rule would resolve differently on each client.
const packsByPeer = new Map();

export function setPeerPacks(peerId, packs) {
  if (!peerId) return;
  const byName = new Map();
  for (const pack of packs ?? []) {
    if (pack?.name && Array.isArray(pack.samples)) byName.set(pack.name, pack);
  }
  if (byName.size) packsByPeer.set(peerId, byName);
  else packsByPeer.delete(peerId);
}

export function removePeerPacks(peerId) {
  packsByPeer.delete(peerId);
}

export function clearPacks() {
  packsByPeer.clear();
}

// Sorted-peerId scan: the tie-break has to be a property of the room, not of
// whose browser is asking.
export function getPack(name) {
  if (!name) return null;
  for (const peerId of [...packsByPeer.keys()].sort()) {
    const pack = packsByPeer.get(peerId).get(name);
    if (pack) return pack;
  }
  return null;
}

export function hasPack(name) {
  return getPack(name) !== null;
}

// Every pack name currently visible in the room, for the reference rewrite and
// for autocomplete.
export function knownPackNames() {
  const names = new Set();
  for (const byName of packsByPeer.values()) for (const name of byName.keys()) names.add(name);
  return names;
}

// ---------------------------------------------------------------------------
// Reference syntax
// ---------------------------------------------------------------------------

// A whole-string `Name:N`. Anchored and total: a string that is anything more
// than one reference (a mini-notation sequence, a chord, a sound with effects)
// is left for mini to parse, so this can never capture a sound reference by
// accident.
const REF_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\d+)\s*$/;

export function parseDataRef(text) {
  // Strings only. H() is handed numbers and whole Patterns too, and coercing a
  // Pattern to a string on every frame to learn it is not a reference would be
  // both wasteful and a needless dependence on Strudel's toString.
  if (typeof text !== 'string') return null;
  const m = REF_RE.exec(text);
  if (!m) return null;
  const index = Number(m[2]);
  if (!Number.isInteger(index) || index < 1) return null;
  return { name: m[1], index };
}

// Is this string literal a reference to a pack that actually exists? The
// existence check is what lets `s("piano:3")` keep meaning the piano sample
// even after someone uploads a piano.csv — that upload is renamed piano_2 by
// uniquePackName, so the sound name never resolves here.
export function isDataRef(text) {
  const ref = parseDataRef(text);
  return ref ? hasPack(ref.name) : false;
}

// ---------------------------------------------------------------------------
// The four value operations
// ---------------------------------------------------------------------------
//
// clip / chop / begin / shuffle further truncate and rearrange a pack, per the
// feature spec. They act on the VALUE ARRAY, and only when chained directly
// onto a reference:
//
//     s("piano").distort("Weather:3".begin(0.5))   // latter half of column 3
//     s("piano").begin(0.5)                        // still the sample's start
//
// Keeping them on the reference is what lets .begin() go on meaning
// sample-start everywhere else, and removes the ambiguity of a chain that
// holds two references.
//
// Amounts below 1 are read as a fraction of the sample's length and amounts of
// 1 or more as a count of values, so .begin(0.5) is "half of them" and
// .begin(4) is "four of them".

function resolveAmount(amount, length) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1) return Math.round(n * length);
  return Math.min(Math.round(n), length);
}

// Drop from the front. begin(0.5) keeps the latter half.
export function dataBegin(values, amount) {
  const drop = resolveAmount(amount, values.length);
  if (drop === null) return values;
  return values.slice(Math.min(drop, values.length));
}

// Keep the front. clip(0.5) keeps the first half; combine with begin() for a
// middle slice.
export function dataClip(values, amount) {
  const keep = resolveAmount(amount, values.length);
  if (keep === null) return values;
  return values.slice(0, Math.max(0, keep));
}

// Resample to n evenly spaced values — the data reading of "cut it into n
// pieces". Fewer values thins the pattern; more repeats values to thicken it.
export function dataChop(values, n) {
  const count = Math.round(Number(n));
  if (!Number.isFinite(count) || count < 1 || !values.length) return values;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(values[Math.min(values.length - 1, Math.floor((i * values.length) / count))]);
  }
  return out;
}

// Deterministic Fisher-Yates. The seed folds in the pack name and index, so two
// different samples shuffled in the same program do not march in lockstep, and
// every browser produces the identical order.
export function dataShuffle(values, seedParts = []) {
  const parts = seedParts.flatMap((part) => (
    typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : [Number(part) | 0]
  ));
  const rand = seededRandom(hashSeed(...parts));
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern construction
// ---------------------------------------------------------------------------

/**
 * Build the pattern a reference evaluates to: the sample's values laid out as
 * one sequence per cycle (so `.slow(n)` spreads them and `.fast(n)` packs
 * them), carrying data-aware clip/chop/begin/shuffle as own properties that
 * shadow Strudel's controls of the same name.
 *
 * `strudel` is passed in rather than imported so this module stays free of the
 * lazily-loaded engine and can be tested under node.
 */
function buildPattern(values, strudel, seedParts) {
  const pattern = values.length
    ? strudel.fastcat(...values)
    : strudel.silence;

  const rebuild = (next) => buildPattern(next, strudel, seedParts);
  const ops = {
    begin: (amount) => rebuild(dataBegin(values, amount)),
    clip: (amount) => rebuild(dataClip(values, amount)),
    chop: (n) => rebuild(dataChop(values, n)),
    shuffle: (seed = 0) => rebuild(dataShuffle(values, [...seedParts, seed])),
  };
  for (const [name, fn] of Object.entries(ops)) {
    Object.defineProperty(pattern, name, {
      value: fn, writable: true, configurable: true, enumerable: false,
    });
  }
  // The values themselves, for JPattern and the mosaic — they sample against
  // the room's cycle grid rather than running a Strudel scheduler.
  Object.defineProperty(pattern, 'dataValues', {
    value: values, writable: false, configurable: true, enumerable: false,
  });
  return pattern;
}

/**
 * Resolve one reference. Returns null when no such pack is loaded, so callers
 * can fall back to mini-notation and leave sound references untouched.
 */
export function resolveDataRef(text, strudel) {
  const ref = parseDataRef(text);
  if (!ref) return null;
  const pack = getPack(ref.name);
  if (!pack) return null;

  const sample = pack.samples[ref.index - 1];
  if (!sample) {
    // Loud, but not fatal. Throwing here would take down the whole room's
    // combined program over one performer's off-by-one — the same failure the
    // rest of the engine works hard to avoid.
    console.error(`[data] ${ref.name}:${ref.index} is out of range —`
      + ` ${pack.name} has ${pack.samples.length} sample(s); using silence`);
    return strudel.silence;
  }
  return buildPattern(sample.values, strudel, [ref.name, ref.index]);
}

// ---------------------------------------------------------------------------
// The source rewrite
// ---------------------------------------------------------------------------

// A double-quoted whole-string reference, optionally preceded by the sound
// control that would make it a sample name. Double-quoted only: Strudel's
// transpiler mini-parses `"…"` and leaves `'…'` alone, which is the same
// convention rewriteLiveCalls relies on.
const REWRITE_RE = /(\b(?:s|sound)\s*\(\s*)?"([A-Za-z_][A-Za-z0-9_]*\s*:\s*\d+)"/g;

/**
 * Rewrite `"Weather:3"` to a `_data(...)` call before Strudel's transpiler
 * turns it into mini-notation — mini reads `Weather:3` as sound:index and would
 * hand `.distort()` an {s, n} object instead of a number.
 *
 * Deliberately does NOT consult the registry. Every browser must build the
 * same program text for the same peer, and registry contents differ mid-join;
 * making the rewrite unconditional keeps it deterministic, and _data falls back
 * to mini at run time when the name turns out not to be a pack.
 *
 * The one exception is a literal sitting directly in `s(...)` / `sound(...)`,
 * which is a sample-name position where a pack could never be meant — so
 * `s("piano:3")` stays the piano sample even if someone loads a piano.csv.
 */
export function rewriteDataRefs(code) {
  return String(code ?? '').replace(REWRITE_RE, (match, soundCall, ref) => {
    if (soundCall) return match;
    const { name, index } = parseDataRef(ref);
    return `_data('${name}',${index},'${name}:${index}')`;
  });
}

/**
 * The `_data(...)` the string-literal rewrite in strudel.js emits, installed
 * into Strudel's eval scope. Falls back to mini-notation with the original
 * literal when the name is not a pack, so a rewritten `s("piano:3")` behaves
 * exactly as it did before this feature existed.
 */
export function makeDataFn(strudel) {
  return function _data(name, index, literal) {
    const text = literal ?? `${name}:${index}`;
    return resolveDataRef(text, strudel) ?? strudel.mini(text);
  };
}

/**
 * Sample a reference's values at a cycle position, for the contexts that have
 * no Strudel scheduler: the aggregator's mosaic and JPattern. One cycle
 * walks the whole sample, matching what buildPattern lays out.
 */
export function sampleDataRefAt(text, cyclePos) {
  const ref = parseDataRef(text);
  if (!ref) return null;
  const pack = getPack(ref.name);
  const sample = pack?.samples?.[ref.index - 1];
  if (!sample?.values?.length) return null;
  const phase = ((Number(cyclePos) || 0) % 1 + 1) % 1;
  return sample.values[Math.min(sample.values.length - 1, Math.floor(phase * sample.values.length))];
}
