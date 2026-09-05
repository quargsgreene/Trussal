// JPattern metaprogram parser: text → AST.
//
// The metaprogramming language is Mondo-flavoured (strudel.cc mini-notation
// sequences) but deliberately tiny: one `$ participants` scheduling sequence
// plus `#`-chained directives (one cyclic timing mode, a tempo, network-
// modulated AV effects, and a whitelist of Strudel-analog pattern functions).
// Everything else — arbitrary Strudel calls, any Hydra call, a parenthesized
// expression anywhere — is a validation error. Effect arguments are plain
// positive numbers, except where a signature opts in to mini-notation values
// (`# room` and `# crush`'s metric/scale/pinned amount, `# echo`'s scales and
// bounds, `# noise`'s every slot): those parse to a `valueSeq` node the caller
// reads per cycle via ValuePattern.js, and may carry rests and a `*n` / `/n`
// rate. `# noise` takes `<…>` alternation at rate 1 or slower only — it is
// re-derived once per cycle boundary, so a `[…]` subdivision or a `*2` has
// nowhere to land.
//
// A statement written with a leading `*` (`*$ participants <2a 2b>`) is a
// BUTTON DECLARATION rather than a statement: inert to this parser, rendered
// as a button by the JPattern editor, and written into the program only when
// that button is pressed. It is the metaprogram's `*name: code`.
//
// Pure module: no DOM, no WebAudio, no Strudel import, so it runs identically
// in the browser bundle, in bots, and under node:test. Errors carry
// line/col (1-based) for editor squiggles.

// Participant token validation shares the sidecar's index rules.
// (CJS module; esbuild interops it into the browser bundle.)
import {
  isValidParticipantToken,
  parseParticipantToken
} from '../../latency-instrument/room-indices.js';
// echo's slot names, legal metrics and default slots are the effect's own
// business (av-effects/Echo.js), not the grammar's — the parser reads them
// from there rather than keeping a second copy that could drift. Nothing in
// that module touches WebAudio until createEchoNode() is CALLED with a
// context, so importing it keeps this parser loadable in the bots process.
import { ECHO_METRICS, ECHO_SLOTS, ECHO_DEFAULT_SLOTS } from './av-effects/Echo.js';
// # breakout's JSON-object argument shape and validation — one rule, shared
// with src/audio-net/Breakout.js (which reads program.breakouts/assignments
// to actually create rooms and move participants).
import { parseBreakoutLiteral } from '../breakout-core.js';
// The one reader for every patterned `#` argument, whatever the effect — and
// the bare-`?` probability, which is that reader's to define rather than the
// grammar's.
import {
  evaluateValuePattern, isValuePattern, isDataRefNode, DEFAULT_DROP_CHANCE,
} from './ValuePattern.js';
// Which media an effect may name, and how a written set resolves. The grammar
// validates against the same list the four consumers gate on.
import { MEDIA, isMedium, normalizeMediaSet } from './EffectMedia.js';
// The one rule for which of Trussal's three program kinds a buffer is. A
// metaprogram must open with the `'metaprogram editor'` directive — it is what
// tells this parser it is looking at a metaprogram, so `participants` no longer
// has to be a reserved word carrying that signal.
import { readDirective, stripDirective } from '../program-directive.js';
// The two surface notations a metaprogram may be written in. This parser is
// the `$`/`#` ("mondo") grammar, so a "mini" buffer — Strudel-style
// `$: participants("<0 1>").cycles("wcl", 10)` — is lowered to it here before
// tokenising. See src/notation.js.
import { detectNotation, miniToMondo } from '../notation.js';

export const TIMING_METRICS = ['wcl', 'wcpl'];

// `# ring <mode>` selects how the turn rotation order is derived:
//   explicit  the literal `$ participants <…>` sequence, walked cyclically
//             (an unwritten `# ring` means this — byte-identical to the old
//             behaviour). `buildDefaultProgram()` now ships `# ring hash`, so
//             a fresh room starts in hash mode; edit the line to opt out.
//   hash      the consistent-hash order of the room's PRESENT tokens
//             (TurnRing.orderTokens), recomputed each cycle from the live
//             roster, so a join/leave perturbs O(1/N) of the ring and needs
//             no `$ participants` edit. `$ participants` must still be present
//             syntactically (a program has one); its contents seed nothing in
//             hash mode. Optional `w <token> <weight> …` pairs bias a token's
//             share of turns (weighted rendezvous — see weightedRingSlots).
export const RING_MODES = ['explicit', 'hash'];
// Metrics an effect may be modulated by. Wider than TIMING_METRICS: wcrtt
// cannot set a cycle length (it is a round trip, not a turn) but it is a
// perfectly good modulation source.
export const EFFECT_METRICS = ['wcl', 'wcrtt', 'wcpl'];

// A metric keyword is ALWAYS quoted — `# cycles "wcl" 20`, `# room "wcpl" 2`,
// `# crush <"wcl" "wcpl"> <2 4>` — so it tokenises as a `string`, never a bare
// `word`. This is the one spelling mini notation can express, and keeping it
// the only one means the two surface notations read a metric identically.
// `"audio"`/`"video"`/… are media names, a disjoint set; atMediaArg gates on
// isMedium() so a quoted metric is never taken for one.
function isMetricKeywordToken(t) {
  return !!t && t.type === 'string';
}

// Every metric keyword, for spotting a bare (unquoted) one and telling the
// author to quote it rather than falling through to a vaguer error.
const METRIC_WORDS = new Set(['wcl', 'wcrtt', 'wcpl']);

// A room with no `# mosaic` directive still tiles: the mosaic is the resting
// state of the aggregator's video, and `# mosaic false` is the deviation from
// it. Kept as a consumer-side default rather than a line injected into
// buildDefaultProgram, for the same reason `# tempo` is left unwritten — the
// AST should report the directives performers actually typed.
export const MOSAIC_ENABLED_BY_DEFAULT = true;

// Whether a parsed pattern holds metric keywords or numbers, taken from its
// first leaf. `# noise`'s slots are positional, so which of the two a `<…>`
// carries is only known once it has been read.
function valuePatternKind(node) {
  if (!isValuePattern(node)) return null;
  // A data reference reads out as a number, so it settles a mixed sequence the
  // same way a literal one does — `<wcl Weather:1>` is the same mistake as
  // `<wcl 3>`.
  if (isDataRefNode(node)) return 'number';
  for (const term of node.terms || []) {
    if (isValuePattern(term)) {
      const inner = valuePatternKind(term);
      if (inner) return inner;
    } else if (typeof term === 'string') return 'metric';
    else if (typeof term === 'number') return 'number';
  }
  return null;
}
export const TEMPO_UNITS = ['bpm', 'cps', 'cpm'];

// Modifiers that attach to ONE element of a patterned `#` argument, the same
// four that attach to one turn of a `$ participants` sequence.
const VALUE_ELEMENT_OPS = new Set(['@', '?', '!', '*', '/']);

// `!` expands at parse time, so the count is a real allocation rather than a
// number the reader walks past. The scheduler bounds the same work per cycle
// with MAX_EXPANSION_STEPS; this is that bound applied to one written element.
export const MAX_VALUE_REPEATS = 1024;

// crush reads any worst-case metric, wcrtt included — unlike `# cycles`,
// which turns its metric into a duration and has no meaning for a round trip.
export const CRUSH_METRICS = ['wcl', 'wcpl', 'wcrtt'];

// name → { minArgs, maxArgs, kind } for every legal `#` directive besides
// cycles/tempo. Args are positive reals unless noted. `metricKeywords`
// requires a leading metric word before the numeric args (`# room wcl 2 0.4`);
// `metricPairs` instead takes that many <metric> <scale> pairs, one per
// parameter, followed by that many optional upper bounds (`# echo`, below).
// `patternArgs` additionally lets the metric and the numbers be written as
// mini-notation sequences (`# crush <wcl wcrtt> <2 4>`), read per cycle — rests
// and a trailing `*n` / `/n` rate included. `mediaArg` allows the trailing
// medium set (`# crush wcl 2 ["audio" "video"]`), which narrows the effect
// from its whole-room default and patterns like any other argument.
const EFFECTS = {
  // scale=1, fixed metric amount=live. Any worst-case metric may drive the
  // decay, and all three arguments pattern — `# room <wcl wcrtt> <1 2 ~ 2 3>*2`.
  room: { minArgs: 0, maxArgs: 2, kind: 'effect', metricKeywords: EFFECT_METRICS, patternArgs: true, mediaArg: true },
  echo: {
    kind: 'effect',
    metricKeywords: ECHO_METRICS,
    metricPairs: ECHO_SLOTS,          // length (cycles), feedback, gain
    patternArgs: true,                // scales and bounds may be <2 3> / [1 4]
    mediaArg: true,
    usage: '# echo <metric> <length> <metric> <feedback> <metric> <gain> [<bound> <bound> <bound>] [<media>]'
  },
  // scale=1 (8-bit base), fixed metric amount=live
  crush: { minArgs: 0, maxArgs: 2, kind: 'effect', metricKeywords: CRUSH_METRICS, patternArgs: true, mediaArg: true },
  // noise interleaves two metric keywords with its numbers and takes patterns
  // in any slot, which parseChainFn's positional-numbers grammar cannot
  // express — it parses in parseNoise instead.
  noise: { kind: 'effect', grammar: 'noise', metricKeywords: EFFECT_METRICS, patternArgs: true, mediaArg: true },
  grid: { minArgs: 0, maxArgs: 1, kind: 'effect', boolArg: true }, // landmarks=false
  // How the aggregator arranges the room's Hydra output in its published
  // frame: true (or bare) tiles every Hydra participant into a square mosaic,
  // false shows only whoever is streaming, full-frame. Unwritten means the
  // mosaic — see MOSAIC_ENABLED_BY_DEFAULT, which is where that default lives
  // rather than in an injected directive nobody typed.
  mosaic: { minArgs: 0, maxArgs: 1, kind: 'effect', boolArg: true }
};

const PATTERN_FNS = {
  ply: { minArgs: 1, maxArgs: 1 },
  chop: { minArgs: 1, maxArgs: 1 },
  shuffle: { minArgs: 0, maxArgs: 1 },
  degrade: { minArgs: 0, maxArgs: 0 },
  degradeBy: { minArgs: 1, maxArgs: 1, probability: true },
  undegrade: { minArgs: 0, maxArgs: 0 },
  undegradeBy: { minArgs: 1, maxArgs: 1, probability: true },
  hush: { minArgs: 0, maxArgs: 0 },
  // Stack producers: duplicate/superimpose with a one-cycle offset.
  jux: { minArgs: 0, maxArgs: 0, stacking: true },
  superimpose: { minArgs: 0, maxArgs: 0, stacking: true, takesSequence: true }
};

// ---------------------------------------------------------------------------
// Tokenizer

