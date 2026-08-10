/**
 * Turning one performer's code into one bot's code, per their botConfig.
 *
 * Same strategy as variation.js and for the same reason: never rewrite the
 * master's structure, wrap it. The one exception is the numeric transforms
 * (`random: "params"`, `paramFactor`), which by definition have to reach
 * inside — they rewrite numeric LITERALS, both outside strings and, inside a
 * quoted mini-notation string, standalone value tokens: `n("0 2 4")`'s scale
 * degrees and `.cutoff("800 1200")`'s pattern values move exactly like
 * `.cutoff(800)` does, staying inside their original quotes. What survives
 * untouched inside a string is pattern STRUCTURE: `s("bd*2 sd:3")` keeps its
 * *2 (repeat count) and :3 (sample-bank index), and `note("c3 e3")` keeps its
 * note names — none of those are parameter values.
 *
 * Determinism: every randomised transform is driven by a seed derived from the
 * session seed and the bot's id, so the fleet can rebuild an identical script
 * for a replacement bot mid-session — the same guarantee generator.js makes.
 *
 * These functions compose with variationFor rather than replacing it: this
 * module decides WHAT the bot plays, variation.js decides how it sits in the
 * mix (band, stereo position, entry offset, gain staging, link fx).
 */

import { parseHarmony } from '../../../src/bot-config.js';

// Mirrors SCALE_INTERVALS in src/mcp-agent/tools/theory_utils.js. Duplicated
// rather than imported because mcp-agent is a separate package with its own
// dependencies and is not in the conductor image; the table is a fact about
// music, not a shared decision, so a second copy cannot drift into a bug.
const SCALE_INTERVALS = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  wholetone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
});

const DEFAULT_SCALE = { name: 'C:major', mode: 'major' };

// Colour-scheme offsets around the hue circle, in turns. Index 0 is always the
// human's own hue, so bot 0 of a cluster sits where its author does and the
// scheme opens up from there.
const COLOR_SCHEMES = {
  complementary: [0, 0.5],
  monochromatic: [0],
  analogous: [0, 1 / 12, -1 / 12, 2 / 12, -2 / 12],
  triadic: [0, 1 / 3, 2 / 3],
  tetradic: [0, 1 / 4, 1 / 2, 3 / 4],
  'split-complementary': [0, 5 / 12, 7 / 12],
  square: [0, 1 / 4, 1 / 2, 3 / 4],
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

// --- Numeric literal rewriting ----------------------------------------------

// A digit run right after a mini-notation operator is a count, not a value:
// bd*2 (repeat), hh!4 (replicate), bd@3 (weight), x%8 (polymeter steps),
// bd/2 (slow), bd?0.3 (degrade probability), sd:3 (sample-bank index), and
// c#4 (sharp accidental — the only one of these that can also appear
// outside a string, e.g. note("c#4") vs plain note names never do). None of
// the others are reachable outside a string, so this set only ever matters
// while `quote` is set.
const MINI_OPERATOR_PREFIX = /[*!@%/?:#]/;

/**
 * Rewrite every numeric literal that is real code OR a bare value inside a
 * quoted mini-notation string — `n("0 2 4")`'s scale degrees are as much a
 * "numeric parameter" as `.cutoff(800)`'s argument, so both are fair game.
 * `fn(value, ordinal)` returns the replacement number.
 *
 * Skipped deliberately:
 *  - a digit run attached to an identifier (o0, s0, hpf2) — part of a name —
 *    or, inside a string, a note name or sample word (c3, eb4, bd2)
 *  - inside a string: a digit run right after a mini-notation operator
 *    (*, !, @, %, /, ?, :, #) — pattern structure, not a value
 */
export function mapNumericLiterals(code, fn) {
  const src = String(code ?? '');
  let out = '';
  let i = 0;
  let ordinal = 0;
  let quote = null;

  while (i < src.length) {
    const ch = src[i];

    if (quote) {
      if (ch === '\\') { out += ch + (src[i + 1] ?? ''); i += 2; continue; }
      if (ch === quote) { out += ch; quote = null; i++; continue; }
    } else {
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }

      // Line and block comments pass through verbatim.
      if (ch === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? src.length : end;
        out += src.slice(i, stop); i = stop; continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        out += src.slice(i, stop); i = stop; continue;
      }
    }

    const prev = src[i - 1] ?? '';
    const isDigit = ch >= '0' && ch <= '9';
    // A lone '.' right after another '.' is the second half of mini
    // notation's range operator ("0..7"), never a decimal point.
    const startsDecimal = ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9' && prev !== '.';
    if (!isDigit && !startsDecimal) { out += ch; i++; continue; }

    let j = i;
    while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
    if (src[j] === '.' && src[j + 1] >= '0' && src[j + 1] <= '9') {
      j++;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
    }
    // The whole run — not just its first character — is structure rather
    // than a value when it opens right on an identifier (o0, s0, hpf2) or,
    // inside a string, a mini-notation operator (bd*2, cp?0.3); or when it
    // closes into one: a trailing name char means this was a name after all
    // (2x, 3n), or, inside a string, a unit suffix (10px) or a name run on
    // with no gap (3c).
    if (/[\w$]/.test(prev) || (quote && MINI_OPERATOR_PREFIX.test(prev)) || /[\w$]/.test(src[j] ?? '')) {
      out += src.slice(i, j); i = j; continue;
    }

    const literal = src.slice(i, j);
    const value = Number(literal);
    const negated = /[-]\s*$/.test(out) && !/[\w$)\]]\s*[-]\s*$/.test(out);
    const signed = negated ? -value : value;
    const replaced = fn(signed, ordinal++);
    const next = Number.isFinite(replaced) ? replaced : signed;

    if (negated) {
      // Fold the sign back in so a transform that flips it stays syntactic.
      out = out.replace(/[-]\s*$/, '');
      out += String(round3(next));
    } else {
      out += String(round3(next));
    }
    i = j;
  }

  return out;
}

