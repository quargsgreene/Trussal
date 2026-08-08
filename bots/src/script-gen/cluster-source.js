/**
 * Where a cluster's code comes from.
 *
 * Before botConfig, every bot in every room derived from one fleet-wide
 * `randomMasterScript`. Now each human's cluster derives from THAT human's
 * editor at the moment they pressed spawn, shaped by their `botConfig(...)`.
 * The fleet-wide random script survives as the fallback for a spawn that
 * carries no code, and as what `random: "full"` reaches for.
 *
 * Snapshot, not mirror: `captureClusterSource` is called on spawn and the text
 * is kept. A bot plays what its human was playing when it spawned, and only a
 * `retroactive: true` config re-captures. That is deliberate — a live mirror
 * would rewrite every bot's part mid-phrase every time its author typed.
 *
 * This module is pure so the whole matrix is testable without containers: it
 * takes code and a config and returns the {strudel, hydra, announceStrudel}
 * triple the bot boots with. `strudel`/`hydra` are what its own REPL
 * evaluates; `announceStrudel` is the separate string peer-state broadcasts
 * as this bot's pattern, which is what lets `textParrot`/`cssParrot` reach
 * other viewers even though the bot's own REPL can run neither (see
 * dropTextStatements/dropCssStatements). Everything about how the eval pair
 * sits in the MIX — band, stereo position, entry offset, gain staging, link
 * fx — stays in variation.js and is applied afterwards, unchanged.
 */

import { splitHydraCode, normalizePeerCode } from '../../../src/hydra-code.js';
import { splitStatements, WORD_CALL_RE } from '../../../src/text-cycles-core.js';
import { CSS_CALL_RE } from '../../../src/css-cycles-core.js';
import { defaultBotConfig, flag, parseBotConfig } from '../../../src/bot-config.js';
import { wrapAsVoice } from '../../../src/strudel-voice.js';
import { randomMasterScript } from './generator.js';
import {
  applyParamFactor,
  colorHydraPostlude,
  harmonySuffix,
  randomizeParams,
} from './bot-config-transform.js';

/**
 * Split a performer's editor text into the {strudel, hydra} shape the bot boot
 * path already speaks, using the browser's own rule so the fleet and the page
 * never disagree about where the preamble ends. `botConfig(...)` is stripped by
 * normalizePeerCode on the way through — the declaration configures the bots,
 * it is not part of what they play.
 */
export function masterFromPerformerCode(code) {
  const normalized = normalizePeerCode(code);
  if (!normalized) return null;
  const split = splitHydraCode(normalized);
  if (split) return { strudel: split.strudel, hydra: split.preamble };
  return { strudel: normalized, hydra: '' };
}

/**
 * Capture what a cluster will be built from. Returns the snapshot the fleet
 * stores per (room, owner); a spawn with no usable code falls back to the
 * fleet's own random master so a bot still plays something.
 *
 * A config that fails to parse is reported rather than silently ignored: the
 * performer typed something they expect to take effect, and a botConfig with a
 * typo would otherwise spawn a cluster that quietly behaves like the default.
 */
export function captureClusterSource(code, { fallbackMaster = null, seed = 0 } = {}) {
  const parsed = parseBotConfig(code);
  const master = masterFromPerformerCode(code)
    ?? fallbackMaster
    ?? randomMasterScript(seed);

  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      // Still usable: a broken config falls back to exact copies rather than
      // refusing to spawn, so a typo costs the config, not the cluster.
      source: { master, config: defaultBotConfig(), declared: false, capturedAt: Date.now() },
    };
  }

  return {
    ok: true,
    source: {
      master,
      config: parsed.config,
      declared: parsed.present,
      capturedAt: Date.now(),
    },
  };
}

/**
 * Flatten a {strudel, hydra} script back into one editor block, the way a
 * performer would have typed it: preamble, blank line, pattern. That blank line
 * is load-bearing — splitHydraCode is what the receiving page uses to find
 * where the preamble ends.
 *
 * Used when the fleet drives a running bot's REPL (a retroactive re-latch),
 * which speaks the same single-string remote-control path a human's edit does.
 */
export function scriptToEditorCode(script) {
  const hydra = String(script?.hydra ?? '').trim();
  const strudel = String(script?.strudel ?? '').trim();
  if (!hydra) return strudel;
  if (!strudel) return hydra;
  return `${hydra}\n\n${strudel}`;
}

/**
 * Locate a top-level `stack(` call by balancing parens from the opening one,
 * skipping string/template contents (mirrors findBotConfigCall). Returns
 * `{ start, close, argsText }` for the FIRST such call, or null.
 */