const PUNCT = new Set(['<', '>', '[', ']', '(', ')', ',', '|']);
const OPS = new Set(['*', '/', '@', '!', '?', '%', ':']);
const RESTS = new Set(['~', '_', '-']);

function tokenize(text) {
  const tokens = [];
  const errors = [];
  let line = 1, col = 1;
  let i = 0;
  const n = text.length;
  // `raw` is carried only where the parsed value cannot reproduce the spelling
  // (`0.50`, `007`) — see tokenWidth, which measures a token's source extent.
  const push = (type, value, l, c, raw = null) => tokens.push({ type, value, line: l, col: c, raw });

  while (i < n) {
    const ch = text[i];
    const startLine = line, startCol = col;
    const advance = (k = 1) => {
      for (let j = 0; j < k; j++) {
        if (text[i] === '\n') { line++; col = 1; } else { col++; }
        i++;
      }
    };

    if (ch === '\n') { push('newline', '\n', startLine, startCol); advance(); continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { advance(); continue; }
    if (ch === '/' && text[i + 1] === '/') { // comment to end of line
      while (i < n && text[i] !== '\n') advance();
      continue;
    }
    if (ch === '"') {
      // Medium names are the only strings the language has, so this lexeme
      // exists for them alone — which is also what keeps `["audio" "video"]`
      // distinguishable from the numeric subdivision `[1 4]` that every
      // patterned argument already spells with the same brackets.
      let j = i + 1;
      while (j < n && text[j] !== '"' && text[j] !== '\n') j++;
      const terminated = text[j] === '"';
      if (!terminated) {
        errors.push({
          message: 'unterminated string — a medium name closes with a \'"\' on the same line',
          line: startLine, col: startCol
        });
      }
      // The raw spelling carries the quotes so tokenWidth measures the token's
      // real source extent and an editor squiggle covers what was written.
      push('string', text.slice(i + 1, j), startLine, startCol, text.slice(i, terminated ? j + 1 : j));
      advance(j - i + (terminated ? 1 : 0));
      continue;
    }
    if (ch === "'") {
      // A second, DIFFERENT quote character exists solely so `# breakout` and
      // `# assign` can carry a JSON object literal (breakout-core.js): JSON's
      // own strings are double-quoted, so wrapping the whole blob in single
      // quotes instead is what lets `'{"name":"Room A"}'` tokenize as ONE
      // string rather than terminating at the first internal `"`. Same
      // no-escaping, same-line-only scan as the `"` branch above; still
      // produces a 'string' token so every existing `t.type === 'string'`
      // check (medium sets, metric keywords) is unaffected by a directive
      // that happens to use this instead.
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== '\n') j++;
      const terminated = text[j] === "'";
      if (!terminated) {
        errors.push({
          message: "unterminated string — a breakout/assign literal closes with a \"'\" on the same line",
          line: startLine, col: startCol
        });
      }
      push('string', text.slice(i + 1, j), startLine, startCol, text.slice(i, terminated ? j + 1 : j));
      advance(j - i + (terminated ? 1 : 0));
      continue;
    }
    if (ch === '$' || ch === '#') { push('sigil', ch, startLine, startCol); advance(); continue; }
    if (ch === '.' && text[i + 1] === '.') { push('op', '..', startLine, startCol); advance(2); continue; }
    if (PUNCT.has(ch)) { push('punct', ch, startLine, startCol); advance(); continue; }
    if (OPS.has(ch)) { push('op', ch, startLine, startCol); advance(); continue; }
    if (RESTS.has(ch)) {
      // `-` and `_` are rests only when they stand alone; a `-` glued to a
      // digit would be a negative number, which the language never allows.
      push('rest', ch, startLine, startCol); advance(); continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9]/.test(text[j])) j++;
      if (text[j] === '.' && /[0-9]/.test(text[j + 1] || '')) { // decimal number
        j++;
        while (j < n && /[0-9]/.test(text[j])) j++;
        const raw = text.slice(i, j);
        push('number', parseFloat(raw), startLine, startCol, raw);
        advance(j - i);
        continue;
      }
      // digits then trailing letters → participant index token (`2a`);
      // plain digits stay ambiguous (participant or number) → 'intlike'.
      let k = j;
      while (k < n && /[a-z]/.test(text[k])) k++;
      const raw = text.slice(i, k);
      if (k > j) push('index', raw, startLine, startCol);
      else push('intlike', raw, startLine, startCol);
      advance(k - i);
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(text[j])) j++;
      // `Weather:3` — a data pack reference, the same spelling Strudel takes.
      // Claimed here rather than left to the `:` op, which no rule consumes.
      if (text[j] === ':' && /[0-9]/.test(text[j + 1] || '')) {
        let k = j + 1;
        while (k < n && /[0-9]/.test(text[k])) k++;
        const raw = text.slice(i, k);
        push('dataref', { name: text.slice(i, j), index: parseInt(text.slice(j + 1, k), 10) },
          startLine, startCol, raw);
        advance(k - i);
        continue;
      }
      push('word', text.slice(i, j), startLine, startCol);
      advance(j - i);
      continue;
    }
    errors.push({ message: `unexpected character '${ch}'`, line: startLine, col: startCol });
    advance();
  }
  push('eof', null, line, col);
  return { tokens, errors };
}

// ---------------------------------------------------------------------------
// Parser

// How many source characters a token spans. Numbers carry their raw spelling
// because parseFloat loses it (`0.50`, `007`); every other token is written
// exactly as its value.
function tokenWidth(t) {
  return String(t.raw != null ? t.raw : (t.value ?? '')).length;
}

// A token as it was written, for error messages. Only `dataref` carries a
// structured value, which would otherwise read as '[object Object]'.
function tokenText(t) {
  return String(t.raw != null ? t.raw : (t.value ?? ''));
}