/**
 * Keep a transformed parameter in the same shape as the one it replaces:
 * integers stay integers, sign is preserved, and a non-zero value never
 * collapses to zero (`.slow(0)` and `.fast(0)` both kill a pattern).
 */
function keepShape(original, next) {
  if (!Number.isFinite(next)) return original;
  let out = Number.isInteger(original) ? Math.round(next) : round3(next);
  if (original !== 0) {
    if (out === 0) out = Number.isInteger(original) ? (original > 0 ? 1 : -1) : (original > 0 ? 0.001 : -0.001);
    if (Math.sign(out) !== Math.sign(original)) out = -out;
  }
  return out;
}

/** `paramFactor`: scale every numeric parameter by a constant. */
export function applyParamFactor(code, factor) {
  if (!Number.isFinite(factor)) return String(code ?? '');
  return mapNumericLiterals(code, (value) => keepShape(value, value * factor));
}

/**
 * `random: "params"`: jitter every numeric parameter around its original.
 * Bounded to ±50% rather than free — "randomizes each parameter passed to each
 * bot's functions from the copy of the human spawner's code" means a variation
 * on the human's patch, not an unrelated one, so the patch must stay recognisable.
 */
export function randomizeParams(code, seed) {
  const rand = mulberry32(seed);
  return mapNumericLiterals(code, (value) => {
    if (value === 0) return 0;
    return keepShape(value, value * (0.5 + rand()));
  });
}

// --- Harmony ----------------------------------------------------------------

/**
 * The scale a block is playing in. Reads the first `.scale("...")`; falls back
 * to C major, which is the documented default when the code declares none.
 */
