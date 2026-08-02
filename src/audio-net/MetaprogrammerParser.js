// NetCycles metaprogram parser: text → AST.
//
// The metaprogramming language is Mondo-flavoured (strudel.cc mini-notation
// sequences) but deliberately tiny: one `$ participants` scheduling sequence
// plus `#`-chained directives (one cyclic timing mode, a tempo, network-
// modulated AV effects, and a whitelist of Strudel-analog pattern functions).
// Everything else — arbitrary Strudel calls, any Hydra call — is a validation
// error, as is a pattern-valued argument to any effect but `noise`, whose
// arguments accept `<…>` alternation sampled one element per cycle.
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

export const TIMING_METRICS = ['wcl', 'wcj', 'wcpl'];
// Metrics an effect may be modulated by. Wider than TIMING_METRICS: wcrtt
// cannot set a cycle length (it is a round trip, not a turn) but it is a
// perfectly good modulation source, and room already reads it for its cutoff.
export const EFFECT_METRICS = ['wcl', 'wcj', 'wcrtt', 'wcpl'];
export const TEMPO_UNITS = ['bpm', 'cps', 'cpm'];

// name → { minArgs, maxArgs, kind } for every legal `#` directive besides
// cycles/tempo. Args are positive reals unless noted. `metricKeywords`
// requires a leading metric word before the numeric args (`# room wcl 2 0.4`).
const EFFECTS = {
  room: { minArgs: 0, maxArgs: 2, kind: 'effect', metricKeywords: ['wcl'] }, // scale=1, fixed wcl seconds=live
  echo: { minArgs: 0, maxArgs: 2, kind: 'effect' },   // n_samples_factor=1, magnitude_feedback_factor=0.1
  crush: { minArgs: 0, maxArgs: 1, kind: 'effect' },  // reduction_factor=1
  // noise interleaves two metric keywords with its numbers and takes patterns
  // in any slot, which parseChainFn's positional-numbers grammar cannot
  // express — it parses in parseNoise instead.
  noise: { kind: 'effect', grammar: 'noise' },
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
  room: { metric: 'wcl', scale: 1, fixedWclS: null },
  echo: { nSamplesFactor: 1, magnitudeFeedbackFactor: 0.1 },
  crush: { reductionFactor: 1 },
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
      if (t.value === '?') {
        // Optional probability: ?0.3 — the number must be glued to the '?';
        // with a gap it's the next sequence element ("4? 10").
        const p = this.peek();
        const adjacent = p.line === t.line && p.col === t.col + 1;
        if (adjacent && (p.type === 'number' || p.type === 'intlike')) {
          this.next();
          const val = typeof p.value === 'number' ? p.value : parseFloat(p.value);
          if (!(val >= 0 && val <= 1)) this.error("'?' probability must be in [0, 1]", p);
          else mods.push({ op: '?', value: val });
        } else {
          mods.push({ op: '?', value: null });
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
      if (EFFECTS[name].grammar === 'noise') this.parseNoise(program, nameTok);
      else this.parseChainFn(program, name, nameTok, EFFECTS[name]);
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
    const trailing = this.peek();
    if (trailing.type !== 'newline' && trailing.type !== 'eof' && trailing.type !== 'sigil') {
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

  // `# noise [<metric>] [<spectrum factor>] [<metric>] [<volume factor>]
  //          [<amount for metric 1>] [<amount for metric 2>]`
  //
  // Positional, with the two metric keywords optional and interleaved: a
  // keyword binds to the factor that FOLLOWS it, so `# noise wcl 20 wcrtt 10`
  // reads "spectrum from wcl × 20, volume from wcrtt × 10". The numbers fill
  // the spectrum factor, the volume factor, then the two pinned amounts — in
  // the order the metrics were written. Any slot may instead be a `<…>`
  // pattern, sampled one element per cycle.
  parseNoise(program, nameTok) {
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
        const pattern = this.parseArgPattern();
        if (!pattern) { this.recover(); return; }
        if (pattern.kind === 'metric') {
          if (!this.bindNoiseMetric(metrics, args.length, pattern.node, pattern.tok)) return;
        } else {
          args.push(pattern.node);
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

  // A `<…>` argument pattern: mondo alternation, one element per cycle.
  // `[…]` subdivides WITHIN a cycle, which an effect argument cannot express
  // — the aggregator re-derives these once per cycle boundary — so it is
  // rejected rather than quietly behaving as alternation. Elements are plain
  // values or nested `<…>` (which advances once per visit of its parent); the
  // postfix operators do not apply here.
  parseArgPattern() {
    const open = this.next(); // '<' or '['
    if (open.value === '[') {
      this.error("effect arguments are sampled once per cycle — use '<…>' alternation, not '[…]'", open);
      return null;
    }
    const items = [];
    let kind = null; // 'metric' | 'number', taken from the leaves
    const setKind = (k, tok) => {
      if (kind && kind !== k) {
        this.error('a pattern argument cannot mix metric keywords with numbers', tok);
        return false;
      }
      kind = k;
      return true;
    };
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') { this.error("unclosed pattern argument — expected '>'", open); return null; }
      // A '$' or '#' starts the next statement, so a missing '>' stops HERE
      // rather than eating the rest of the program: without this the parser
      // consumes every following statement one token at a time, and a single
      // typo reports as a pile of unrelated errors plus a bogus "missing
      // '$ participants'". The sigil is left unconsumed for recover().
      if (t.type === 'sigil') { this.error("unclosed pattern argument — expected '>'", open); return null; }
      if (t.type === 'newline') { this.next(); continue; } // patterns may wrap lines
      if (t.type === 'punct' && t.value === '>') { this.next(); break; }
      if (t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        const inner = this.parseArgPattern();
        if (!inner) return null;
        if (inner.kind && !setKind(inner.kind, t)) return null;
        items.push(inner.node);
        continue;
      }
      if (t.type === 'number' || t.type === 'intlike') {
        this.next();
        if (!setKind('number', t)) return null;
        const val = typeof t.value === 'number' ? t.value : parseFloat(t.value);
        if (!(val > 0) || !isFinite(val)) {
          this.error('pattern argument values must be positive real numbers', t);
        }
        items.push(val);
        continue;
      }
      if (t.type === 'word' && EFFECT_METRICS.includes(t.value)) {
        this.next();
        if (!setKind('metric', t)) return null;
        items.push(t.value);
        continue;
      }
      this.error(`unexpected '${t.value ?? 'end of input'}' in a pattern argument`, t);
      this.next();
    }
    if (!items.length) { this.error('empty pattern argument', open); return null; }
    return { node: { type: 'alt', items }, kind, tok: open };
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
        this.error(`'${name}' cannot take pattern arguments — parameters are plain positive numbers`, t);
        // Skip the parenthesized blob.
        let depth = 0;
        while (!this.atEof()) {
          const p = this.next();
          if (p.type === 'punct' && p.value === '(') depth++;
          if (p.type === 'punct' && p.value === ')') { depth--; if (depth === 0) break; }
        }
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
      if (sig.takesSequence && t.type === 'punct' && (t.value === '<' || t.value === '[')) {
        const seq = this.parseSequenceGroup();
        if (seq) args.push({ value: seq, tok: t });
        continue;
      }
      break;
    }

    // Anything left on the statement that isn't the next directive is junk
    // (e.g. `# grid maybe`).
    const trailing = this.peek();
    if (trailing.type !== 'newline' && trailing.type !== 'eof' && trailing.type !== 'sigil') {
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
// One element of a `<…>` argument pattern, chosen by cycle number: element
// `cycle mod n`, with a nested group advancing once per visit of its parent
// (mondo alternation). A plain value passes straight through, so callers need
// not know whether a slot was patterned.
export function sampleArgPattern(value, cycle = 0) {
  if (!value || value.type !== 'alt') return value;
  const n = value.items.length;
  if (!n) return null;
  const c = Math.floor(Number.isFinite(cycle) ? cycle : 0);
  const item = value.items[((c % n) + n) % n];
  return (item && item.type === 'alt') ? sampleArgPattern(item, Math.floor(c / n)) : item;
}

// Resolved effect parameter objects for the chain (validation must have
// passed). Consumed by the Metaprogrammer when instantiating av-effects.
// `cycle` selects the element of any `<…>` argument pattern; effects without
// patterned arguments ignore it entirely.
export function resolveEffectParams(chainEntry, { cycle = 0 } = {}) {
  const { fn, args } = chainEntry;
  switch (fn) {
    // `# room wcl <scale> [<fixed wcl seconds>]` — decay = scale × wcl; the
    // optional second number pins wcl (0.4 = 400 ms) instead of live metrics.
    case 'room': return { metric: chainEntry.metric ?? 'wcl', scale: args[0] ?? 1, fixedWclS: args[1] ?? null };
    case 'echo': return { nSamplesFactor: args[0] ?? 1, magnitudeFeedbackFactor: args[1] ?? 0.1 };
    case 'crush': return { reductionFactor: args[0] ?? 1 };
    // `# noise [<metric>] [<spectrum factor>] [<metric>] [<volume factor>]
    // [<amount 1>] [<amount 2>]` — one slot per axis, each naming the metric
    // that modulates it, how hard, and (optionally) a value pinning that
    // metric. A factor defaults to 1 only when its metric keyword was
    // written; unwritten means 0, which is "this axis does not modulate" and
    // is what leaves a bare `# noise` at brown, 25 dB.
    case 'noise': {
      const metrics = chainEntry.metrics || [];
      const axis = (i) => {
        const metric = sampleArgPattern(metrics[i], cycle);
        const factor = sampleArgPattern(args[i], cycle);
        const fixed = sampleArgPattern(args[i + 2], cycle);
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