class Parser {
  constructor(tokens, errors) {
    this.tokens = tokens.filter(t => t.type !== 'newline' || true); // keep newlines: statement boundaries
    this.pos = 0;
    this.errors = errors;
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  next() { return this.tokens[this.pos++]; }
  atEof() { return this.peek().type === 'eof'; }
  error(message, tok) {
    const t = tok || this.peek();
    this.errors.push({ message, line: t.line, col: t.col });
  }
  skipNewlines() { while (this.peek().type === 'newline') this.next(); }

  // A bare (unquoted) metric keyword where a quoted one belongs. Records the
  // "quote it" error and returns true so the caller can bail; false leaves the
  // caller to its own "needs a metric" path for a token that is not a metric
  // word at all.
  rejectBareMetric(t) {
    if (t && t.type === 'word' && METRIC_WORDS.has(t.value)) {
      this.error(`metric keywords are quoted — write "${t.value}", not ${t.value}`, t);
      return true;
    }
    return false;
  }

  // Consume the rest of the physical line. A button declaration is one line,
  // as `*name: code` is in the personal editor — it is skipped whole rather
  // than validated, because nothing in it runs until its button writes it
  // into the program, where it is parsed like any other statement.
  skipDeclarationLine() {
    while (!this.atEof() && this.peek().type !== 'newline') this.next();
  }

  // Consume to the start of the next statement ($ or # at statement level) so
  // one bad statement doesn't cascade.
  recover() {
    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'sigil') {
        // The sigil of a `*$` / `*#` declaration is not a statement start:
        // stopping on it would run a declared voice that nobody pressed, and
        // one typo above a declaration is all it takes. Back onto the '*' so
        // parseProgram skips the whole line. Only a '*' GLUED to the sigil
        // counts — a newline token sits between a trailing `*` modifier and
        // the next statement's sigil.
        const prev = this.tokens[this.pos - 1];
        if (prev && prev.type === 'op' && prev.value === '*') this.pos--;
        return;
      }
      this.next();
    }
  }

  parseProgram() {
    const program = {
      participants: null, cycles: null, tempo: null, ring: null, chain: [],
      // # breakout / # assign — see breakout-core.js. Both repeatable, folded
      // in source order by resolveBreakoutState rather than treated as a
      // singleton the way cycles/tempo/ring are.
      breakouts: [], assignments: [],
    };
    this.skipNewlines();
    while (!this.atEof()) {
      const t = this.peek();
      // `*$ …` / `*# …` — a BUTTON DECLARATION, not a statement. The personal
      // Strudel editor's `*name: code` lines are stripped before evaluation
      // (strudel.js) and surface as voice buttons instead; these are the same
      // thing for the metaprogram, so the grammar has to see them as inert
      // rather than as a broken statement. Pressing the button is what puts
      // the declared voice into the program (editor-router-core.js).
      if (t.type === 'op' && t.value === '*' && this.peek(1).type === 'sigil') {
        this.skipDeclarationLine();
        this.skipNewlines();
        continue;
      }
      if (t.type !== 'sigil') {
        this.error(`expected '$' or '#' at start of statement, got '${t.value}'`, t);
        this.next();
        this.recover();
        this.skipNewlines();
        continue;
      }
      if (t.value === '$') this.parseDollar(program);
      else this.parseDirective(program);
      this.skipNewlines();
    }

    if (!program.participants) {
      this.errors.push({ message: "missing '$' scheduling sequence", line: 1, col: 1 });
    }
    // Defaults per spec: cycles wcl 20 (mirrors buildDefaultProgram — wcl is
    // mouth-to-ear latency in the tens of ms, so a small scale gives seconds).
    if (!program.cycles) program.cycles = { metric: 'wcl', factor: 20, fixed: null, defaulted: true };
    // No tempo is injected: an unwritten `# tempo` leaves program.tempo null,
    // so the AST reports honestly that no tempo directive is in force. This is
    // behaviourally a no-op — beatSeconds(null) already falls back to 120 bpm,
    // which is what quantizes cycle length and what a pinned `# cycles`
    // amount lands on — but it stops the default program from carrying a
    // directive nobody wrote.
    return program;
  }

  parseDollar(program) {
    const sigil = this.next(); // '$'
    const name = this.peek();
    // `participants` is no longer reserved: the `'metaprogram editor'` directive
    // is what identifies this buffer, so the label after `$` is optional sugar.
    // `$ <0 1 2>` and `$ participants <0 1 2>` are the same statement. A word
    // that is anything else is still an error — `$` has exactly one statement.
    if (name.type === 'word') {
      if (name.value !== 'participants') {
        this.error(`unknown '$' statement '${name.value}' — '$' takes an optional 'participants' label then a sequence`, name);
        this.recover();
        return;
      }
      this.next();
    }
    if (program.participants) {
      this.error("duplicate '$' scheduling sequence", sigil);
      this.recover();
      return;
    }
    const seq = this.parseSequenceGroup();
    if (!seq) { this.recover(); return; }
    // Sequence-level postfix: *n or /n.
    this.parseModifiers(seq);
    program.participants = seq;
  }

  // <...> (alternate: one element per cycle), [...] (subdivide the cycle), or a
  // Mondo s-expression `(head …)` — mini and mondo are both accepted here, told
  // apart by the opening bracket.
  parseSequenceGroup() {
    const open = this.peek();
    if (open.type === 'punct' && open.value === '(') return this.parseMondoGroup();
    if (open.type !== 'punct' || (open.value !== '<' && open.value !== '[')) {
      this.error(`expected '<', '[' or '(' to open a sequence, got '${open.value ?? 'end of input'}'`, open);
      return null;
    }
    this.next();
    const close = open.value === '<' ? '>' : ']';
    const mode = open.value === '<' ? 'alternate' : 'subdivide';

    // stacks ← elements split on ','; each stack may be a '|' choice of runs.
    const stacks = [];
    // Where the closing bracket leaves off, so a postfix on the sequence
    // (`[0 1]*2`) is held to the same glue rule as one on an element.
    let end = null;
    let segments = [[]]; // '|'-separated runs within the current stack
    const finishStack = (tok) => {
      const runs = segments.map(run => run);
      if (runs.every(r => r.length === 0)) {
        this.error('empty sequence element list', tok);
      }
      const elements = runs.length === 1
        ? runs[0]
        : [{ type: 'choice', options: runs, line: tok.line, col: tok.col }];
      stacks.push({ elements, cycleOffset: stacks.length });
      segments = [[]];
    };

    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') {
        this.error(`unclosed sequence — expected '${close}'`, t);
        return null;
      }
      if (t.type === 'newline') { this.next(); continue; } // sequences may wrap lines
      if (t.type === 'punct' && t.value === close) {
        this.next();
        end = { line: t.line, col: t.col + 1 };
        finishStack(t);
        break;
      }
      if (t.type === 'punct' && (t.value === '>' || t.value === ']')) {
        this.error(`mismatched '${t.value}' — expected '${close}'`, t);
        this.next();
        end = { line: t.line, col: t.col + 1 };
        finishStack(t);
        break;
      }
      if (t.type === 'punct' && t.value === ',') {
        this.next();
        finishStack(t);
        continue;
      }
      if (t.type === 'punct' && t.value === '|') {
        this.next();
        segments.push([]);
        continue;
      }
      const el = this.parseElement();
      if (!el) { this.next(); continue; } // error already recorded; skip token
      const run = segments[segments.length - 1];
      // `a .. b` range over plain integer indices.
      if (this.peek().type === 'op' && this.peek().value === '..') {
        const dots = this.next();
        const hi = this.parseElement();
        if (!el.token || !hi || !hi.token || el.suffix || hi.suffix ||
            !/^\d+$/.test(el.token) || !/^\d+$/.test(hi.token)) {
          this.error("'..' ranges need plain integer participant indices on both sides", dots);
          continue;
        }
        const lo = parseInt(el.token, 10), high = parseInt(hi.token, 10);
        if (high < lo) {
          this.error("'..' range upper bound below lower bound", dots);
          continue;
        }
        // Every expanded index stands at the low bound's glyph — it is the only
        // text it has — and so spans exactly that, whatever it is called.
        for (let v = lo; v <= high; v++) {
          run.push({
            type: 'participant', token: String(v), ownerIndex: v, suffix: null, modifiers: [],
            line: el.line, col: el.col, endLine: el.endLine, endCol: el.endCol
          });
        }
        continue;
      }
      this.parseModifiers(el);
      run.push(el);
    }
    return { type: 'sequence', mode, stacks, modifiers: [], endLine: end?.line, endCol: end?.col };
  }

  // A Mondo s-expression sequence: `(head elem elem …)`. Mini and mondo are
  // both accepted for a scheduling sequence — `(cat 0 1a 2zzz)` and
  // `(fast 2 (seq 0 1))` mean exactly what `<0 1a 2zzz>` and `[0 1]*2` do.
  // The head names the combinator; without one the list subdivides, as `[…]`
  // does. Elements reuse the same participant/rest/nested-group grammar and the
  // same glued postfix modifiers as `<…>`/`[…]`, so nothing about a turn
  // changes — only the spelling of the group around it.
  parseMondoGroup() {
    const open = this.next(); // '('
    const HEADS = {
      cat: 'alternate', slowcat: 'alternate', alt: 'alternate',
      seq: 'subdivide', fastcat: 'subdivide', stepcat: 'subdivide', sub: 'subdivide',
      stack: 'stack', fast: 'fast', slow: 'slow',
    };
    let mode = 'subdivide';
    let head = null;
    const h = this.peek();
    if (h.type === 'word' && Object.prototype.hasOwnProperty.call(HEADS, h.value)) {
      head = h.value;
      this.next();
      if (HEADS[head] === 'alternate' || HEADS[head] === 'subdivide') mode = HEADS[head];
    } else if (h.type === 'word') {
      this.error(`unknown Mondo head '${h.value}' — use cat, seq, fastcat, slowcat, stack, fast or slow`, h);
      this.recover();
      return null;
    }

    // `(fast N X)` == `X*N`, `(slow N X)` == `X/N`.
    if (head === 'fast' || head === 'slow') {
      const nTok = this.peek();
      if (nTok.type !== 'number' && nTok.type !== 'intlike') {
        this.error(`'${head}' needs a number then one group: (${head} 2 (seq 0 1))`, nTok);
        this.recover();
        return null;
      }
      this.next();
      const n = parseFloat(tokenText(nTok));
      const inner = this.parseElement();
      const closeTok = this.peek();
      if (closeTok.type === 'punct' && closeTok.value === ')') this.next();
      else this.error("unclosed Mondo sequence — expected ')'", closeTok);
      if (!inner) return null;
      const seq = inner.type === 'sequence'
        ? inner
        : { type: 'sequence', mode: 'subdivide', stacks: [{ elements: [inner], cycleOffset: 0 }], modifiers: [] };
      seq.modifiers = [...(seq.modifiers || []), { op: head === 'fast' ? '*' : '/', value: n }];
      return { ...seq, line: open.line, col: open.col };
    }

    const stacks = [];
    let run = [];
    const flush = () => {
      if (head === 'stack') {
        for (const el of run) stacks.push({ elements: [el], cycleOffset: stacks.length });
      } else {
        stacks.push({ elements: run, cycleOffset: 0 });
      }
      run = [];
    };
    let close = null;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') { this.error("unclosed Mondo sequence — expected ')'", t); return null; }
      if (t.type === 'newline') { this.next(); continue; }
      if (t.type === 'punct' && t.value === ')') { close = this.next(); break; }
      const el = this.parseElement();
      if (!el) { this.next(); continue; }
      if (this.peek().type === 'op' && this.peek().value === '..') {
        const dots = this.next();
        const hi = this.parseElement();
        if (!el.token || !hi || !hi.token || el.suffix || hi.suffix ||
            !/^\d+$/.test(el.token) || !/^\d+$/.test(hi.token)) {
          this.error("'..' ranges need plain integer participant indices on both sides", dots);
          continue;
        }
        const lo = parseInt(el.token, 10), high = parseInt(hi.token, 10);
        if (high < lo) { this.error("'..' range upper bound below lower bound", dots); continue; }
        for (let v = lo; v <= high; v++) {
          run.push({ type: 'participant', token: String(v), ownerIndex: v, suffix: null, modifiers: [],
            line: el.line, col: el.col, endLine: el.endLine, endCol: el.endCol });
        }
        continue;
      }
      this.parseModifiers(el);
      run.push(el);
    }
    flush();
    if (stacks.every((s) => s.elements.length === 0)) this.error('empty Mondo sequence', open);
    return {
      type: 'sequence',
      mode: head === 'stack' ? 'alternate' : mode,
      stacks,
      modifiers: [],
      endLine: close ? close.line : open.line,
      endCol: close ? close.col + 1 : open.col + 1,
    };
  }

  parseElement() {
    const t = this.peek();
    if (t.type === 'rest') {
      this.next();
      return {
        type: 'rest', token: t.value, modifiers: [],
        line: t.line, col: t.col, endLine: t.line, endCol: t.col + 1
      };
    }
    if (t.type === 'punct' && (t.value === '<' || t.value === '[' || t.value === '(')) {
      const group = this.parseSequenceGroup();
      if (!group) return null;
      return { ...group, line: t.line, col: t.col };
    }
    if (t.type === 'index' || t.type === 'intlike') {
      this.next();
      if (!isValidParticipantToken(t.value)) {
        this.error(`invalid participant index '${t.value}' — bot suffixes are z-prefixed single letters (a, z, za, zb, …)`, t);
        return null;
      }
      const parsed = parseParticipantToken(t.value);
      return {
        type: 'participant',
        token: t.value,
        ownerIndex: parsed.ownerIndex,
        suffix: parsed.suffix,
        modifiers: [],
        line: t.line,
        col: t.col,
        endLine: t.line,
        endCol: t.col + tokenWidth(t)
      };
    }
    this.error(`unexpected '${t.value}' in sequence`, t);
    return null;
  }

  // Postfix element/sequence modifiers: *n /n @n !n %n :n ?[p]
  //
  // A modifier is written GLUED to what it modifies, with no space anywhere in
  // the run: `4@3`, `10!2`, `[0 1]*2`. A gap is a syntax error rather than the
  // same thing loosely spelled, because whitespace is the only thing separating
  // one turn from the next — `<0 @3>` LOOKS like two of them, and is far more
  // likely a slipped `<0@3>` (or a `3` that lost its token) than a deliberate
  // spelling of one weighted turn. `..` is exempt: it joins two elements into a
  // range rather than modifying one, and `0 .. 3` is how the docs write it.
  //
  // Attaches the run to `node` and extends its extent (`endLine`/`endCol`,
  // 1-based, exclusive of the last character) over it, which is what lets the
  // editor's cycle highlighter outline a slot as its author wrote it — the
  // whole of `10!2` or `4@3`, not the bare token with its operators hanging
  // outside the box. Only an ACCEPTED modifier widens the extent, so text
  // swallowed to recover from an error never ends up inside the outline. A run
  // never crosses a newline: the loop stops at one either way, so a modifier on
  // the next line is simply not this element's.
  parseModifiers(node) {
    const mods = [];
    // Where the previous token left off — the element's own extent to begin
    // with, so the first operator is measured against the token it follows.
    const own = (node.endLine != null && node.endCol != null)
      ? { line: node.endLine, col: node.endCol }
      : null;
    let end = own;      // scan position, error recovery included
    let extent = own;   // through the last accepted modifier
    // Nothing to measure against (a node with no recorded extent) reads as
    // glued: a missing position must not invent an error.
    const glued = (t) => end == null || (t.line === end.line && t.col === end.col);
    // Consume one token and carry the scan position along with it.
    const take = () => {
      const t = this.next();
      end = { line: t.line, col: t.col + tokenWidth(t) };
      return t;
    };
    // Set once a glue error has swallowed text for recovery: from there on the
    // scan position is past a gap, so nothing more may widen the extent — the
    // element still ends where it did before the mistake.
    let detached = false;
    // A modifier that survived validation: it is part of the element, so the
    // element now reaches to the end of it.
    const accept = (mod) => { mods.push(mod); if (!detached) extent = end; };
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || t.value === '..') break; // '..' is the caller's range
      if (!glued(t)) {
        this.error(
          `'${t.value}' has to be attached to what it modifies — write '0${t.value}2', not '0 ${t.value}2'`, t);
        // Swallow the operator and its operand: one stray space is one error,
        // not that plus 'unexpected @ in sequence' from the caller's loop.
        detached = true;
        take();
        const operand = this.peek();
        if (glued(operand) && (operand.type === 'number' || operand.type === 'intlike')) take();
        continue;
      }
      take();
      // `?` and `!` may stand alone (Strudel's "half the time" and "once
      // more"). Their count must be GLUED to the operator to belong to it —
      // with a gap it is the next sequence element ("4? 10", "0! 2").
      if (t.value === '?' || t.value === '!') {
        const p = this.peek();
        const bare = t.value === '?' ? { op: '?', value: null } : { op: '!', value: 2 };
        if (!glued(p) || (p.type !== 'number' && p.type !== 'intlike')) {
          accept(bare);
          continue;
        }
        take();
        const val = typeof p.value === 'number' ? p.value : parseFloat(p.value);
        if (t.value === '?') {
          if (!(val >= 0 && val <= 1)) this.error("'?' probability must be in [0, 1]", p);
          else accept({ op: '?', value: val });
        } else if (!(val > 0) || !isFinite(val)) {
          this.error("'!' needs a positive repeat count", p);
        } else {
          accept({ op: '!', value: val });
        }
        continue;
      }
      const arg = this.peek();
      if (arg.type !== 'number' && arg.type !== 'intlike') {
        this.error(`operator '${t.value}' needs a numeric argument`, t);
        continue;
      }
      if (!glued(arg)) {
        // The other half of the same rule: `0@ 3` is no more one weighted turn
        // than `0 @3` is.
        this.error(
          `'${t.value}' has to be attached to its number — write '0${t.value}2', not '0${t.value} 2'`, arg);
        detached = true;
        take();
        continue;
      }
      take();
      const val = typeof arg.value === 'number' ? arg.value : parseFloat(arg.value);
      if (!(val > 0) || !isFinite(val)) {
        this.error(`operator '${t.value}' needs a positive number`, arg);
        continue;
      }
      accept({ op: t.value, value: val });
    }
    // Merge rather than overwrite: every element/`<…>`/`[…]` arrives with
    // `modifiers: []`, so this is identical to assignment for them — but a
    // Mondo `(fast N X)` / `(slow N X)` group arrives already carrying the
    // `*N` / `/N` it desugars to, and that must survive a trailing-operator
    // scan that finds nothing.
    node.modifiers = [...(node.modifiers || []), ...mods];
    if (extent) { node.endLine = extent.line; node.endCol = extent.col; }
    return node.modifiers;
  }

  parseDirective(program) {
    const sigil = this.next(); // '#'
    const nameTok = this.peek();
    if (nameTok.type !== 'word') {
      this.error("expected a directive name after '#'", nameTok);
      this.recover();
      return;
    }
    this.next();
    const name = nameTok.value;

    if (name === 'cycles') { this.parseCycles(program, nameTok); return; }
    if (name === 'tempo') { this.parseTempo(program, nameTok); return; }
    if (name === 'ring') { this.parseRing(program, nameTok); return; }
    if (name === 'breakout') { this.parseBreakout(program, nameTok); return; }
    if (name === 'assign') { this.parseAssign(program, nameTok); return; }

    if (PATTERN_FNS[name]) { this.parseChainFn(program, name, nameTok, PATTERN_FNS[name]); return; }
    if (EFFECTS[name]) {
      const sig = EFFECTS[name];
      if (sig.grammar === 'noise') this.parseNoise(program, nameTok, sig);
      else if (sig.metricPairs) this.parseMetricPairFn(program, name, nameTok, sig);
      else this.parseChainFn(program, name, nameTok, sig);
      return;
    }

    this.error(`'${name}' is not a JPattern function — Strudel and Hydra functions cannot be executed in the JPattern editor`, nameTok);
    this.recover();
  }

  // `# cycles "<metric>" [scale factor] [amount]` — target = scale × metric.
  // With no amount the metric evolves with the live worst-case measurement;
  // an amount PINS it there regardless of network conditions (seconds for
  // wcl, loss fraction for wcpl), pinning timing only — measured metrics
  // still drive effects and readouts. `# cycles "wcl" 10 0.3` = 3 s.
  parseCycles(program, nameTok) {
    const metricTok = this.peek();
    if (this.rejectBareMetric(metricTok)) { this.recover(); return; }
    if (!isMetricKeywordToken(metricTok) || !TIMING_METRICS.includes(metricTok.value)) {
      this.error(`cycles needs a quoted timing metric ("${TIMING_METRICS.join('" | "')}")`, metricTok);
      this.recover();
      return;
    }
    this.next();
    if (this.peek().type === 'op' && this.peek().value === '*') {
      this.error(`the cycles scale factor is positional now — write '# cycles "${metricTok.value}" 3', not '"${metricTok.value}"*3'`, this.peek());
      this.recover();
      return;
    }
    let factor = 1;
    let fixed = null;
    for (const slot of ['scale factor', 'fixed amount']) {
      const t = this.peek();
      if (t.type !== 'number' && t.type !== 'intlike') break;
      this.next();
      const val = t.type === 'number' ? t.value : parseFloat(t.value);
      if (!(val > 0) || !isFinite(val)) {
        this.error(`cycles ${slot} must be a positive real number`, t);
      } else if (slot === 'scale factor') {
        factor = val;
      } else {
        fixed = val;
      }
    }
    if (!this.atStatementEnd()) {
      const trailing = this.peek();
      // A data reference is accepted exactly where a `<…>` pattern is, and the
      // cycles scale/amount are read once per program rather than per cycle —
      // so say that, instead of reporting it as a stray argument.
      if (trailing.type === 'dataref') {
        this.error(`'# cycles' takes fixed numbers, so it cannot read '${tokenText(trailing)}' —`
          + ' a data reference belongs in an effect argument (# crush / # echo / # room / # noise)', trailing);
      } else {
        this.error(`cycles got an unexpected argument '${tokenText(trailing)}' — the syntax is '# cycles <metric> [scale factor] [amount]'`, trailing);
      }
      this.recover();
      return;
    }
    if (program.cycles) {
      // "Overarching cyclic timing modes cannot be chained together."
      this.error('cyclic timing modes cannot be chained — exactly one # cycles directive is allowed', nameTok);
      return;
    }
    program.cycles = { metric: metricTok.value, factor, fixed };
  }

  parseTempo(program, nameTok) {
    // quantity: number | int | int/int (e.g. 90/4)
    const q = this.peek();
    let value = null;
    if (q.type === 'number' || q.type === 'intlike') {
      this.next();
      value = typeof q.value === 'number' ? q.value : parseFloat(q.value);
      if (this.peek().type === 'op' && this.peek().value === '/') {
        this.next();
        const d = this.peek();
        const den = d.type === 'number' ? d.value : (d.type === 'intlike' ? parseFloat(d.value) : NaN);
        if (!(den > 0) || !isFinite(den)) {
          this.error('tempo fraction denominator must be a positive real number', d);
          value = null;
        } else {
          value = value / den;
        }
        this.next();
      }
    }
    if (value == null || !(value > 0) || !isFinite(value)) {
      this.error('tempo needs a positive quantity', q);
      this.recover();
      return;
    }
    const unitTok = this.peek();
    if (unitTok.type !== 'word' || !TEMPO_UNITS.includes(unitTok.value)) {
      this.error(`tempo needs a unit (${TEMPO_UNITS.join('|')})`, unitTok);
      this.recover();
      return;
    }
    this.next();
    if (program.tempo) {
      this.error('duplicate # tempo directive', nameTok);
      return;
    }
    program.tempo = { value, unit: unitTok.value };
  }

  // `# ring <mode> [w <token> <weight> …]`
  parseRing(program, nameTok) {
    if (program.ring) {
      this.error('duplicate # ring directive', nameTok);
      this.recover();
      return;
    }
    const modeTok = this.peek();
    if (modeTok.type !== 'word' || !RING_MODES.includes(modeTok.value)) {
      this.error(`ring needs a mode (${RING_MODES.join('|')})`, modeTok);
      this.recover();
      return;
    }
    this.next();
    const ring = { mode: modeTok.value, weights: {} };

    // optional weight pairs: `w <token> <weight> <token> <weight> …`
    if (this.peek().type === 'word' && this.peek().value === 'w') {
      if (ring.mode !== 'hash') {
        this.error("weights only apply to '# ring hash'", this.peek());
        this.recover();
        return;
      }
      this.next();
      let pairs = 0;
      while (!this.atStatementEnd()) {
        const tokenTok = this.peek();
        if (tokenTok.type !== 'intlike' && tokenTok.type !== 'word' && tokenTok.type !== 'number') {
          this.error("ring weight expects '<token> <weight>' pairs", tokenTok);
          this.recover();
          return;
        }
        this.next();
        const weightTok = this.peek();
        const weight = weightTok.type === 'number' ? weightTok.value
          : (weightTok.type === 'intlike' ? parseFloat(weightTok.value) : NaN);
        if (!(weight > 0) || !isFinite(weight)) {
          this.error("ring weight must be a positive number", weightTok);
          this.recover();
          return;
        }
        this.next();
        ring.weights[tokenText(tokenTok)] = weight;
        pairs++;
      }
      if (!pairs) {
        this.error("'w' must be followed by at least one '<token> <weight>' pair", nameTok);
        return;
      }
    }

    if (!this.atStatementEnd()) {
      this.error(`ring got an unexpected argument '${tokenText(this.peek())}' — the syntax is '# ring <mode> [w <token> <weight> …]'`, this.peek());
      this.recover();
      return;
    }
    program.ring = ring;
  }

  // `# breakout '{"name":"Room A","participants":["0","1"]}'` — declares or
  // redeclares one breakout room. The argument is single-quoted, not the
  // double-quoted string every other directive's metric/medium keywords use
  // — see the tokenizer's `'` branch for why (a JSON blob's own quotes would
  // terminate a double-quoted token at the first one). Repeatable: several
  // `# breakout` lines declare several rooms, folded in source order by
  // breakout-core.js's resolveBreakoutState (the actual room-creation and
  // participant-moving side effects live in src/audio-net/Breakout.js).
  parseBreakout(program, nameTok) {
    const litTok = this.peek();
    if (litTok.type !== 'string') {
      this.error('breakout needs a single-quoted JSON object — the syntax is ' +
        `# breakout '{"name":"Room A","participants":["0","1"]}'`, litTok);
      this.recover();
      return;
    }
    this.next();
    let spec;
    try {
      spec = parseBreakoutLiteral(litTok.value);
    } catch (e) {
      this.error(e.message, litTok);
      this.recover();
      return;
    }
    if (!this.atStatementEnd()) {
      this.error(`breakout takes exactly one argument — the syntax is # breakout '{"name":"Room A"}'`, this.peek());
      this.recover();
      return;
    }
    program.breakouts.push(spec);
  }

  // `# assign "<participant token>" "<room name>"` — moves one participant
  // into a breakout room, or back to breakout-core.js's reserved "main" room.
  // Repeatable and order-sensitive: the last # assign for a given token wins
  // (resolveBreakoutState), the same "read top-to-bottom as current desired
  // state" rule # ring's weights and the participants sequence already follow.
  parseAssign(program, nameTok) {
    const tokenTok = this.peek();
    if (tokenTok.type !== 'string' || !tokenTok.value.trim()) {
      this.error('assign needs a quoted participant token — the syntax is # assign "0" "Room A"', tokenTok);
      this.recover();
      return;
    }
    this.next();
    const roomTok = this.peek();
    if (roomTok.type !== 'string' || !roomTok.value.trim()) {
      this.error('assign needs a quoted room name after the participant token — the syntax is # assign "0" "Room A"', roomTok);
      this.recover();
      return;
    }
    this.next();
    if (!this.atStatementEnd()) {
      this.error(`assign takes exactly two arguments — the syntax is # assign "<token>" "<room>"`, this.peek());
      this.recover();
      return;
    }
    program.assignments.push({ token: tokenTok.value.trim(), room: roomTok.value.trim() });
  }

  // A `<…>` / `[…]` argument to a `#` effect: mini notation over VALUES
  // (numbers or metric words) rather than over participants, so it needs its
  // own reader — parseSequenceGroup's elements are participant indices.
  //
  // `kind` is 'metric', 'number', or 'any' where the slot is positional and
  // could be either (`# noise <wcl wcpl> <20 5>`); 'any' infers it from the
  // leaves and refuses a pattern that mixes the two. `alternationOnly` rejects
  // `[…]` and any rate above 1: an effect re-derived once per cycle boundary
  // has nowhere to put a sub-cycle step, so it is an error rather than quietly
  // aliasing to something the performer did not write. Nesting otherwise mixes
  // modes and rates freely.
  //
  // A `~` leaf is a REST — no value for that span. It parses to null, which
  // ValuePattern.js reads back unchanged and each effect's params function
  // already treats as "use the default", so a rest leaves the parameter alone
  // for as long as it is in force. Rests settle nothing about the leaf kind:
  // `<wcl ~ wcpl>` is still a pattern of metrics.
  parseValueSequence(name, kind, sig, { alternationOnly = false, topLevel = true } = {}) {
    const open = this.next(); // '<' or '['
    const close = open.value === '<' ? '>' : ']';
    const mode = open.value === '<' ? 'alternate' : 'subdivide';
    const terms = [];
    // Parallel to `terms`, and left sparse: a pattern nobody weighted, dropped
    // or rated keeps the node shape it has always had.
    const weights = [];
    const chances = [];
    const rates = [];
    if (alternationOnly && open.value === '[') {
      this.error(`'${name}' arguments are sampled once per cycle — use '<…>' alternation, not '[…]'`, open);
      return null;
    }
    // For kind 'any', the first leaf settles what the rest must be.
    let leafKind = kind === 'any' ? null : kind;
    const settleKind = (k, tok) => {
      if (leafKind && leafKind !== k) {
        this.error(`'${name}' pattern arguments cannot mix metric keywords with numbers`, tok);
        return false;
      }
      leafKind = k;
      return true;
    };

    for (;;) {
      const t = this.peek();
      // A directive is one line: an unclosed pattern ends at the line break
      // rather than swallowing the statements below it.
      if (t.type === 'eof' || t.type === 'sigil') {
        this.error(`unclosed pattern argument to '${name}' — expected '${close}'`, t);
        return null;
      }
      if (t.type === 'newline') { this.next(); continue; } // may wrap lines
      if (t.type === 'punct' && t.value === close) { this.next(); break; }
      if (t.type === 'punct' && (t.value === '>' || t.value === ']')) {
        this.error(`mismatched '${t.value}' — expected '${close}'`, t);
        this.next();
        break;
      }
      if (kind === 'media' && t.type === 'punct' && t.value === '[') {
        // In a MEDIA pattern `[…]` is a SET, not a subdivision — the elements
        // of `<["audio" "video"] "css">` are sets. Subdividing has nothing to
        // offer here anyway: an effect is either acting on a medium for the
        // span or it is not, so splitting that span would only mean switching
        // media faster, which the alternation already expresses.
        const set = this.parseMediaSet(name);
        if (!set) return null;
        terms.push(set);
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      if (kind === 'media' && t.type === 'string') {
        // A bare name is the one-element set: brackets are what a set of
        // several needs, not what makes something a set.
        this.next();
        if (!isMedium(t.value)) {
          this.error(`'${t.value}' is not a medium (${MEDIA.join('|')})`, t);
          terms.push(null); // keep the parallel arrays aligned — see below
        } else {
          terms.push(normalizeMediaSet([t.value]));
        }
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      if (t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        // The nested call consumes its own trailing RATE (`<a [b c]*2>`) but
        // leaves `@` and `?` for us: those weigh and drop the group as an
        // element of THIS sequence, so they belong in our parallel arrays.
        const inner = this.parseValueSequence(name, kind, sig, { alternationOnly, topLevel: false });
        if (!inner) return null;
        const innerKind = valuePatternKind(inner);
        if (innerKind && !settleKind(innerKind, t)) return null;
        terms.push(inner);
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      if (t.type === 'rest') {
        this.next();
        terms.push(null);
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      // A bare metric word inside a pattern (`<wcl wcpl>`) — the same "quote
      // it" error as a bare one anywhere else, then stand a rest in its place
      // so the parallel arrays stay aligned.
      if ((kind === 'metric' || kind === 'any') && this.rejectBareMetric(t)) {
        this.next();
        terms.push(null);
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      // A metric leaf is a quoted `"wcl"` (never bare). For a 'metric'-kind
      // sequence any quoted string is taken as an attempted metric so the "not
      // a metric" error can name it; in an 'any' sequence only a real keyword
      // is — a stray string there may still be a medium the branch below claims.
      const metricLeaf = t.type === 'string' &&
        (kind === 'metric' || sig.metricKeywords.includes(t.value));
      if ((kind === 'metric' || kind === 'any') && metricLeaf) {
        if (!settleKind('metric', t)) return null;
        if (!sig.metricKeywords.includes(t.value)) {
          this.error(`'${t.value}' is not a metric '${name}' can read (${sig.metricKeywords.join('|')})`, t);
          // Stand a rest in its place so the parallel weight/chance arrays stay
          // aligned with `terms`. The program is already invalid, so nothing
          // downstream reads this — but a misaligned array would make the
          // errors that follow describe the wrong element.
          terms.push(null);
        } else {
          terms.push(t.value);
        }
        this.next();
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      if ((kind === 'number' || kind === 'any') && (t.type === 'number' || t.type === 'intlike')) {
        if (!settleKind('number', t)) return null;
        const val = this.readPositiveNumber(name, 'arguments');
        if (val == null) return null;
        terms.push(val);
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      if ((kind === 'number' || kind === 'any') && t.type === 'dataref') {
        if (!settleKind('number', t)) return null;
        this.next();
        terms.push({ type: 'dataRef', name: t.value.name, index: t.value.index });
        this.parseValueElementModifiers(name, terms.length - 1, terms, weights, chances, rates);
        continue;
      }
      if (t.type === 'op') {
        // `@` and `?` are consumed by parseValueElementModifiers as part of
        // the element they follow, and a group eats its own rate, so anything
        // reaching here has no element to attach to (a leading `<*2 …>`) or is
        // an operator a value cannot carry. Name it rather than letting the
        // leaf error blame it for not being a number, and swallow its operand
        // too so the count is not then read as another element.
        this.error(
          `'${name}' pattern elements take '@' (weight) and '?' (chance); ` +
          `'${t.value}' is not one of them — '*' and '/' set the rate of a whole <…> or […] group`, t);
        this.next();
        const operand = this.peek();
        if (operand.type === 'number' || operand.type === 'intlike') this.next();
        continue;
      }
      this.error(
        kind === 'media'
          ? `'${name}' medium pattern expects quoted medium names or sets of them ` +
            `(${MEDIA.join('|')}), got '${t.value}'`
          : leafKind === 'metric'
            ? `'${name}' pattern expects quoted metric names ("${(sig.metricKeywords || EFFECT_METRICS).join('" | "')}"), got '${t.value}'`
            : `'${name}' pattern expects positive numbers, got '${t.value}'`,
        t
      );
      this.next();
    }

    if (!terms.length) {
      this.error(`empty pattern argument to '${name}'`, open);
      return null;
    }
    const speed = this.parseValueRate(name);
    // Nested, an element modifier here belongs to the PARENT — this group is
    // one of its elements — so leave it. (`*` and `/` never reach this point:
    // parseValueRate above has already taken them as this sequence's own rate.)
    // At the top level there is no parent to attach to, and saying so beats the
    // generic trailing-argument error.
    const after = this.peek();
    if (after.type === 'op') {
      const elementModifier = VALUE_ELEMENT_OPS.has(after.value);
      if (!topLevel && elementModifier) return this.finishValueSequence(
        { mode, terms, weights, chances, rates, speed, open, name, alternationOnly });
      this.error(elementModifier
        ? `'${after.value}' modifies one ELEMENT of a pattern — write it inside the '${mode === 'alternate' ? '<…>' : '[…]'}', not after it`
        : `'${name}' pattern arguments take only the '*' and '/' rate operators, not '${after.value}'`, after);
      this.recover();
      return null;
    }
    return this.finishValueSequence({ mode, terms, weights, chances, rates, speed, open, name, alternationOnly });
  }

  // Assemble the node, dropping the parallel arrays and the rate when nothing
  // wrote them — an unmodified pattern keeps the shape it has always had
  // rather than growing fields that always read 1 and null.
  finishValueSequence({ mode, terms, weights, chances, rates, speed, open, name, alternationOnly }) {
    if (alternationOnly && speed > 1) {
      this.error(`'${name}' arguments are sampled once per cycle — a rate above 1 ` +
        'steps within a cycle, which has nowhere to land here', open);
      return null;
    }
    const node = { type: 'valueSeq', mode, terms, line: open.line, col: open.col };
    if (speed !== 1) node.speed = speed;
    if (weights.some(weight => weight != null)) node.weights = Array.from(terms, (_, i) => weights[i] ?? 1);
    if (chances.some(chance => chance != null)) node.chances = Array.from(terms, (_, i) => chances[i] ?? null);
    if (rates.some(rate => rate != null)) node.rates = Array.from(terms, (_, i) => rates[i] ?? 1);
    return node;
  }

  // Every element-level modifier a value pattern takes, after one element:
  //
  //   `@n`   how much of the sequence the element takes
  //   `?[p]` dropped with probability p, reading as a rest
  //   `!n`   taken n times in a row, as n independent elements
  //   `*n` `/n`  the rate the element's OWN content is read at
  //
  // The same four are element-level in the `$ participants` grammar. `*n` and
  // `/n` are the one spelling that is both: written after a whole `<…>` /
  // `[…]` they set that sequence's rate, and a nested group has already eaten
  // its own by the time we get here — so a rate reaching this point belongs to
  // the element it follows.
  //
  // Fills the caller's parallel arrays in place and expands `!` into repeated
  // terms; errors are recorded, never thrown.
  parseValueElementModifiers(name, index, terms, weights, chances, rates) {
    let repeats = 1;
    let rate = 1;
    for (;;) {
      const op = this.peek();
      if (op.type !== 'op' || !VALUE_ELEMENT_OPS.has(op.value)) break;
      this.next();
      const countTok = this.peek();
      // The count must be GLUED to the operator to belong to it — with a gap
      // it is the next element of the sequence (`<1? 2>` is a maybe-1 followed
      // by 2, `<1! 2>` a doubled 1 followed by 2), as in a participants
      // sequence. `@` demands the same here, where parseModifiers lets it take
      // the next numeric token whatever the gap: the elements of a value
      // pattern are usually bare numbers, so a stray space in `<1@ 2>` would
      // quietly eat the 2 as a weight and leave a one-element pattern that
      // still parses.
      const glued = (countTok.type === 'number' || countTok.type === 'intlike')
        && countTok.line === op.line && countTok.col === op.col + 1;
      const count = glued
        ? (typeof countTok.value === 'number' ? countTok.value : parseFloat(countTok.value))
        : NaN;
      if (glued) this.next(); // the count belongs to the operator

      if (op.value === '?') {
        if (glued && !(count >= 0 && count <= 1)) this.error(`'${name}' pattern '?' probability must be in [0, 1]`, countTok);
        else if (chances[index] != null) this.error(`'${name}' pattern element already has a '?' chance`, op);
        else chances[index] = glued ? count : DEFAULT_DROP_CHANCE;
        continue;
      }
      if (op.value === '!') {
        // Bare `!` is "once more", i.e. `!2`.
        const wanted = glued ? count : 2;
        if (!(wanted >= 1) || !isFinite(wanted)) {
          this.error(`'${name}' pattern '!' needs a repeat count of 1 or more`, glued ? countTok : op);
        } else if (wanted > MAX_VALUE_REPEATS) {
          this.error(`'${name}' pattern '!' repeats at most ${MAX_VALUE_REPEATS} times`, glued ? countTok : op);
        } else if (repeats !== 1) {
          this.error(`'${name}' pattern element already has a '!' repeat count`, op);
        } else {
          repeats = Math.round(wanted);
        }
        continue;
      }
      if (op.value === '*' || op.value === '/') {
        if (!glued) {
          this.error(`'${name}' pattern '${op.value}' needs a positive rate written against it, as in '2${op.value}3'`, op);
          continue;
        }
        if (!(count > 0) || !isFinite(count)) this.error(`'${name}' pattern '${op.value}' needs a positive rate`, countTok);
        else rate = op.value === '*' ? rate * count : rate / count;
        continue;
      }
      if (!glued) {
        this.error(`'${name}' pattern '@' needs a positive weight written against it, as in '2@3'`, op);
        continue;
      }
      if (!(count > 0) || !isFinite(count)) this.error(`'${name}' pattern '@' needs a positive weight`, countTok);
      else if (weights[index] != null) this.error(`'${name}' pattern element already has an '@' weight`, op);
      else weights[index] = count;
    }

    if (rate !== 1) rates[index] = rate;
    // `!` replicates the element into that many INDEPENDENT ones, each keeping
    // its weight, chance and rate — so a `?` on a replicated element draws once
    // per copy rather than once for all of them, which is what the scheduler
    // does with `entry.replica`. Expanding here rather than at read time keeps
    // the node a plain list of terms for everything downstream.
    for (let copy = 1; copy < repeats; copy++) {
      terms.push(terms[index]);
      weights[terms.length - 1] = weights[index];
      chances[terms.length - 1] = chances[index];
      rates[terms.length - 1] = rates[index];
    }
  }

  // Trailing `*n` / `/n` on a value sequence: the rate the argument is read
  // at, in the sequence's own units. `*2` fits both elements of a `<a b>` into
  // one cycle, `/2` holds each for two. They compose the way they do on a
  // `$ participants` sequence, so `*4/2` is ×2. Returns the folded multiplier
  // (1 when nothing was written); errors are recorded, never thrown.
  parseValueRate(name) {
    let speed = 1;
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || (t.value !== '*' && t.value !== '/')) return speed;
      this.next();
      const arg = this.peek();
      if (arg.type !== 'number' && arg.type !== 'intlike') {
        this.error(`'${name}' pattern rate '${t.value}' needs a positive number`, t);
        return speed;
      }
      this.next();
      const val = typeof arg.value === 'number' ? arg.value : parseFloat(arg.value);
      if (!(val > 0) || !isFinite(val)) {
        this.error(`'${name}' pattern rate '${t.value}' needs a positive number`, arg);
        continue;
      }
      speed = t.value === '*' ? speed * val : speed / val;
    }
  }

  atStatementEnd() {
    const t = this.peek();
    return t.type === 'newline' || t.type === 'eof' || t.type === 'sigil';
  }

  // Consume a balanced `(…)` run. A rejected Strudel call is skipped whole
  // because its innards are not this language's tokens — in particular a '#'
  // inside it is a statement sigil to the tokenizer, and leaving it for
  // recover() turns one honest error into two.
  skipParenBlob() {
    let depth = 0;
    while (!this.atEof()) {
      const p = this.next();
      if (p.type === 'punct' && p.value === '(') depth++;
      if (p.type === 'punct' && p.value === ')') { depth--; if (depth === 0) return; }
    }
  }

  // One <metric> <scale> pair per parameter, then an optional upper bound per
  // parameter in the same order:
  //
  //   # echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200
  //          |----| |------| |----| |---------|
  //          length  feedbk   gain    bounds
  //
  // All the pairs or none — a half-written chain (`# echo wcl 2`) is far more
  // likely a mistake than an intention, and silently defaulting the rest would
  // hide it. Bounds are individually optional, filling their slots left to
  // right; each omitted one falls back to that metric's default.
  parseMetricPairFn(program, name, nameTok, sig) {
    const slots = sig.metricPairs;
    const pairs = [];
    const bounds = [];
    let media = null;

    // A bare `# echo ["audio"]` is the defaulted effect narrowed to one
    // medium, so a leading medium set is not the start of the pair list.
    if (!this.atStatementEnd() && !(sig.mediaArg && this.atMediaArg())) {
      for (let i = 0; i < slots.length; i++) {
        const t = this.peek();
        if (this.rejectBareMetric(t)) { this.recover(); return; }
        if (!isMetricKeywordToken(t) || !sig.metricKeywords.includes(t.value)) {
          this.error(
            `'${name}' needs a quoted metric keyword ("${sig.metricKeywords.join('" | "')}") before its ${slots[i]} ` +
            `— the syntax is '${sig.usage}'`, t);
          this.recover();
          return;
        }
        this.next();
        const value = this.parseNumericArg(name, `${slots[i]} scale factor`, sig);
        if (value == null) { this.recover(); return; }
        pairs.push({ metric: t.value, value });
      }
      for (let i = 0; i < slots.length && !this.atStatementEnd(); i++) {
        // The bounds are the last numeric slots, so a medium set is what ends
        // the list early — `# echo … 1500 ["audio"]` bounds only the length.
        if (sig.mediaArg && this.atMediaArg()) break;
        const value = this.parseNumericArg(name, `${slots[i]} upper bound`, sig);
        if (value == null) { this.recover(); return; }
        bounds.push(value);
      }
    }

    if (sig.mediaArg && this.atMediaArg()) {
      media = this.parseMediaArg(name, sig);
      if (!media) { this.recover(); return; }
    }

    if (!this.atStatementEnd()) {
      const trailing = this.peek();
      this.error(`'${name}' got an unexpected argument '${tokenText(trailing)}' — the syntax is '${sig.usage}'`, trailing);
      this.recover();
      return;
    }
    const entry = { fn: name, args: [], pairs, bounds, line: nameTok.line, col: nameTok.col };
    if (media) entry.media = media;
    program.chain.push(entry);
  }

  // A positive number, plain or as the fraction `1/2` — the spelling
  // `# tempo 90/4` already uses, and the natural one for an echo length said
  // in rational cycles. Consumes the tokens; returns null once an error has
  // been recorded.
  readPositiveNumber(name, slot) {
    const t = this.next();
    let val = typeof t.value === 'number' ? t.value : parseFloat(t.value);
    if (this.peek().type === 'op' && this.peek().value === '/') {
      this.next();
      const d = this.peek();
      const den = (d.type === 'number' || d.type === 'intlike')
        ? (typeof d.value === 'number' ? d.value : parseFloat(d.value)) : NaN;
      if (!(den > 0) || !isFinite(den)) {
        this.error(`'${name}' ${slot} fraction denominator must be a positive real number`, d);
        return null;
      }
      this.next();
      val = val / den;
    }
    if (!(val > 0) || !isFinite(val)) {
      this.error(`'${name}' ${slot} must be a positive real number`, t);
      return null;
    }
    return val;
  }

  // The offset of the first token at or after `offset` that is not a line
  // break. Patterns may wrap lines, so a lookahead has to step over newlines
  // the way parseValueSequence does.
  nextMeaningful(offset) {
    let i = offset;
    while (this.peek(i) && this.peek(i).type === 'newline') i++;
    return i;
  }

  // Whether what follows opens the trailing MEDIUM argument rather than
  // another numeric one. Both are written with the same brackets, so the LEAF
  // settles it: a quoted MEDIUM NAME (`"audio"`) can only be a medium, and a
  // number can never be one. A quoted metric (`"wcl"`) is a string leaf too
  // now, so the test is isMedium(), not "is a string" — media and metric
  // names are disjoint. That is what keeps `# crush <"wcl" "wcpl"> <2 4>`
  // (patterned metric) and `# echo … [1 4] ["audio"]` (numeric bound then a
  // medium set) reading unambiguously.
  atMediaArg() {
    const t = this.peek();
    if (t.type !== 'punct' || (t.value !== '[' && t.value !== '<')) return false;
    let i = this.nextMeaningful(1);
    // `<["audio" "video"] …>`: step over the opening bracket of the first set
    // to reach the name inside it.
    const inner = this.peek(i);
    if (t.value === '<' && inner && inner.type === 'punct' && inner.value === '[') {
      i = this.nextMeaningful(i + 1);
    }
    const leaf = this.peek(i);
    return !!leaf && leaf.type === 'string' && isMedium(leaf.value);
  }

  // `["audio" "video"]` — one set of media, space-separated. A comma is
  // refused by name rather than as a generic unexpected token: it is the one
  // separator a performer arriving from JSON would reach for, and the error
  // has to teach the convention rather than just reject the character.
  parseMediaSet(name) {
    const open = this.next(); // '['
    const names = [];
    for (;;) {
      const t = this.peek();
      // A directive is one line: an unclosed set ends here rather than
      // swallowing the statements below it.
      if (t.type === 'eof' || t.type === 'sigil') {
        this.error(`unclosed medium set on '${name}' — expected ']'`, t);
        return null;
      }
      if (t.type === 'newline') { this.next(); continue; }
      if (t.type === 'punct' && t.value === ']') { this.next(); break; }
      if (t.type === 'punct' && t.value === ',') {
        this.error(`'${name}' medium names are separated by spaces, not commas — ` +
          `write ["audio" "video"]`, t);
        this.next();
        continue;
      }
      if (t.type === 'string') {
        this.next();
        if (!isMedium(t.value)) {
          this.error(`'${t.value}' is not a medium (${MEDIA.join('|')})`, t);
        } else if (names.includes(t.value)) {
          this.error(`'${name}' already names the medium '${t.value}'`, t);
        } else {
          names.push(t.value);
        }
        continue;
      }
      this.error(`'${name}' medium sets hold quoted medium names (${MEDIA.join('|')}), got '${t.value}'`, t);
      this.next();
    }
    if (!names.length) {
      this.error(`'${name}' names no medium — an effect that acts on nothing does nothing, ` +
        'so delete the directive rather than emptying its medium set', open);
      return null;
    }
    return normalizeMediaSet(names);
  }

  // The trailing medium argument: one set, or a `<…>` alternation of sets read
  // per cycle exactly as every other patterned argument is.
  parseMediaArg(name, sig) {
    if (this.peek().value === '[') return this.parseMediaSet(name);
    return this.parseValueSequence(name, 'media', sig);
  }

  // A positive number — plain or fractional — or, where the signature allows
  // it, a pattern of them. Returns null once an error has been recorded.
  parseNumericArg(name, slot, sig) {
    const t = this.peek();
    if (t.type === 'number' || t.type === 'intlike') return this.readPositiveNumber(name, slot);
    // `# cycles Weather:3` — the column supplies the number, sampled against
    // the room's cycle grid like any other patterned argument.
    if (t.type === 'dataref') {
      this.next();
      return { type: 'dataRef', name: t.value.name, index: t.value.index };
    }
    if (sig.patternArgs && t.type === 'punct' && (t.value === '<' || t.value === '[')) {
      // One pattern reader for every `#` argument, whatever the effect: the
      // node it returns is what ValuePattern.js samples at the cycle position.
      return this.parseValueSequence(name, 'number', sig);
    }
    if (t.type === 'punct' && t.value === '(') {
      this.error(`'${name}' cannot take Strudel-call arguments — ${slot} is a number or a pattern of numbers`, t);
      // Consume the parenthesized blob rather than leaving it for recover():
      // a Strudel call may contain a '#' (`(pink # range 0 1)`), which
      // tokenizes as a statement sigil and would otherwise be picked up as a
      // second, bogus "not a JPattern function" error.
      this.skipParenBlob();
      return null;
    }
    this.error(
      `'${name}' needs a ${slot} — a positive number` +
      (sig.patternArgs ? ' or a pattern like <2 3> / [1 4]' : ''), t);
    return null;
  }

  // `# noise [<metric>] [<spectrum factor>] [<metric>] [<volume factor>]
  //          [<amount for metric 1>] [<amount for metric 2>]`
  //
  // Positional, with the two metric keywords optional and interleaved: a
  // keyword binds to the factor that FOLLOWS it, so `# noise wcl 20 wcrtt 10`
  // reads "spectrum from wcl × 20, volume from wcrtt × 10". The numbers fill
  // the spectrum factor, the volume factor, then the two pinned amounts — in
  // the order the metrics were written. Any slot may instead be a `<…>`
  // pattern, sampled one element per cycle.
  parseNoise(program, nameTok, sig) {
    const metrics = [null, null]; // spectrum, volume: keyword, pattern, or unwritten
    const args = [];              // spectrum factor, volume factor, amount 1, amount 2
    let media = null;
    for (;;) {
      const t = this.peek();
      // Before the pattern branch, for the same reason as in parseChainFn: the
      // brackets are shared and only the leaf tells the two apart.
      if (sig.mediaArg && this.atMediaArg()) {
        if (media) {
          this.error("'noise' already has a medium set", t);
          this.recover();
          return;
        }
        media = this.parseMediaArg('noise', sig);
        if (!media) { this.recover(); return; }
        continue;
      }
      // As in parseChainFn: the set names the media of the whole directive, so
      // nothing may follow it.
      if (media && !this.atStatementEnd()) {
        this.error("'noise' takes its medium set last — move it to the end of the directive", t);
        this.recover();
        return;
      }
      if (t.type === 'punct' && t.value === '(') {
        this.error("'noise' takes patterns as '<…>', not parenthesized expressions", t);
        this.recover();
        return;
      }
      if (t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        const node = this.parseValueSequence('noise', 'any', sig, { alternationOnly: true });
        if (!node) { this.recover(); return; }
        if (valuePatternKind(node) === 'metric') {
          if (!this.bindNoiseMetric(metrics, args.length, node, t)) return;
        } else {
          args.push(node);
        }
        continue;
      }
      if (this.rejectBareMetric(t)) { this.recover(); return; }
      if (isMetricKeywordToken(t) && EFFECT_METRICS.includes(t.value)) {
        this.next();
        if (!this.bindNoiseMetric(metrics, args.length, t.value, t)) return;
        continue;
      }
      if (t.type === 'number' || t.type === 'intlike') {
        this.next();
        const val = typeof t.value === 'number' ? t.value : parseFloat(t.value);
        if (!(val > 0) || !isFinite(val)) {
          this.error("'noise' arguments must be positive real numbers", t);
        }
        args.push(val);
        continue;
      }
      break;
    }

    const trailing = this.peek();
    if (trailing.type !== 'newline' && trailing.type !== 'eof' && trailing.type !== 'sigil') {
      this.error(`'noise' got an unexpected argument '${tokenText(trailing)}' — the syntax is ` +
        "'# noise [<metric>] [spectrum factor] [<metric>] [volume factor] [amount] [amount]'", trailing);
      this.recover();
      return;
    }
    if (args.length > 4) {
      this.error(`'noise' takes at most 4 numeric arguments (two factors then two pinned amounts), got ${args.length}`, nameTok);
      return;
    }
    const entry = { fn: 'noise', args, metrics, line: nameTok.line, col: nameTok.col };
    if (media) entry.media = media;
    program.chain.push(entry);
  }

  // A metric keyword binds to the factor that follows it, so it is legal only
  // ahead of the spectrum or volume factor — never ahead of the pinned
  // amounts, which belong to the two metrics already named.
  bindNoiseMetric(metrics, slot, value, tok) {
    if (slot > 1) {
      this.error("'noise' metric keywords go before the spectrum and volume factors — " +
        'the 5th and 6th arguments are amounts pinning those same two metrics', tok);
      this.recover();
      return false;
    }
    if (metrics[slot] != null) {
      this.error(`'noise' already has a metric for its ${slot === 0 ? 'spectrum' : 'volume'} argument`, tok);
      this.recover();
      return false;
    }
    metrics[slot] = value;
    return true;
  }

  parseChainFn(program, name, nameTok, sig) {
    // Metric-keyed effects name their driving metric before the numbers:
    // `# room "wcl" 2 0.4`. The quoted keyword is required — a bare `wcl` or a
    // bare-number form is a parse error.
    let metric = null;
    if (sig.metricKeywords) {
      const t = this.peek();
      if (this.rejectBareMetric(t)) { this.recover(); return; }
      if (isMetricKeywordToken(t) && sig.metricKeywords.includes(t.value)) {
        metric = t.value;
        this.next();
      } else if (sig.patternArgs && t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        metric = this.parseValueSequence(name, 'metric', sig);
        if (!metric) { this.recover(); return; }
      } else {
        this.error(`'${name}' needs a quoted metric keyword ("${sig.metricKeywords.join('" | "')}") before its arguments`, t);
        this.recover();
        return;
      }
    }
    const args = [];
    let media = null;
    for (;;) {
      const t = this.peek();
      // Checked BEFORE the numeric-pattern branch below, which would otherwise
      // take `["audio" "video"]` for a subdivision and fault on its leaves.
      if (sig.mediaArg && this.atMediaArg()) {
        if (media) {
          this.error(`'${name}' already has a medium set`, t);
          this.recover();
          return;
        }
        media = this.parseMediaArg(name, sig);
        if (!media) { this.recover(); return; }
        continue;
      }
      // The medium set closes the directive. Allowing arguments after it would
      // read as though the set applied only to what preceded it, which is not
      // what it means — an effect names its media once, for the whole line.
      if (media && !this.atStatementEnd()) {
        this.error(`'${name}' takes its medium set last — move it to the end of the directive`, t);
        this.recover();
        return;
      }
      if (t.type === 'punct' && t.value === '(') {
        this.error(sig.patternArgs
          ? `'${name}' arguments are positive numbers or mini-notation patterns like <2 4> — parenthesized expressions cannot be executed in the JPattern editor`
          : `'${name}' cannot take Strudel-call arguments — parameters are plain positive numbers`, t);
        this.skipParenBlob();
        return;
      }
      if (t.type === 'number' || t.type === 'intlike') {
        this.next();
        const val = typeof t.value === 'number' ? t.value : parseFloat(t.value);
        args.push({ value: val, tok: t });
        continue;
      }
      if (t.type === 'word' && (t.value === 'true' || t.value === 'false')) {
        this.next();
        args.push({ value: t.value === 'true', tok: t });
        continue;
      }
      if (sig.patternArgs && t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        const seq = this.parseValueSequence(name, 'number', sig);
        if (!seq) return;
        args.push({ value: seq, tok: t });
        continue;
      }
      // A bare `Weather:3`, on the same footing as a bare `<…>`: both are
      // sampled per cycle, so both belong to the same set of directives.
      if (sig.patternArgs && t.type === 'dataref') {
        this.next();
        args.push({ value: { type: 'dataRef', name: t.value.name, index: t.value.index }, tok: t });
        continue;
      }
      if (sig.takesSequence && t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        const seq = this.parseSequenceGroup();
        if (seq) args.push({ value: seq, tok: t });
        continue;
      }
      break;
    }

    // Anything left on the statement that isn't the next directive is junk
    // (e.g. `# grid maybe`).
    if (!this.atStatementEnd()) {
      const trailing = this.peek();
      this.error(`'${name}' got an unexpected argument '${tokenText(trailing)}'`, trailing);
      this.recover();
      return;
    }

    if (args.length < sig.minArgs || args.length > sig.maxArgs + (sig.takesSequence ? 1 : 0)) {
      this.error(`'${name}' takes ${sig.minArgs === sig.maxArgs ? sig.minArgs : `${sig.minArgs}–${sig.maxArgs}`} argument(s), got ${args.length}`, nameTok);
      return;
    }
    for (const a of args) {
      if (typeof a.value === 'boolean') {
        if (!sig.boolArg) this.error(`'${name}' does not take a boolean argument`, a.tok);
      } else if (typeof a.value === 'number') {
        if (sig.probability) {
          if (!(a.value >= 0 && a.value <= 1)) this.error(`'${name}' probability must be in [0, 1]`, a.tok);
        } else if (!(a.value > 0) || !isFinite(a.value)) {
          this.error(`'${name}' arguments must be positive real numbers`, a.tok);
        }
      }
    }
    const entry = { fn: name, args: args.map(a => a.value), line: nameTok.line, col: nameTok.col };
    if (metric) entry.metric = metric;
    // Left off entirely when unwritten, so the AST reports the directives
    // performers actually typed and the whole-room default lives in one place
    // (EffectMedia.resolveMedia) rather than being baked into every entry.
    if (media) entry.media = media;
    program.chain.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Public API

export function parseMetaprogram(text) {
  const src = typeof text === 'string' ? text : '';
  // The directive is required, with no heuristic fallback: a buffer that does
  // not open with `'metaprogram editor'` is not a metaprogram, and the rest is
  // parsed only so the editor can still squiggle whatever else is wrong.
  // Blanking the directive line in place keeps every downstream line/col
  // exactly where the author typed it.
  const dir = readDirective(src);
  const rawBody = dir.kind === 'metaprogram' ? stripDirective(src) : src;
  // A whole-buffer notation choice: mini ($: … .method(…)) is lowered to the
  // mondo grammar this parser tokenises; a mondo buffer passes straight
  // through; a buffer that mixes the two is refused before parsing.
  const notation = detectNotation(rawBody);
  const body = notation === 'mini' ? miniToMondo(rawBody) : rawBody;
  const { tokens, errors } = tokenize(body);
  if (notation === 'mixed') {
    errors.push({
      message: 'a metaprogram is written entirely in one notation — this buffer mixes mini ($: … .cycles(…)) with mondo ($ … / # cycles …)',
      line: (dir.lineIndex ?? 0) + 2,
      col: 1,
    });
  }
  if (dir.kind !== 'metaprogram') {
    errors.push({
      message: dir.kind == null
        ? (dir.reason || "a metaprogram must open with the 'metaprogram editor' directive line")
        : `this is a '${dir.phrase}' buffer, not a metaprogram — the first line must be 'metaprogram editor'`,
      line: (dir.lineIndex ?? 0) + 1,
      col: 1,
    });
  }
  const parser = new Parser(tokens, errors);
  const ast = parser.parseProgram();
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return { ast, errors, valid: errors.length === 0 };
}

// export function getTokens(text) {
//   const { tokens, _ } = tokenize(typeof text === 'string' ? text: '');
//   return tokens;
// }
// Resolved effect parameter objects for the chain (validation must have
// passed). Consumed by the Metaprogrammer when instantiating av-effects.
// `cycle` selects the element of any `<…>` argument pattern; effects without
// patterned arguments ignore it entirely.
export function resolveEffectParams(chainEntry, { cycle = 0 } = {}) {
  const { fn, args } = chainEntry;
  switch (fn) {
    // `# room <metric> [scale] [fixed metric amount]` — decay = scale × the
    // named metric; the optional third token pins it (0.4 = 400 ms) instead of
    // reading live metrics. Any of the three may be a valueSeq node
    // (`# room <wcl wcpl> <1 2 ~ 2 3>*2`); roomParams reads them per cycle.
    case 'room': return { metric: chainEntry.metric ?? 'wcl', scale: args[0] ?? 1, fixedMetric: args[1] ?? null };
    // `# echo <m> <length> <m> <feedback> <m> <gain> [<bound>×3]` — one slot
    // per parameter, each carrying its own metric, scale (number or pattern)
    // and upper bound. Written-out pairs win; anything missing takes the
    // bare-`# echo` default, and a null bound defers to the metric's own
    // (av-effects/Echo.js owns both the bounds and the normalization).
    case 'echo': {
      const pairs = chainEntry.pairs || [];
      const bounds = chainEntry.bounds || [];
      return {
        slots: ECHO_DEFAULT_SLOTS.map((fallback, i) => ({
          param: fallback.param,
          metric: pairs[i] ? pairs[i].metric : fallback.metric,
          scale: pairs[i] ? pairs[i].value : fallback.scale,
          bound: bounds[i] ?? fallback.bound
        }))
      };
    }
    // `# crush <metric> [scale] [fixed metric amount]` — bit depth = 8 × scale,
    // halved as the metric climbs. Any of the three may be a valueSeq node
    // (`# crush <wcl wcpl> <2 4>`); crushParams reads them per cycle.
    case 'crush': return { metric: chainEntry.metric ?? 'wcl', scale: args[0] ?? 1, fixedMetric: args[1] ?? null };
    // `# noise [<metric>] [<spectrum factor>] [<metric>] [<volume factor>]
    // [<amount 1>] [<amount 2>]` — one slot per axis, each naming the metric
    // that modulates it, how hard, and (optionally) a value pinning that
    // metric. A factor defaults to 1 only when its metric keyword was
    // written; unwritten means 0, which is "this axis does not modulate" and
    // is what leaves a bare `# noise` at brown, 25 dB.
    //
    // Unlike crush and echo — whose params functions sample their own patterns
    // — noise is resolved to plain numbers HERE, because the aggregator's
    // master bus rebuilds the bed from the resolved values once per cycle.
    case 'noise': {
      const metrics = chainEntry.metrics || [];
      const axis = (i) => {
        const metric = evaluateValuePattern(metrics[i], cycle);
        const factor = evaluateValuePattern(args[i], cycle);
        const fixed = evaluateValuePattern(args[i + 2], cycle);
        return {
          metric: EFFECT_METRICS.includes(metric) ? metric : 'wcl',
          factor: typeof factor === 'number' ? factor : (metrics[i] != null ? 1 : 0),
          fixed: typeof fixed === 'number' ? fixed : null
        };
      };
      return { spectrum: axis(0), volume: axis(1) };
    }
    case 'grid': return { landmarks: args[0] ?? false };
    // `# mosaic [bool]` — a bare `# mosaic` is the mosaic, same as omitting it
    // entirely; only an explicit `false` drops to the single streaming cell.
    case 'mosaic': return { enabled: args[0] ?? true };
    default: return { args };
  }
}

// Whether the aggregator should tile its frame, for a parsed program. Reads
// the LAST `# mosaic` in the chain so a re-typed directive wins, and falls
// back to the default for a program that never mentions it.
export function mosaicEnabled(ast) {
  const chain = (ast && ast.chain) || [];
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].fn === 'mosaic') return !!resolveEffectParams(chain[i]).enabled;
  }
  return MOSAIC_ENABLED_BY_DEFAULT;
}

// The default program every room starts under (JPattern is always on).
//
// `# ring hash` derives the rotation from a consistent hash of the PRESENT
// roster (TurnRing.orderTokens), so every joiner takes turns immediately and a
// join/leave needs no `$ participants` edit and no CRDT round-trip. The
// `$ participants <0>` line is still required by the grammar (a program has a
// `$` scheduling sequence) but seeds nothing in hash mode; edit the line to
// `# ring explicit` to walk it literally instead — the old behaviour, where
// only the listed tokens play.
//
// wcl is the worst-case mouth-to-ear latency a performer actually hears — tens
// of ms, the de-jitter buffer dominating — so a scale of 20 turns a ~100 ms
// room into ~2 s solos. Raise it for longer turns, lower it for a faster round.
//
// No `# tempo` line: the room's default program leaves the tempo unwritten so
// the beat grid is not part of what a performer reads when they open the
// editor. Cycle length still quantizes onto the parser's 120 bpm default —
// writing an explicit `# tempo` is how you change that.
export function buildDefaultProgram() {
  return `'metaprogram editor'\n$ participants <0>\n# ring hash\n# cycles "wcl" 20\n`;
}

// --- Program-text roster edits ----------------------------------------------
//
// Append to / remove from the scheduling sequence *as text*, preserving
// whatever else the users wrote. These are deliberate-edit helpers (nothing
// auto-applies them on join/leave: newcomers wait unlisted and silent, and
// departed-but-listed participants persist as ghosts until an edit drops
// them). Pure so the CRDT layer can apply the same edits to the shared doc.

// The LIVE scheduling statement: a `$` opening a line, with the now-optional
// `participants` label. Anchoring matters — an unanchored match finds
// `$ <…>` anywhere, including inside a `*$` button declaration or a
// commented-out line, and every helper below would then edit text that is not
// the running program. Groups: prefix, open bracket, body, close bracket. The
// body may span lines, as a wrapped sequence does.
const SEQUENCE_RE = /^([ \t]*\$[ \t]*(?:participants[ \t]*)?)([<[])([^\]>]*)([\]>])/m;

function escapeForRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchSequence(text) {
  return String(text ?? '').match(SEQUENCE_RE);
}

// Whether a matched sequence lists this token. The token may carry its own
// modifiers (`0@2`), so it is escaped before it goes into the pattern.
function sequenceLists(m, token) {
  return new RegExp(`(^|[\\s<\\[])${escapeForRegExp(token)}($|[\\s\\]>@!?*/,|%:])`)
    .test(m[2] + m[3] + m[4]);
}

// Whether the program's live scheduling sequence already lists this token.
export function programHasParticipant(text, token) {
  const m = matchSequence(text);
  return !!m && sequenceLists(m, token);
}

// Whether the program has a live scheduling sequence to append to at all. An
// empty doc has none, and a caller that wants a token in the ring has to write
// the whole `$ participants <…>` statement instead.
export function hasParticipantSequence(text) {
  return !!matchSequence(text);
}

export function appendParticipantToProgram(text, token) {
  const m = matchSequence(text);
  if (!m || sequenceLists(m, token)) return text;
  // No separator into an empty sequence — `<>` becomes `<0>`, not `< 0>`.
  const body = m[3].trimEnd();
  return text.replace(m[0], `${m[1]}${m[2]}${body ? `${body} ` : ''}${token}${m[4]}`);
}

export function removeParticipantFromProgram(text, token) {
  const m = matchSequence(text);
  if (!m) return text;
  const cleaned = m[3]
    .split(/\s+/)
    .filter(w => {
      // Exact match first: a token written WITH its modifiers (`0@2`) is a
      // different element from the bare `0` and has to be removable on its
      // own terms. Bare `0` still takes `0@2` with it, via the base match.
      if (w === token) return false;
      const base = w.match(/^([0-9]+[a-z]*)/);
      return !(base && base[1] === token);
    })
    .join(' ');
  return text.replace(m[0], `${m[1]}${m[2]}${cleaned}${m[4]}`);
}
