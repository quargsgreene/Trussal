// NetCycles metaprogram parser: text → AST.
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
// The one reader for every patterned `#` argument, whatever the effect — and
// the bare-`?` probability, which is that reader's to define rather than the
// grammar's.
import { evaluateValuePattern, isValuePattern, DEFAULT_DROP_CHANCE } from './ValuePattern.js';

export const TIMING_METRICS = ['wcl', 'wcj', 'wcpl'];
// Metrics an effect may be modulated by. Wider than TIMING_METRICS: wcrtt
// cannot set a cycle length (it is a round trip, not a turn) but it is a
// perfectly good modulation source, and room already reads it for its cutoff.
export const EFFECT_METRICS = ['wcl', 'wcj', 'wcrtt', 'wcpl'];

// Whether a parsed pattern holds metric keywords or numbers, taken from its
// first leaf. `# noise`'s slots are positional, so which of the two a `<…>`
// carries is only known once it has been read.
function valuePatternKind(node) {
  if (!isValuePattern(node)) return null;
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

// name → { minArgs, maxArgs, kind } for every legal `#` directive besides
// cycles/tempo. Args are positive reals unless noted. `metricKeywords`
// requires a leading metric word before the numeric args (`# room wcl 2 0.4`);
// `metricPairs` instead takes that many <metric> <scale> pairs, one per
// parameter, followed by that many optional upper bounds (`# echo`, below).
// `patternArgs` additionally lets the metric and the numbers be written as
// mini-notation sequences (`# crush <wcl wcj> <2 4>`), read per cycle — rests
// and a trailing `*n` / `/n` rate included.
const EFFECTS = {
  // scale=1, fixed metric amount=live. Any worst-case metric may drive the
  // decay, and all three arguments pattern — `# room <wcl wcj> <1 2 ~ 2 3>*2`.
  room: { minArgs: 0, maxArgs: 2, kind: 'effect', metricKeywords: EFFECT_METRICS, patternArgs: true },
  echo: {
    kind: 'effect',
    metricKeywords: ECHO_METRICS,
    metricPairs: ECHO_SLOTS,          // length (cycles), feedback, gain
    patternArgs: true,                // scales and bounds may be <2 3> / [1 4]
    usage: '# echo <metric> <length> <metric> <feedback> <metric> <gain> [<bound> <bound> <bound>]'
  },
  // scale=1 (8-bit base), fixed metric amount=live
  crush: { minArgs: 0, maxArgs: 2, kind: 'effect', metricKeywords: CRUSH_METRICS, patternArgs: true },
  // noise interleaves two metric keywords with its numbers and takes patterns
  // in any slot, which parseChainFn's positional-numbers grammar cannot
  // express — it parses in parseNoise instead.
  noise: { kind: 'effect', grammar: 'noise', metricKeywords: EFFECT_METRICS, patternArgs: true },
  grid: { minArgs: 0, maxArgs: 1, kind: 'effect', boolArg: true } // landmarks=false
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

export const EFFECT_DEFAULTS = {
  room: { metric: 'wcl', scale: 1, fixedMetric: null },
  // Bare `# echo`: wcl drives all three parameters, at half a cycle of delay,
  // half feedback and unity gain — each still normalized against wcl's default
  // upper bound, so these are the values reached at that bound rather than
  // fixed outputs. Bounds default per metric (av-effects/Echo.js, which owns
  // this table; echoParams falls back to the very same objects).
  echo: { slots: ECHO_DEFAULT_SLOTS },
  crush: { metric: 'wcl', scale: 1, fixedMetric: null },
  // Both noise axes default to wcl but to factor 0 — nothing modulates until
  // a factor (or the metric keyword that implies one) is written, which is
  // what makes a bare `# noise` the unmodulated floor.
  noise: {
    spectrum: { metric: 'wcl', factor: 0, fixed: null },
    volume: { metric: 'wcl', factor: 0, fixed: null }
  },
  grid: { landmarks: false }
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
  const push = (type, value, l, c) => tokens.push({ type, value, line: l, col: c });

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
        push('number', parseFloat(raw), startLine, startCol);
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

  // Consume to the start of the next statement ($ or # at statement level) so
  // one bad statement doesn't cascade.
  recover() {
    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'sigil') return;
      this.next();
    }
  }

  parseProgram() {
    const program = { participants: null, cycles: null, tempo: null, chain: [] };
    this.skipNewlines();
    while (!this.atEof()) {
      const t = this.peek();
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
      this.errors.push({ message: "missing '$ participants' scheduling sequence", line: 1, col: 1 });
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
    if (name.type !== 'word' || name.value !== 'participants') {
      this.error(`unknown '$' statement '${name.value}' (only 'participants' exists)`, name);
      this.recover();
      return;
    }
    this.next();
    if (program.participants) {
      this.error("duplicate '$ participants' statement", sigil);
      this.recover();
      return;
    }
    const seq = this.parseSequenceGroup();
    if (!seq) { this.recover(); return; }
    // Sequence-level postfix: *n or /n.
    seq.modifiers = this.parseModifiers();
    program.participants = seq;
  }

  // <...> (alternate: one element per cycle) or [...] (subdivide the cycle).
  parseSequenceGroup() {
    const open = this.peek();
    if (open.type !== 'punct' || (open.value !== '<' && open.value !== '[')) {
      this.error(`expected '<' or '[' to open a sequence, got '${open.value ?? 'end of input'}'`, open);
      return null;
    }
    this.next();
    const close = open.value === '<' ? '>' : ']';
    const mode = open.value === '<' ? 'alternate' : 'subdivide';

    // stacks ← elements split on ','; each stack may be a '|' choice of runs.
    const stacks = [];
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
        finishStack(t);
        break;
      }
      if (t.type === 'punct' && (t.value === '>' || t.value === ']')) {
        this.error(`mismatched '${t.value}' — expected '${close}'`, t);
        this.next();
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
        for (let v = lo; v <= high; v++) {
          run.push({ type: 'participant', token: String(v), ownerIndex: v, suffix: null, modifiers: [], line: el.line, col: el.col });
        }
        continue;
      }
      el.modifiers = this.parseModifiers();
      run.push(el);
    }
    return { type: 'sequence', mode, stacks, modifiers: [] };
  }

  parseElement() {
    const t = this.peek();
    if (t.type === 'rest') {
      this.next();
      return { type: 'rest', token: t.value, modifiers: [], line: t.line, col: t.col };
    }
    if (t.type === 'punct' && (t.value === '<' || t.value === '[')) {
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
        col: t.col
      };
    }
    this.error(`unexpected '${t.value}' in sequence`, t);
    return null;
  }

  // Postfix element/sequence modifiers: *n /n @n !n %n :n ?[p]
  parseModifiers() {
    const mods = [];
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op') return mods;
      if (t.value === '..') return mods; // handled by the caller as a range
      this.next();
      // `?` and `!` may stand alone (Strudel's "half the time" and "once
      // more"). Their count must be GLUED to the operator to belong to it —
      // with a gap it is the next sequence element ("4? 10", "0! 2").
      if (t.value === '?' || t.value === '!') {
        const p = this.peek();
        const bare = t.value === '?' ? { op: '?', value: null } : { op: '!', value: 2 };
        if (!(p.line === t.line && p.col === t.col + 1) || (p.type !== 'number' && p.type !== 'intlike')) {
          mods.push(bare);
          continue;
        }
        this.next();
        const val = typeof p.value === 'number' ? p.value : parseFloat(p.value);
        if (t.value === '?') {
          if (!(val >= 0 && val <= 1)) this.error("'?' probability must be in [0, 1]", p);
          else mods.push({ op: '?', value: val });
        } else if (!(val > 0) || !isFinite(val)) {
          this.error("'!' needs a positive repeat count", p);
        } else {
          mods.push({ op: '!', value: val });
        }
        continue;
      }
      const arg = this.peek();
      if (arg.type !== 'number' && arg.type !== 'intlike') {
        this.error(`operator '${t.value}' needs a numeric argument`, t);
        continue;
      }
      this.next();
      const val = typeof arg.value === 'number' ? arg.value : parseFloat(arg.value);
      if (!(val > 0) || !isFinite(val)) {
        this.error(`operator '${t.value}' needs a positive number`, arg);
        continue;
      }
      mods.push({ op: t.value, value: val });
    }
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

    if (PATTERN_FNS[name]) { this.parseChainFn(program, name, nameTok, PATTERN_FNS[name]); return; }
    if (EFFECTS[name]) {
      const sig = EFFECTS[name];
      if (sig.grammar === 'noise') this.parseNoise(program, nameTok, sig);
      else if (sig.metricPairs) this.parseMetricPairFn(program, name, nameTok, sig);
      else this.parseChainFn(program, name, nameTok, sig);
      return;
    }

    this.error(`'${name}' is not a NetCycles function — Strudel and Hydra functions cannot be executed in the NetCycles editor`, nameTok);
    this.recover();
  }

  // `# cycles <metric> [scale factor] [amount]` — target = scale × metric.
  // With no amount the metric evolves with the live worst-case measurement;
  // an amount PINS it there regardless of network conditions (seconds for
  // wcl/wcj, loss fraction for wcpl), pinning timing only — measured
  // metrics still drive effects and readouts. `# cycles wcl 10 0.3` = 3 s.
  parseCycles(program, nameTok) {
    const metricTok = this.peek();
    if (metricTok.type !== 'word' || !TIMING_METRICS.includes(metricTok.value)) {
      this.error(`cycles needs a timing metric (${TIMING_METRICS.join('|')})`, metricTok);
      this.recover();
      return;
    }
    this.next();
    if (this.peek().type === 'op' && this.peek().value === '*') {
      this.error(`the cycles scale factor is positional now — write '# cycles ${metricTok.value} 3', not '${metricTok.value}*3'`, this.peek());
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
      this.error(`cycles got an unexpected argument '${trailing.value}' — the syntax is '# cycles <metric> [scale factor] [amount]'`, trailing);
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
  // `<wcl ~ wcj>` is still a pattern of metrics.
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
      if ((kind === 'metric' || kind === 'any') && t.type === 'word') {
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
        leafKind === 'metric'
          ? `'${name}' pattern expects metric names (${(sig.metricKeywords || EFFECT_METRICS).join('|')}), got '${t.value}'`
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

    if (!this.atStatementEnd()) {
      for (let i = 0; i < slots.length; i++) {
        const t = this.peek();
        if (t.type !== 'word' || !sig.metricKeywords.includes(t.value)) {
          this.error(
            `'${name}' needs a metric keyword (${sig.metricKeywords.join('|')}) before its ${slots[i]} ` +
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
        const value = this.parseNumericArg(name, `${slots[i]} upper bound`, sig);
        if (value == null) { this.recover(); return; }
        bounds.push(value);
      }
    }

    if (!this.atStatementEnd()) {
      const trailing = this.peek();
      this.error(`'${name}' got an unexpected argument '${trailing.value}' — the syntax is '${sig.usage}'`, trailing);
      this.recover();
      return;
    }
    program.chain.push({ fn: name, args: [], pairs, bounds, line: nameTok.line, col: nameTok.col });
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

  // A positive number — plain or fractional — or, where the signature allows
  // it, a pattern of them. Returns null once an error has been recorded.
  parseNumericArg(name, slot, sig) {
    const t = this.peek();
    if (t.type === 'number' || t.type === 'intlike') return this.readPositiveNumber(name, slot);
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
      // second, bogus "not a NetCycles function" error.
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
    for (;;) {
      const t = this.peek();
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
      if (t.type === 'word' && EFFECT_METRICS.includes(t.value)) {
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
      this.error(`'noise' got an unexpected argument '${trailing.value}' — the syntax is ` +
        "'# noise [<metric>] [spectrum factor] [<metric>] [volume factor] [amount] [amount]'", trailing);
      this.recover();
      return;
    }
    if (args.length > 4) {
      this.error(`'noise' takes at most 4 numeric arguments (two factors then two pinned amounts), got ${args.length}`, nameTok);
      return;
    }
    program.chain.push({ fn: 'noise', args, metrics, line: nameTok.line, col: nameTok.col });
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
    // `# room wcl 2 0.4`. The keyword is required — a bare-number form has
    // no metric and is a parse error.
    let metric = null;
    if (sig.metricKeywords) {
      const t = this.peek();
      if (t.type === 'word' && sig.metricKeywords.includes(t.value)) {
        metric = t.value;
        this.next();
      } else if (sig.patternArgs && t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        metric = this.parseValueSequence(name, 'metric', sig);
        if (!metric) { this.recover(); return; }
      } else {
        this.error(`'${name}' needs a metric keyword (${sig.metricKeywords.join('|')}) before its arguments`, t);
        this.recover();
        return;
      }
    }
    const args = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '(') {
        this.error(sig.patternArgs
          ? `'${name}' arguments are positive numbers or mini-notation patterns like <2 4> — parenthesized expressions cannot be executed in the NetCycles editor`
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
      this.error(`'${name}' got an unexpected argument '${trailing.value}'`, trailing);
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
    program.chain.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Public API

export function parseMetaprogram(text) {
  const { tokens, errors } = tokenize(typeof text === 'string' ? text : '');
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
    // (`# room <wcl wcj> <1 2 ~ 2 3>*2`); roomParams reads them per cycle.
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
    // (`# crush <wcl wcj> <2 4>`); crushParams reads them per cycle.
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
    default: return { args };
  }
}

// The default program every room starts under (Net Cycles is always on):
// participant 0 — the first to join — streams continuously. Nobody else is
// listed, so later joiners stay silent until an edit adds them. wcl is the
// worst-case mouth-to-ear latency a performer actually hears — tens of ms, the
// de-jitter buffer dominating — so a scale of 20 turns a ~100 ms room into ~2 s
// solos. Raise it for longer turns, lower it for a faster round.
//
// No `# tempo` line: the room's default program leaves the tempo unwritten so
// the beat grid is not part of what a performer reads when they open the
// editor. Cycle length still quantizes onto the parser's 120 bpm default —
// writing an explicit `# tempo` is how you change that.
export function buildDefaultProgram() {
  return `$ participants <0>\n# cycles wcl 20\n`;
}

// --- Program-text roster edits ----------------------------------------------
//
// Append to / remove from the scheduling sequence *as text*, preserving
// whatever else the users wrote. These are deliberate-edit helpers (nothing
// auto-applies them on join/leave: newcomers wait unlisted and silent, and
// departed-but-listed participants persist as ghosts until an edit drops
// them). Pure so the CRDT layer can apply the same edits to the shared doc.

export function appendParticipantToProgram(text, token) {
  const m = text.match(/(\$\s*participants\s*[<[][^\]>]*)([\]>])/);
  if (!m) return text;
  if (new RegExp(`(^|[\\s<\\[])${token}($|[\\s\\]>@!?*/,|%:])`).test(m[1] + m[2])) return text;
  const body = m[1].trimEnd();
  return text.replace(m[0], `${body} ${token}${m[2]}`);
}

export function removeParticipantFromProgram(text, token) {
  const m = text.match(/(\$\s*participants\s*)([<[])([^\]>]*)([\]>])/);
  if (!m) return text;
  const cleaned = m[3]
    .split(/\s+/)
    .filter(w => {
      const base = w.match(/^([0-9]+[a-z]*)/);
      return !(base && base[1] === token);
    })
    .join(' ');
  return text.replace(m[0], `${m[1]}${m[2]}${cleaned}${m[4]}`);
}