export function detectScale(code) {
  const match = /\.scale\s*\(\s*["'`]([^"'`]+)["'`]/.exec(String(code ?? ''));
  if (!match) return { ...DEFAULT_SCALE, declared: false };
  const raw = match[1].trim();
  const mode = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : raw;
  const known = Object.prototype.hasOwnProperty.call(SCALE_INTERVALS, mode);
  return { name: raw, mode: known ? mode : DEFAULT_SCALE.mode, declared: true };
}

/**
 * Is this block degree-based — `n(...)` feeding a `.scale(...)`? Only then can
 * a transposition be truly diatonic, because adding to `n` moves along the
 * scale by definition. Anything else gets the semitone approximation below.
 */
export function isDegreeBased(code) {
  const src = String(code ?? '');
  return /(^|[^\w$.])n\s*\(/.test(src) && /\.scale\s*\(/.test(src);
}

/** Semitones spanned by `degrees` steps of `mode`, across octaves. */
export function degreesToSemitones(degrees, mode) {
  const intervals = SCALE_INTERVALS[mode] || SCALE_INTERVALS.major;
  const len = intervals.length;
  const octaves = Math.floor(degrees / len);
  const within = ((degrees % len) + len) % len;
  return octaves * 12 + intervals[within];
}

/**
 * The chained suffix that moves a bot's pitch, or '' when harmony is unset.
 *
 * `index` is the bot's position in its cluster, so a cluster of N spreads into
 * an N-note voicing rather than every bot landing on the same transposition.
 *
 * Two shapes, because one operator cannot be right for both:
 *  - degree-based code gets `.add(n(k))`, which IS diatonic — Strudel resolves
 *    the degree through the same `.scale()` the author wrote.
 *  - everything else gets `.add(note(k))` in semitones. For "diatonic" those
 *    semitones are measured from the tonic, so a cluster still spells a chord
 *    in the right scale; individual notes off the tonic move by a fixed
 *    interval rather than a scale-following one. That approximation is the
 *    price of not parsing arbitrary pattern code.
 */
export function harmonySuffix(harmony, index, code, seed = 0) {
  const parsed = parseHarmony(harmony);
  if (!parsed || index === 0) return '';
  // An explicit interval is chromatic by definition — "+2" means two semitones
  // whatever scale the block is in — so it needs no scale detection at all.
  if (parsed.type === 'interval') {
    return `.add(note(${parsed.semitones * index}))`;
  }

  if (parsed.type === 'random') {
    const rand = mulberry32(seed + index);
    // A musical spread rather than a uniform one: octave-and-a-bit either way.
    const semitones = Math.round((rand() * 2 - 1) * 14);
    return `.add(note(${semitones}))`;
  }

  // diatonic: bot i moves i scale degrees up, through the author's own scale
  // where the code makes that possible.
  if (isDegreeBased(code)) return `.add(n(${index}))`;
  return `.add(note(${degreesToSemitones(index, detectScale(code).mode)}))`;
}

// --- Colour -----------------------------------------------------------------

/**
 * The hue rotation, in turns, for one cluster member under a colour scheme.
 * `random` is seeded so a replacement bot lands on the colour it had before.
 */
export function hueForScheme(scheme, index, seed = 0) {
  if (!scheme) return null;
  if (scheme === 'random') {
    const rand = mulberry32(seed + index * 7919);
    return round3(rand());
  }
  // One hue for the whole cluster; members are separated by brightness instead
  // (see colorHydraSuffix), since rotating by zero would make them identical.
  if (scheme === 'monochromatic') return 0;

  const offsets = COLOR_SCHEMES[scheme];
  if (!offsets) return null;
  const turn = offsets[index % offsets.length];
  return round3(((turn % 1) + 1) % 1);
}

/**
 * Hydra chain suffix implementing the colour scheme — spliced into the
 * master's own pipeline before its `.out(o0)` (see ../shared/hydra-chain.js),
 * exactly as variation.js does for band and tile roles. Not a standalone
 * `src(o0)...out(o0)` statement: a second `.out(o0)` would rebind the buffer
 * instead of tinting what's already there. Monochromatic varies luminance
 * instead of hue, since rotating by zero would be a no-op and every bot would
 * look identical.
 */
export function colorHydraSuffix(scheme, index, count, seed = 0) {
  const hue = hueForScheme(scheme, index, seed);
  if (hue == null) return '';
  if (scheme === 'monochromatic') {
    const steps = Math.max(1, count);
    const brightness = round3(-0.25 + (index / steps) * 0.5);
    return `.brightness(${brightness})`;
  }
  return `.hue(${hue})`;
}

/**
 * Text Cycles colour for a bot, as a Strudel `.color("#rrggbb")` argument.
 * Text is painted per-page from the pattern, so the scheme has to reach the
 * words as a literal colour rather than a canvas transform.
 */
export function colorForText(scheme, index, seed = 0) {
  const hue = hueForScheme(scheme, index, seed);
  if (hue == null) return null;
  const light = scheme === 'monochromatic' ? 0.4 + ((index % 5) * 0.1) : 0.55;
  return hslToHex(hue, 0.7, Math.min(0.9, light));
}

export function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
    return Math.round(255 * c);
  };
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}