function findStackCall(text) {
  const match = /(^|[^\w$.])stack\s*\(/.exec(text);
  if (!match) return null;
  const start = match.index + match[1].length;
  const open = text.indexOf('(', start);
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { start, close: i, argsText: text.slice(open + 1, i) };
    }
  }
  return null; // unbalanced — leave the statement to the whole-statement fallback
}

/**
 * Split a `stack(...)` call's arguments on top-level commas only, respecting
 * nested parens/brackets/braces and string/template contents.
 */
function splitStackArgs(argsText) {
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += argsText[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') args.push(cur);
  return args;
}

/**
 * A chunk of code that names a call matching `callRe` (`word(`/`w(`, or
 * `css(`) loses only that branch, not everything in it. Vanilla Strudel's own
 * idiom for combining layers is `stack(...)`, and a performer routinely
 * writes their audio alongside their words or styling as siblings inside one
 * `stack(...)` rather than as separate `$:` voices — dropping the whole thing
 * in that case would silence the audio too, even though `stack()`'s own
 * siblings never depended on each other. Only a top-level `stack(...)` gets
 * this treatment; `s("bd").word("x")` genuinely has nothing left once its
 * word() is gone (the docs are explicit that a dominant trigger already
 * silences that whole hap), so that case still drops the whole thing.
 */
function stripBranchesMatching(text, callRe) {
  const call = findStackCall(text);
  if (!call) return null;
  const survivors = splitStackArgs(call.argsText)
    .filter((arg) => !callRe.test(arg))
    .map((arg) => arg.trim())
    .filter(Boolean);
  if (!survivors.length) return null;
  const rebuilt = `stack(\n  ${survivors.join(',\n  ')}\n)`;
  return text.slice(0, call.start) + rebuilt + text.slice(call.close + 1);
}

/**
 * Drop every unit of code that declares or calls a capability, keeping
 * everything else untouched — including a sibling that shares a line group
 * with it. A capability's declaration/voice can sit next to something that
 * must survive in either of two shapes real code uses, so both have to be
 * split independently:
 *
 *   - blank-line paragraphs (the unit hydra-code.js and strudel-voice.js
 *     split on) — a trailing plain audio pattern in ITS OWN paragraph right
 *     after a text/css one, exactly how the capability docs show combining
 *     Hydra/Text/CSS with a final pattern;
 *   - label lines with NO blank line between them (`$: word(...)\n$: s(...)`)
 *     — splitStatements' unit, the shape a performer gets by writing two
 *     `$:` voices back to back.
 *
 * Paragraph-splitting alone loses the second shape (a sibling voice with no
 * call of its own gets swept into the same paragraph and dropped with it);
 * label-splitting alone loses the first (it has no notion of a blank line, so
 * a trailing unlabeled pattern is swept into whichever labeled statement
 * precedes it). Doing both, outer-then-inner, loses neither.
 */
function dropCapabilityParagraphs(strudel, { initRe, callRe }) {
  const src = String(strudel ?? '');
  if (!initRe.test(src) && !callRe.test(src)) return src;
  const dropChunk = (chunk) => {
    const stripped = stripBranchesMatching(chunk, callRe);
    if (stripped !== null) return stripped;
    // No stack() to salvage a sibling from: drop the whole chunk only if IT
    // is what declares or calls this capability.
    if (initRe.test(chunk) || callRe.test(chunk)) return null;
    return chunk;
  };
  const kept = src.split(/\n\n+/).map((paragraph) => {
    if (!paragraph.trim()) return null;
    const survivors = splitStatements(paragraph)
      .map((s) => dropChunk(s.text))
      .filter((c) => c !== null);
    return survivors.length ? survivors.join('\n') : null;
  }).filter((p) => p !== null);
  return kept.join('\n\n').trim();
}

/**
 * Strip the statements that paint words, for a bot whose human did not ask for
 * `textParrot`. Without this every bot in a cluster would repeat its author's
 * words, N times over, in every viewer's chat panel.
 */
export function dropTextStatements(strudel) {
  return dropCapabilityParagraphs(strudel, {
    initRe: /^\s*await\s+initTextCycles\s*\(/m,
    callRe: WORD_CALL_RE,
  });
}

/**
 * Strip the statements that restyle the page. Always applied to what the
 * bot's OWN REPL evaluates (see botScriptFor) — `css(`/`await initCss()` are
 * undefined there: bots boot a separate, vanilla `@strudel/repl` fetched
 * fresh from unpkg (pageStrudelBoot) rather than the Trussal bundle's engine,
 * so it never gets `installCssCycles`'s controls the way the main Jitsi page
 * does. A bot whose captured code carries a css() voice fails evaluation
 * outright otherwise — the "pattern did not start after evaluation" crash the
 * moment a performer's repertoire combines CSS Cycles with a bot spawn.
 *
 * Also applied to `announceStrudel` unless `cssParrot` is set — mirrors
 * dropTextStatements/textParrot: css() never rides the bot's own eval, but it
 * DOES reach the room a different way when parroted, through every OTHER
 * viewer's own page (buildBotSilentBlock in strudel.js extracts it from the
 * announced pattern), the same as a bot's words already do.
 */
export function dropCssStatements(strudel) {
  return dropCapabilityParagraphs(strudel, {
    initRe: /^\s*await\s+initCss\s*\(/m,
    callRe: CSS_CALL_RE,
  });
}

/**
 * The {strudel, hydra} one bot boots with, before variation.js positions it in
 * the mix.
 *
 * `index` is the bot's ordinal within its own cluster (0-based), which is what
 * every spread — harmony voicing, colour scheme — is measured along, so a
 * cluster of N covers N positions rather than every bot landing on the same one.
 */
export function botScriptFor(source, { index, count = 1, seed = 0, botId = 0 } = {}) {
  const config = source?.config ?? defaultBotConfig();
  const master = source?.master ?? { strudel: '', hydra: '' };

  // `random: "full"` replaces the human's code outright — "fully randomizes the
  // code of each bot within existing constraints", and the curated palette in
  // generator.js is what those constraints are. Seeded per bot so a replacement
  // container rebuilds the identical script.
  const base = config.random === 'full'
    ? randomMasterScript(seed + botId + 1)
    : { strudel: master.strudel || '', hydra: master.hydra || '' };

  let strudel = base.strudel;
  let hydra = base.hydra;

  // What OTHER viewers see this bot declare — text/css statements survive
  // here per `textParrot`/`cssParrot`, because that is how they actually
  // reach the room: peer-state announces this string as the bot's `pattern`,
  // and every OTHER peer's own page extracts word()/css() statements out of
  // it (buildBotSilentBlock in strudel.js). Computed from the unshaped base,
  // before numeric shaping/harmony/the mix chain below — those are
  // audible-only details that path never looks at.
  let announceStrudel = flag(config.textParrot) ? strudel : dropTextStatements(strudel);
  announceStrudel = flag(config.cssParrot) ? announceStrudel : dropCssStatements(announceStrudel);

  // What the bot's OWN REPL evaluates. ALWAYS stripped of both, regardless of
  // textParrot/cssParrot: that REPL is a separate, vanilla @strudel/repl
  // instance (see page-scripts.js's pageStrudelBoot) that never gets
  // Trussal's installTextCycles/installCssCycles, so `word`/`css`/their init
  // calls are undefined there. Parroting is a broadcast-only concept — the
  // bot's own eval can never run either, parrot flag or not.
  strudel = dropCssStatements(dropTextStatements(strudel));

  // Numeric shaping. paramFactor is the deterministic sibling of
  // random:"params"; when both are set the factor is applied first so the
  // jitter is measured around the scaled value the author asked for.
  if (config.paramFactor != null) {
    strudel = applyParamFactor(strudel, config.paramFactor);
    hydra = applyParamFactor(hydra, config.paramFactor);
  }
  if (config.random === 'params') {
    strudel = randomizeParams(strudel, seed + botId + 1);
    hydra = randomizeParams(hydra, seed + botId + 101);
  }

  // Pitch. Appended to the whole expression rather than rewritten into it, so
  // it composes with whatever the author wrote (see variation.js). Goes
  // through wrapAsVoice, not a bare `(strudel)` wrap — the code is more than
  // one expression once it carries a separate $: css(...)/$: word(...) voice
  // alongside the audio pattern, and wrapping THAT in one grouping expression
  // is a SyntaxError (see strudel-voice.js).
  const harmony = harmonySuffix(config.harmony, index, base.strudel, seed);
  if (harmony && strudel.trim()) strudel = wrapAsVoice(strudel, harmony);

  // Colour. A postlude reading o0 and writing back to it, exactly as the band
  // and tile roles do, so it stacks with them instead of replacing them.
  const colour = colorHydraPostlude(config.colorScheme, index, count, seed);
  if (colour && hydra.trim()) hydra = `${hydra}\n${colour}`;

  return { strudel, hydra, announceStrudel };
}
