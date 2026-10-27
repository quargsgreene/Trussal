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
import { stripPermissionsConfig } from './permissions-config.js';
import { stripDirective } from './program-directive.js';
// The personal/bot editor consumes Strudel ("mini") notation; a buffer written
// in the terse "mondo" form ($ head "arg" / # method "arg") is lowered to it
// here, line for line, before the transpiler or any capability sniffing. See
// src/notation.js.
import { detectNotation, mondoToMini, stripInlineComments, balanced } from './notation.js';
// The word()/css() call shapes — imported rather than re-typed so the
// auto-preamble rule below cannot drift from the rewriters that act on them.
// Neither core imports this module, so there is no cycle.
import { WORD_CALL_RE } from './text-cycles-core.js';
import { CSS_CALL_RE } from './css-cycles-core.js';
import { FILE_CALL_RE } from './file-cycles-core.js';
import { POLL_CALL_RE } from './polls-core.js';
import { extractOutRoutes } from './output-route-core.js';
// multiArrange()/multiStack() — the mosaic has to know a performer draws Hydra
// from their Strudel half (see sequencesHydra).
import { MULTI_CALL_RE } from './multimedia-core.js';

const INIT_HYDRA_RE = /^\s*await\s+initHydra\s*\(/;
const INIT_TEXT_CYCLES_RE = /(^|\n)\s*await\s+initTextCycles\s*\(/;
const INIT_CSS_RE = /(^|\n)\s*await\s+initCss\s*\(/;
const INIT_FILE_CYCLES_RE = /(^|\n)\s*await\s+initFileCycles\s*\(/;
const INIT_POLLS_RE = /(^|\n)\s*await\s+initPolls\s*\(/;

// The three capability preambles are now OPTIONAL: a block that only shows the
// shape of a capability — a Hydra render/source call, a word() voice, a css()
// voice — gets the matching `await initX()` line supplied for it. Writing the
// line explicitly still works and is left untouched, so nothing that already
// declared a capability changes. The Hydra half of this has to live here, in
// the module both the browser and the aggregator's mosaic ask, so the two go
// on agreeing about which peers run Hydra.
//
// Hydra shape: a call that exists only in Hydra. `.out(` is the render; the
// listed generators/`src` are Hydra sources a Strudel pattern never writes;
// initCam/initScreen/initImage/initVideo populate an External Source slot.
const HYDRA_SHAPE_RE =
  /\.out\s*\(|(?:^|[^\w$.])(?:osc|shape|gradient|solid|voronoi|src)\s*\(|(?:^|[^\w$])init(?:Cam|Screen|Image|Video)\s*\(/;

// Does this block write Hydra without declaring it?
export function looksLikeHydra(code) {
  const s = String(code ?? '');
  return !PROGRAM_INIT_HYDRA_RE.test(s) && HYDRA_SHAPE_RE.test(s);
}

// Prepend / splice the `await initX()` lines a block's shape implies but its
// text leaves out. Back-compatible: a block that already writes every preamble
// its shape needs is returned unchanged.
export function ensureCapabilityPreambles(code) {
  let s = String(code ?? '');
  if (!s.trim()) return s;
  const needHydra = !PROGRAM_INIT_HYDRA_RE.test(s) && HYDRA_SHAPE_RE.test(s);
  const needText = !INIT_TEXT_CYCLES_RE.test(s) && WORD_CALL_RE.test(s);
  const needCss = !INIT_CSS_RE.test(s) && CSS_CALL_RE.test(s);
  const needFile = !INIT_FILE_CYCLES_RE.test(s) && FILE_CALL_RE.test(s);
  const needPoll = !INIT_POLLS_RE.test(s) && POLL_CALL_RE.test(s);
  if (!needHydra && !needText && !needCss && !needFile && !needPoll) return s;

  const adds = [];
  if (needHydra) adds.push('await initHydra()');
  if (needText) adds.push('await initTextCycles()');
  if (needCss) adds.push('await initCss()');
  if (needFile) adds.push('await initFileCycles()');
  if (needPoll) adds.push('await initPolls()');

  const hasPreamble =
    PROGRAM_INIT_HYDRA_RE.test(s) || INIT_TEXT_CYCLES_RE.test(s) || INIT_CSS_RE.test(s)
    || INIT_FILE_CYCLES_RE.test(s) || INIT_POLLS_RE.test(s);
  if (!hasPreamble) return `${adds.join('\n')}\n\n${s}`;

  // Splice the missing lines into the existing preamble, before its first blank.
  const blank = s.match(/\n\n+/);
  const cut = blank ? blank.index : s.length;
  return `${s.slice(0, cut).replace(/\s*$/, '')}\n${adds.join('\n')}${s.slice(cut)}`;
}

// Inverse of the three `await initX()` lines ensureCapabilityPreambles above
// can add: strip them back off, leaving only the shape that implied them.
// Whoever next evaluates the result re-adds exactly what this removed —
// ensureCapabilityPreambles again for a browser (normalizePeerCode runs it on
// every peer's code before use), pageStrudelBoot's own equivalent injection
// for a bot's own REPL (see bots/src/bot/page-scripts.js) — so stripping here
// never changes what runs, only what gets stored/announced.
//
// Used by the bots' cluster-source.js: normalizePeerCode's own injection
// (needed so splitHydraCode can find where a shape-only Hydra preamble ends)
// would otherwise leak an auto-added preamble into a bot's captured/announced
// script even when the performer it was copied from never wrote one — unlike
// a human, whose own broadcast pattern is always exactly what they typed
// (peer-state.js's sendLocalPattern sends the raw editor text, never routed
// through ensureCapabilityPreambles first).
const STRIP_INIT_HYDRA_RE = /(^|\n)[ \t]*await\s+initHydra\s*\([^)]*\)\s*;?[ \t]*\n*/;
const STRIP_INIT_TEXT_CYCLES_RE = /(^|\n)[ \t]*await\s+initTextCycles\s*\([^)]*\)\s*;?[ \t]*\n*/;
const STRIP_INIT_CSS_RE = /(^|\n)[ \t]*await\s+initCss\s*\([^)]*\)\s*;?[ \t]*\n*/;

export function stripCapabilityPreambles(code) {
  let s = String(code ?? '');
  s = s.replace(STRIP_INIT_HYDRA_RE, '$1');
  s = s.replace(STRIP_INIT_TEXT_CYCLES_RE, '$1');
  s = s.replace(STRIP_INIT_CSS_RE, '$1');
  return s.replace(/^\n+/, '');
}

// A paragraph after the first still belongs to the Hydra preamble if it
// contains a render call — `.out(...)`, bare or targeting o0-o3 — which is
// Hydra's defining shape and something a Strudel pattern never writes. This
// is what lets splitHydraCode keep walking past a blank line a performer put
// between two Hydra statements instead of handing the second one to Strudel,
// where it fails to parse (or means something else entirely) and takes the
// whole room's program down with it.
const HYDRA_RENDER_RE = /\.out\s*\(/;

// A paragraph that only sets up an external source (`s0.initImage(...)`,
// `s1.initVideo(...)`, `s0.init(...)`) renders nothing itself, but it is
// Hydra, not a Strudel pattern: left for the Strudel remainder it is wrapped
// into a `$:` voice and the transpiler rejects the block, taking the whole
// room's program down.
const HYDRA_SOURCE_SETUP_RE = /(^|[^\w$])s[0-3]\s*\.\s*init(?:Cam|Screen|Image|Video)?\s*\(/;

function isHydraParagraph(paragraph) {
  return HYDRA_RENDER_RE.test(paragraph) || HYDRA_SOURCE_SETUP_RE.test(paragraph);
}

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

// The Hydra SHAPE marker as a serialisable descriptor, for the bot's page
// scripts: with the preamble now optional, "does this text bring its own Hydra"
// is answered by either the init line OR the shape.
export const HYDRA_SHAPE_PATTERN = { source: HYDRA_SHAPE_RE.source, flags: HYDRA_SHAPE_RE.flags };

// A `*name: code` declaration — a personal-editor button (see
// editor-router-core.js parseStrudelButtons), never a voice. It runs on through
// the lines that continue its expression: a `.method(` chain line (the docs'
// own example puts `.note(…)` on the next line) or the rest of a call left
// open, by the same rule miniToMondo gathers a `$:` voice. Stripping only the
// `*` line would leave that chain behind — a syntax error on its own, or glued
// onto whichever voice sits above it.
const BUTTON_DECL_RE = /^\*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(.*)$/;

// Every declaration in `code`, in source order: { name, body, start, end }.
// `body` is the expression after `name:` across all of its lines, comments
// stripped; `start`/`end` are the lines it occupies (end exclusive).
export function buttonDeclarations(code) {
  const lines = String(code ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BUTTON_DECL_RE.exec(lines[i]);
    if (!m) continue;
    const body = [stripInlineComments(m[2]).trimEnd()];
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j];
      if (BUTTON_DECL_RE.test(nxt) || /^\s*\$:/.test(nxt) || /^\s*\$[ \t]/.test(nxt) || /^\s*#[ \t]/.test(nxt)) break;
      if (!/^\s*\.[A-Za-z_$]/.test(nxt) && balanced(body.join('\n'))) break;
      body.push(stripInlineComments(nxt).trimEnd());
      j++;
    }
    out.push({ name: m[1], body: body.join('\n').trim(), start: i, end: j });
    i = j - 1;
  }
  return out;
}

function stripButtonDeclarations(code) {
  const lines = String(code ?? '').split('\n');
  for (const d of buttonDeclarations(code).reverse()) lines.splice(d.start, d.end - d.start, '');
  return lines.join('\n');
}

// Editor text minus the noise that is never part of either language: the
// leading `'personal editor'` / `'bot editor'` directive line, trailing
// whitespace/semicolons, `*name: code` declarations (studio button widgets,
// not patterns), and `botConfig(...)` declarations (bot-cluster settings, not
// patterns) — then a mondo buffer lowered to the Strudel form. buildPeerBlock
// strips exactly these before testing for a preamble, so the mosaic has to
// strip them too or a leading widget line would hide an otherwise-valid
// preamble.
//
// The directive and botConfig both have to go before Strudel's transpiler sees
// the block: botConfig's argument is free text and the transpiler mini-parses
// every double-quoted string, so a quoted value left in place would throw and
// stop the whole room's program; the directive is a bare string literal that
// would otherwise evaluate as a stray pattern.
//
// mondo lowering runs LAST here, on the cleaned body, so the `word()`/`css()`/
// `.out()` shapes it produces are what ensureCapabilityPreambles then sniffs —
// a `$ word "hi"` block gets its `await initTextCycles()` the same as
// `$: word("hi")` would. A plain Strudel buffer (no `$`/`#` voice markers) and
// one already written `$: …` are left untouched; a buffer that mixes the two
// notations is left as-is for the transpiler to reject (the local editor names
// the mistake — see studio.js).
//
// `.out("device")` routes come off before the preamble sniff, too: a Strudel
// voice's `.out("speakers")` would otherwise read as Hydra's `.out(` render
// shape and earn an `await initHydra()` it never asked for. What a route
// leaves behind (see output-route-core.js) is exactly the code that ran
// before routes existed, so the browser, the mosaic and a bot all evaluate
// the same thing they always did; peerOutRoutes below is how the routes
// themselves are read.
function lowerPeerCode(code) {
  const cleaned = stripButtonDeclarations(stripPermissionsConfig(stripBotConfig(stripDirective(code || ''))))
    .replace(/[\s;]+$/g, '')
    .trim();
  return detectNotation(cleaned) === 'mondo' ? mondoToMini(cleaned) : cleaned;
}

export function normalizePeerCode(code) {
  return ensureCapabilityPreambles(extractOutRoutes(lowerPeerCode(code)).code);
}

// The `.out("device")` routes a performer's buffer declares — see
// output-route-core.js's extractOutRoutes for the shape of each.
export function peerOutRoutes(code) {
  return extractOutRoutes(lowerPeerCode(code)).routes;
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
    if (!isHydraParagraph(paragraph)) {
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
  if (isHydraParagraph(trailing)) {
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

// initCam/initScreen genuinely need hardware only the performer's own browser
// has; initImage/initVideo populate a slot from an ADDRESSABLE URL instead
// (Trussal's own local uploads excepted — see usesLocalImage, checked
// separately), which the aggregator/a bot can fetch and render just as well
// itself. Only the former forces a blit.
const CAM_OR_SCREEN_RE = /(^|[^\w$])s[0-3]\s*\.\s*init(?:Cam|Screen)\s*\(/;
// Any explicit call that populates a source slot — including initImage/
// initVideo, which settle a bare sN reference as safely re-executable rather
// than leaving it in the "no call visible" ambiguous case below.
const ANY_SOURCE_INIT_RE = /(^|[^\w$])s[0-3]\s*\.\s*init(?:Cam|Screen|Image|Video)\s*\(/;

// Does the preamble reference an External Source slot (s0-s3) in a way the
// aggregator/a bot cannot reproduce itself? In Hydra those exist ONLY to hold
// external media — initCam, initScreen, initImage, initVideo, or a raw
// init({src}) — never a procedural generator, which Hydra always exposes as a
// bare function (osc, noise, shape…) rather than through a source slot.
// initCam/initScreen need the performer's own camera/screen, which no one
// else has — always a blit. initImage/initVideo hand it a URL, which is just
// as fetchable from any other browser (Trussal's own local-upload URLs
// excepted — usesLocalImage catches those), so a preamble whose ONLY source
// calls are initImage/initVideo does not need the performer's published
// track. A bare sN reference with NO init call visible in this preamble at
// all stays conservative — hydra-video.js's own direct-mode camera auto-feed
// into s0 has no call visible here either, so it still means "could be the
// camera" and still blits. Matches s0-s3 as a whole word so `s01` or `foos0`
// don't trip it.
export function usesExternalSource(code) {
  const split = splitHydraCode(code);
  if (!split) return false;
  const { preamble } = split;
  if (!/(^|[^\w$])s[0-3]($|[^\w$])/.test(preamble)) return false;
  if (CAM_OR_SCREEN_RE.test(preamble)) return true;
  return !ANY_SOURCE_INIT_RE.test(preamble);
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

// Does the Strudel half hand Hydra chains to multiArrange()/multiStack()?
// Those are drawn by Strudel triggers on the performer's own page, and the
// aggregator never runs the Strudel half (MosaicCells sends it the preamble
// alone), so re-executing would draw nothing at all. The performer's published
// track mirrors their Hydra canvas — blit it, as for the camera.
export function sequencesHydra(code) {
  const split = splitHydraCode(code);
  if (!split) return false;
  return MULTI_CALL_RE.test(split.strudel) && HYDRA_SHAPE_RE.test(split.strudel);
}

export function mosaicCellSource(code) {
  if (!hasHydraCode(code)) return null;
  return (usesExternalSource(code) || usesLocalImage(code) || sequencesHydra(code)) ? 'blit' : 'reexecute';
}
