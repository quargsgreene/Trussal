// hydra-code.js — what counts as Hydra code in a performer's editor, and what
// the aggregator can reproduce of it.
//
// One rule, two consumers. strudel.js splits a peer's block here so the
// preamble runs imperatively and the rest becomes a Strudel voice; the
// aggregator's mosaic asks the same question of the same text to decide
// whether that peer gets a canvas at all. Keeping the rule in one place is
// what stops a cell from appearing for code the browser doesn't treat as
// Hydra (or the reverse) — the two run in different processes and never
// compare notes.
//
// The rule is the convention the room already writes to: a block whose first
// statement is `await initHydra(...)` is Hydra, and the preamble runs until
// the first blank line. Everything after that blank line is Strudel.

const INIT_HYDRA_RE = /^\s*await\s+initHydra\s*\(/;

// Editor text minus the noise that is never part of either language: trailing
// whitespace/semicolons, and `*name: code` lines (studio button widgets, not
// patterns). buildPeerBlock strips exactly these before testing for a
// preamble, so the mosaic has to strip them too or a leading widget line would
// hide an otherwise-valid preamble.
export function normalizePeerCode(code) {
  return (code || '')
    .replace(/[\s;]+$/g, '')
    .replace(/^\*[a-zA-Z_$][a-zA-Z0-9_$]*\s*:.*$/mg, '')
    .trim();
}

// Split normalized code into its Hydra preamble and Strudel remainder, or null
// when the block is not Hydra at all. A Hydra-only block (no blank line) is
// legal and yields an empty `strudel`.
export function splitHydraCode(code) {
  const normalized = normalizePeerCode(code);
  if (!normalized || !INIT_HYDRA_RE.test(normalized)) return null;
  const blank = normalized.match(/\n\n+/);
  if (!blank) return { preamble: normalized, strudel: '' };
  return {
    preamble: normalized.slice(0, blank.index).trim(),
    strudel: normalized.slice(blank.index).trim()
  };
}

// Is this peer running Hydra? The mosaic's membership test.
export function hasHydraCode(code) {
  return splitHydraCode(code) != null;
}

// Does the preamble read the camera texture? Such a cell cannot be reproduced
// from the code alone — the aggregator has no camera for that performer — so
// the mosaic blits their published track instead of re-executing. Matches `s0`
// as a whole word so `s01` or `foos0` don't trip it.
export function usesCameraSource(code) {
  const split = splitHydraCode(code);
  if (!split) return false;
  return /(^|[^\w$])s0($|[^\w$])/.test(split.preamble);
}

// Does the preamble bind Hydra parameters to Strudel patterns via `H(...)`?
// Those animate only while that performer's patterns are running, so the
// aggregator drives them from a muted headless eval of their Strudel rather
// than letting the parameters freeze at their first value.
export function usesPatternParams(code) {
  const split = splitHydraCode(code);
  if (!split) return false;
  return /(^|[^\w$])H\s*\(/.test(split.preamble);
}

// How the aggregator should fill this peer's cell:
//   'blit'      — draw their published video track (camera-fed, can't re-run)
//   'reexecute' — run the preamble locally in its own Hydra instance
//   null        — not Hydra, no cell
export function mosaicCellSource(code) {
  if (!hasHydraCode(code)) return null;
  return usesCameraSource(code) ? 'blit' : 'reexecute';
}
