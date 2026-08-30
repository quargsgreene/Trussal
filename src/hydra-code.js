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
// the first blank line that isn't followed by more Hydra. A performer who
// lays out several Hydra layers as their own blank-line-separated paragraphs
// — a common Hydra idiom — keeps every one of them in the preamble; Strudel
// begins at the first paragraph that doesn't render anything.

import { stripBotConfig } from './bot-config.js';

const INIT_HYDRA_RE = /^\s*await\s+initHydra\s*\(/;

// A paragraph after the first still belongs to the Hydra preamble if it
// contains a render call — `.out(...)`, bare or targeting o0-o3 — which is
// Hydra's defining shape and something a Strudel pattern never writes. This
// is what lets splitHydraCode keep walking past a blank line a performer put
// between two Hydra statements instead of handing the second one to Strudel,
// where it fails to parse (or means something else entirely) and takes the
// whole room's program down with it.
const HYDRA_RENDER_RE = /\.out\s*\(/;

// The same marker, asked of a COMBINED program rather than one performer's
// block. strudel.js stacks every playing peer into a single program, so the
// preamble that INIT_HYDRA_RE requires at the start of a block legitimately
// lands at any line of the joined result — and `direct` mode injects one at
// the top. Anchored to a line start so a commented-out `//await initHydra()`
// still reads as "no Hydra", which is what lets a performer take their
// visuals down by commenting them out.
const PROGRAM_INIT_HYDRA_RE = /(^|\n)\s*await\s+initHydra\s*\(/;

// The same rule as a serialisable descriptor, for consumers that cannot import
// a module: the bot's page scripts are function bodies handed to Chromium by
// puppeteer, so they can only receive JSON. Exporting the pattern instead of
// letting them re-type the literal is what keeps this the single rule.
export const INIT_HYDRA_PATTERN = { source: INIT_HYDRA_RE.source, flags: INIT_HYDRA_RE.flags };

// Editor text minus the noise that is never part of either language: trailing
// whitespace/semicolons, `*name: code` lines (studio button widgets, not
// patterns), and `botConfig(...)` declarations (bot-cluster settings, not
// patterns). buildPeerBlock strips exactly these before testing for a
// preamble, so the mosaic has to strip them too or a leading widget line would
// hide an otherwise-valid preamble.
//
// botConfig has to go before Strudel's transpiler sees the block, not just to
// keep it out of the program: the transpiler mini-parses every double-quoted
// string, so a quoted value left in place would throw and stop the whole
// room's program.
export function normalizePeerCode(code) {
  return stripBotConfig(code || '')
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
  const blanks = [...normalized.matchAll(/\n\n+/g)];
  if (!blanks.length) return { preamble: normalized, strudel: '' };

  // The first blank line always ends at least the opening paragraph (the one
  // `await initHydra(...)` itself opens). Every blank line after that is only
  // included if the paragraph it closes off still renders — walk forward
  // through blanks, extending the cut past any that do, and stop at the first
  // that doesn't. That paragraph, and everything after it, is Strudel.
  let cut = blanks[0];
  for (let i = 1; i < blanks.length; i++) {
    const paragraph = normalized.slice(cut.index + cut[0].length, blanks[i].index);
    if (!HYDRA_RENDER_RE.test(paragraph)) {
      return {
        preamble: normalized.slice(0, cut.index).trim(),
        strudel: normalized.slice(cut.index).trim()
      };
    }
    cut = blanks[i];
  }
  // Every blank walked past closed off a paragraph that rendered — the loop
  // above only ever tests a paragraph BOUNDED by a following blank, so the
  // trailing paragraph (after the last blank, nothing to bound it) still
  // needs the same check. Left unchecked, a single blank line right after
  // `await initHydra()` followed by more Hydra (e.g. `s0.initCam()` then
  // `src(s0).out()`, with nothing else) was silently handed to Strudel,
  // which fails a `usesExternalSource` peer both the aggregator's mosaic
  // (never blits their cell) and, for a bot, the join-time channelLastN
  // override in bots/src/bot/index.js needs (bot never receives ANY inbound
  // video at all, no matter how many times a runtime setReceiverConstraints
  // asks for it — see that file's own comment on why it must be set at join).
  const trailing = normalized.slice(cut.index + cut[0].length);
  if (HYDRA_RENDER_RE.test(trailing)) {
    return { preamble: normalized.trim(), strudel: '' };
  }
  return {
    preamble: normalized.slice(0, cut.index).trim(),
    strudel: normalized.slice(cut.index).trim()
  };
}

// Does a combined program declare Hydra at all? The browser's teardown test:
// initHydra() only ever REUSES an existing `#hydra-canvas`, so nothing in an
// evaluate cycle takes that canvas away on its own, and a program that no
// longer declares Hydra has to be recognised as such before its visuals can
// be removed.
export function programDeclaresHydra(code) {
  return PROGRAM_INIT_HYDRA_RE.test(code || '');
}

// Is this peer running Hydra? The mosaic's membership test.
export function hasHydraCode(code) {
  return splitHydraCode(code) != null;
}

// Does the preamble reference an External Source slot (s0-s3)? In Hydra those
// exist ONLY to hold external media — initCam, initScreen, initImage,
// initVideo, or a raw init({src}) — never a procedural generator, which
// Hydra always exposes as a bare function (osc, noise, shape…) rather than
// through a source slot. So naming sN at all — however it got populated: an
// explicit call in this preamble, or hydra-video.js's own direct-mode camera
// feed into s0 with no call visible here — means this cell shows something
// the aggregator has no way to reproduce itself: no camera, no screen to
// share, and no access to a URL that lives only in the performer's own
// browser. The mosaic blits their published track instead of re-executing.
// Matches s0-s3 as a whole word so `s01` or `foos0` don't trip it.
export function usesExternalSource(code) {
  const split = splitHydraCode(code);
  if (!split) return false;
  return /(^|[^\w$])s[0-3]($|[^\w$])/.test(split.preamble);
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
// Does this preamble draw one of the performer's UPLOADED IMAGES? Those live
// in that browser's IndexedDB and are addressed by an object URL minted there,
// so the aggregator cannot resolve one: re-executing such a preamble in the
// mosaic page would draw a broken image where the performer sees their
// picture. Same situation as the camera, and the same answer — blit their
// published track instead.
export function usesLocalImage(code) {
  const split = splitHydraCode(code);
  if (!split) return false;
  return /(^|[^\w$])img\s*\(/.test(split.preamble);
}

export function mosaicCellSource(code) {
  if (!hasHydraCode(code)) return null;
  return (usesExternalSource(code) || usesLocalImage(code)) ? 'blit' : 'reexecute';
}
