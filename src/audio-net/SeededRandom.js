// The room's shared source of randomness.
//
// Net Cycles has two places where a program says "sometimes": `?` (and `|`) on
// a `$ participants` turn, and `?` on an element of a patterned `#` effect
// argument. Neither may use Math.random(): the whole design rests on every
// client deriving the same schedule and the same effect parameters from the
// same program, epoch and metrics, and one un-agreed coin flip breaks that as
// thoroughly as a wrong formula would — silently, and only for some listeners.
//
// So both callers draw from here instead, seeding by what NAMES the occurrence
// rather than by the moment it is being read at. An occurrence stretched over
// several cycles by `@` or `/` therefore decides once, as a whole, instead of
// re-flipping at each boundary — and decides identically in every browser and
// in the aggregator.
//
// Pure module: no DOM, no WebAudio, no clock, so it runs in the bundle, in
// bots, and under node:test.

// mulberry32 — tiny, good-enough, identical everywhere. Integer ops only
// (Math.imul, >>>), so there is no float rounding to disagree about.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-flavoured mix of the integer parts that name one occurrence. Every part
// is coerced with `| 0`, so callers may hand it any integer — including a
// negative cycle number, which is a real position before the grid's epoch.
export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    h = (h ^ (part | 0)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    h = Math.imul(h, 0x2545f491) >>> 0;
  }
  return h >>> 0;
}

// One draw in [0, 1) for the occurrence named by `parts`. Pure: the same parts
// give the same number for ever, on every client.
export function occurrenceDraw(...parts) {
  return seededRandom(hashSeed(...parts))();
}
