import {
  isValidParticipantToken,
  parseParticipantToken
} from '../../latency-instrument/room-indices.js';
import { ECHO_METRICS, ECHO_SLOTS, ECHO_DEFAULT_SLOTS } from './av-effects/Echo.js';
import {
  evaluateValuePattern, isValuePattern, isDataRefNode, DEFAULT_DROP_CHANCE,
} from './ValuePattern.js';
import { MEDIA, isMedium, normalizeMediaSet } from './EffectMedia.js';
import { readDirective, stripDirective } from '../program-directive.js';
import { detectNotation, miniToMondo } from '../notation.js';

export const TIMING_METRICS = ['wcl', 'wcj', 'wcpl'];

export const RING_MODES = ['explicit'];
export const EFFECT_METRICS = ['wcl', 'wcj', 'wcrtt', 'wcpl'];

function isMetricKeywordToken(t) {
  return !!t && t.type === 'string';
}

// Every metric keyword, for spotting a bare (unquoted) one and telling the
// author to quote it rather than falling through to a vaguer error.
const METRIC_WORDS = new Set(['wcl', 'wcj', 'wcrtt', 'wcpl']);


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
export const CRUSH_METRICS = ['wcl', 'wcj', 'wcpl', 'wcrtt'];
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
  noise: { kind: 'effect', grammar: 'noise', metricKeywords: EFFECT_METRICS, patternArgs: true, mediaArg: true },
  grid: { minArgs: 0, maxArgs: 1, kind: 'effect', boolArg: true }, // landmarks=false
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
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== '\n') j++;
      const terminated = text[j] === "'";
      if (!terminated) {
        errors.push({
          message: "unterminated string",
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

function tokenWidth(t) {
  return String(t.raw != null ? t.raw : (t.value ?? '')).length;
}

function tokenText(t) {
  return String(t.raw != null ? t.raw : (t.value ?? ''));
}

class Parser {
  constructor(tokens, errors, directiveKind = 'metaprogram') {
    this.tokens = tokens.filter(t => t.type !== 'newline' || true); // keep newlines: statement boundaries
    this.pos = 0;
    this.errors = errors;
    this.directiveKind = directiveKind;
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  next() { return this.tokens[this.pos++]; }
  atEof() { return this.peek().type === 'eof'; }
  error(message, tok) {
    const t = tok || this.peek();
    this.errors.push({ message, line: t.line, col: t.col });
  }
  skipNewlines() { while (this.peek().type === 'newline') this.next(); }

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
      participants: null, cycles: null, tempo: null, ring: null, chain: []
    };
    this.skipNewlines();
    while (!this.atEof()) {
      const t = this.peek();
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
    if (!program.cycles) program.cycles = { metric: 'wcl', factor: 20, fixed: null, defaulted: true };
    return program;
  }

  parseDollar(program) {
    const sigil = this.next(); // '$'
    const name = this.peek();
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
    let detached = false;
    const accept = (mod) => { mods.push(mod); if (!detached) extent = end; };
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || t.value === '..') break; // '..' is the caller's range
      if (!glued(t)) {
        this.error(
          `'${t.value}' has to be attached to what it modifies — write '0${t.value}2', not '0 ${t.value}2'`, t);
        detached = true;
        take();
        const operand = this.peek();
        if (glued(operand) && (operand.type === 'number' || operand.type === 'intlike')) take();
        continue;
      }
      take();
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
      this.error('cyclic timing modes cannot be chained — exactly one # cycles directive is allowed', nameTok);
      return;
    }
    program.cycles = { metric: metricTok.value, factor, fixed };
  }

  parseTempo(program, nameTok) {
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

  parseRing(program, nameTok) {
    if (program.ring) {
      this.error('duplicate # ring directive', nameTok);
      this.recover();
      return;
    }
    let mode = 'hash';
    const modeTok = this.peek();
    const isWTok = modeTok.type === 'word' && modeTok.value === 'w';
    if (modeTok.type === 'word' && RING_MODES.includes(modeTok.value)) {
      mode = modeTok.value;
      this.next();
    } else if (!isWTok && !this.atStatementEnd()) {
      this.error(`ring's mode must be 'explicit' — bare '# ring' already means hash — got '${tokenText(modeTok)}'`, modeTok);
      this.recover();
      return;
    }
    const ring = { mode, weights: {} };
    if (this.peek().type === 'word' && this.peek().value === 'w') {
      if (ring.mode !== 'hash') {
        this.error("weights only apply to hash mode (bare '# ring'), not '# ring explicit'", this.peek());
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
      this.error(`ring got an unexpected argument '${tokenText(this.peek())}' — the syntax is '# ring [explicit] [w <token> <weight> …]'`, this.peek());
      this.recover();
      return;
    }
    program.ring = ring;
  }

  parseValueSequence(name, kind, sig, { alternationOnly = false, topLevel = true } = {}) {
    const open = this.next(); // '<' or '['
    const close = open.value === '<' ? '>' : ']';
    const mode = open.value === '<' ? 'alternate' : 'subdivide';
    const terms = [];
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

  parseValueElementModifiers(name, index, terms, weights, chances, rates) {
    let repeats = 1;
    let rate = 1;
    for (;;) {
      const op = this.peek();
      if (op.type !== 'op' || !VALUE_ELEMENT_OPS.has(op.value)) break;
      this.next();
      const countTok = this.peek();
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
    for (let copy = 1; copy < repeats; copy++) {
      terms.push(terms[index]);
      weights[terms.length - 1] = weights[index];
      chances[terms.length - 1] = chances[index];
      rates[terms.length - 1] = rates[index];
    }
  }

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

  skipParenBlob() {
    let depth = 0;
    while (!this.atEof()) {
      const p = this.next();
      if (p.type === 'punct' && p.value === '(') depth++;
      if (p.type === 'punct' && p.value === ')') { depth--; if (depth === 0) return; }
    }
  }

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
    if (media) entry.media = media;
    program.chain.push(entry);
  }
}


export function parseMetaprogram(text) {
  const src = typeof text === 'string' ? text : '';
  const dir = readDirective(src);
  const isMetaprogramBuffer = dir.kind === 'metaprogram';
  const rawBody = isMetaprogramBuffer ? stripDirective(src) : src;
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
  if (!isMetaprogramBuffer) {
    errors.push({
      message: dir.kind == null
        ? (dir.reason || "a metaprogram must open with the 'metaprogram editor' directive line")
        : `this is a '${dir.phrase}' buffer, not a metaprogram — the first line must be 'metaprogram editor'`,
      line: (dir.lineIndex ?? 0) + 1,
      col: 1,
    });
  }
  const parser = new Parser(tokens, errors, 'metaprogram');
  const ast = parser.parseProgram();
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return { ast, errors, valid: errors.length === 0 };
}

export function resolveEffectParams(chainEntry, { cycle = 0 } = {}) {
  const { fn, args } = chainEntry;
  switch (fn) {
    case 'room': return { metric: chainEntry.metric ?? 'wcl', scale: args[0] ?? 1, fixedMetric: args[1] ?? null };
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

    case 'crush': return { metric: chainEntry.metric ?? 'wcl', scale: args[0] ?? 1, fixedMetric: args[1] ?? null };
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

// The default Metaprogram a fresh room starts under: participant 0 streams
// continuously and every later joiner — human or bot — waits off the ring
// until a performer lists their token in `$ participants`. Deliberately does
// NOT ship `# ring`: the hash ring auto-admits the present roster, which would
// start a joining bot playing without ever being added to the Metaprogram.
// `# ring` remains available as an opt-in (see docs-about.js, "Participant
// Turn Ordering").
export function buildDefaultProgram() {
  return `'metaprogram editor'\n$ participants <0>\n# cycles "wcl" 20\n`;
}

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
