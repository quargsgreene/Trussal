// Pure scheduling core for the Metaprogrammer.
//
// Everything here is deterministic and dependency-injected (clock, timers,
// event sink) so node:test drives it with a fake clock. The browser driver
// (Metaprogrammer.js) feeds it the parsed program, worst-case metrics, and
// ClockSync network time; it emits timestamped cycle/slot events that the
// audio layer turns into gain gates and buffer replay.
//
// Determinism across browsers: cycle boundaries derive from a shared network
// epoch + the same program + the same broadcast metrics, and every random
// choice (`?`, `|`) is seeded by (cycle number, stack, position) — so all
// clients compute identical slot grids without further coordination.

import { occurrenceDraw } from './SeededRandom.js';

// --- Cycle length ------------------------------------------------------------

// Seconds per beat for a tempo directive. cpm/bpm are per-minute, cps per
// second; the metaprogram grid treats one cycle-unit as one beat.
export function beatSeconds(tempo) {
  const v = tempo && tempo.value > 0 ? tempo.value : 120;
  switch (tempo && tempo.unit) {
    case 'cps': return 1 / v;
    case 'cpm': return 60 / v;
    case 'bpm':
    default: return 60 / v;
  }
}

// WCPL is a fraction, not a duration: map full-scale (100 % loss) to 10 s so
// heavy loss stretches cycles the way heavy latency does.
export const WCPL_FULL_SCALE_S = 10;

// The minimum waiting period the timing mode demands, in seconds. A fixed
// amount on the cycles directive pins the metric there (seconds for wcl,
// loss fraction for wcpl) regardless of the live measurement — the pin only
// reaches timing, never the effects/readouts that consume metrics directly.
export function timingTargetSeconds(cycles, metrics) {
  const m = metrics || {};
  const factor = cycles && cycles.factor > 0 ? cycles.factor : 1;
  const fixed = cycles && cycles.fixed > 0 ? cycles.fixed : null;
  switch (cycles && cycles.metric) {
    case 'wcpl': return (fixed ?? (m.wcpl || 0)) * WCPL_FULL_SCALE_S * factor;
    case 'wcl':
    default: return (fixed ?? (m.wcl || 0) / 1000) * factor;
  }
}

// Smallest whole number of beats covering (≥) the waiting period — "minimum
// waiting period prioritized over hitting buffer scheduling deadlines" —
// never below one beat. ≥ rather than strictly-exceeding so a pinned target
// landing exactly on the beat grid stays exact (`# cycles wcl 10 0.3` at
// 120 bpm is 3 s, not 3.5); the epsilon absorbs float noise in that division.
export function cycleLength({ cycles, tempo, metrics }) {
  const beatS = beatSeconds(tempo);
  const targetS = timingTargetSeconds(cycles, metrics);
  const beats = Math.max(1, Math.ceil(targetS / beatS - 1e-9));
  return { beats, seconds: beats * beatS, beatSeconds: beatS };
}

// One-line description of a cycle-length calculation, for logging: the length
// actually scheduled, the directive and metric value that produced it, and the
// beat grid it was quantized onto. Pure, so a UI readout can use it too.
export function describeCycleLength({ cycles, tempo, metrics }) {
  const { beats, seconds, beatSeconds: beatS } = cycleLength({ cycles, tempo, metrics });
  const metric = (cycles && cycles.metric) || 'wcl';
  const factor = cycles && cycles.factor > 0 ? cycles.factor : 1;
  const fixed = cycles && cycles.fixed > 0 ? cycles.fixed : null;
  const targetS = timingTargetSeconds(cycles, metrics);
  const source = fixed != null
    ? `# cycles "${metric}" ${factor} ${fixed} (pinned)`
    : `# cycles "${metric}" ${factor}`;
  const m = metrics || {};
  return `${seconds.toFixed(3)}s [${beats} beat(s) @ ${beatS.toFixed(3)}s] ← ${source} ` +
    `target ${targetS.toFixed(3)}s (wcl ${(m.wcl || 0).toFixed(1)}ms, ` +
    `wcpl ${((m.wcpl || 0) * 100).toFixed(1)}%)`;
}

// --- Cycle expansion -----------------------------------------------------------
//
// Every element/sequence modifier is resolved by one model: a sequence node
// owns a TIMELINE measured in its own units, and a cycle shows a WINDOW of it.
//
//   - `@n` gives an entry n units of room instead of 1, and `!n` replicates it
//     into n independent one-unit entries. What a unit is worth is the mode:
//     one repetition of a `[…]` subdivision is 1 unit long (so `[0@2 1]` gives
//     0 two thirds of the cycle), while one repetition of a `<…>` alternation
//     is `totalWeight` units long and a cycle covers 1 (so `<0@2 1>` holds the
//     ring on 0 for two whole cycles).
//   - `*n` / `/n` / `%n` set the RATE: how many of those units pass per cycle.
//     `*2` packs two turns into a cycle, halving each; `/2` stretches one turn
//     across two cycles. They compose (`*4/2` is ×2).
//
// So cycle c shows [c·rate, c·rate + rate), and any occurrence overlapping it
// is emitted CLIPPED to the cycle. Clipping — rather than gating on the
// occurrence's onset the way Strudel's `slow` does — is what makes a stretched
// turn continuous: `<0@2 1>` streams participant 0 for the whole of both its
// cycles rather than falling silent for the second.

const EPS = 1e-9;

// Backstop on expansion WORK: each stack gets this many occurrence visits per
// cycle, then the cycle is truncated. Rates are clamped (below) so a flat
// sequence can't reach this, but nesting multiplies — `[<0 1>*1024]*1024` still
// has to stop somewhere, and the scheduler's tick is the loop that keeps the
// room streaming.
export const MAX_EXPANSION_STEPS = 1024;

// Bounds on how fast or slow a sequence may be read. A rate is user input, and
// unclamped it does not degrade gracefully in either direction: `*1000000000`
// drives every span below EPS and `/1000000000` puts the whole window there, so
// BOTH emit nothing at all, for ever, from a program that parses without a
// single error. Silence with no diagnostic is the failure this codebase has
// paid for repeatedly. Clamped, each still means what it says — pack turns in
// until they are a millisecond long, or hold one turn for a thousand cycles.
const MAX_RATE = MAX_EXPANSION_STEPS;

function clampRate(rate) {
  if (!(rate > 0) || !isFinite(rate)) return 1;
  return Math.min(MAX_RATE, Math.max(1 / MAX_RATE, rate));
}

function modValue(el, op, dflt) {
  const m = ((el && el.modifiers) || []).find(x => x.op === op);
  return m ? m.value : dflt;
}

// The `*` / `/` multiplier on a node, unclamped — callers clamp once they have
// folded in `%`, which can push the product back out of range either way.
function rateScale(node) {
  let scale = 1;
  for (const m of (node && node.modifiers) || []) {
    if (m.op === '*') scale *= m.value;
    else if (m.op === '/') scale /= m.value;
  }
  return (scale > 0 && isFinite(scale)) ? scale : 1;
}

// One repetition of a sequence, laid out on its own timeline: `!` replicated,
// `@` weighted, positions in units. Returns null for a sequence with nothing
// to place (which emits silence rather than dividing by zero).
function layoutRepetition(elements, mode) {
  const entries = [];
  let totalWeight = 0;
  for (const el of elements || []) {
    if (!el) continue;
    const repeats = Math.max(1, Math.round(modValue(el, '!', 1)));
    const weight = modValue(el, '@', 1);
    if (!(weight > 0) || !isFinite(weight)) continue;
    for (let replica = 0; replica < repeats; replica++) {
      entries.push({ el, replica, start: totalWeight, end: totalWeight + weight });
      totalWeight += weight;
    }
  }
  if (!(totalWeight > 0)) return null;
  // Subdividing packs the whole repetition into one unit; alternating spends
  // one unit per weight, which is what turns `@` from a share of a cycle into
  // a number of cycles.
  const repLength = mode === 'subdivide' ? 1 : totalWeight;
  const unitsPerStep = repLength / totalWeight;
  for (const entry of entries) {
    entry.start *= unitsPerStep;
    entry.end *= unitsPerStep;
  }
  return { entries, repLength, unitsPerStep };
}

// Units of this node's own timeline per cycle: how fast the room reads it.
// `%n` states the step count outright, so it is resolved against the layout;
// `*` and `/` then scale whatever that came to.
function rateOf(node, layout) {
  const steps = ((node && node.modifiers) || []).find(m => m.op === '%');
  const base = steps && steps.value > 0 ? steps.value * layout.unitsPerStep : 1;
  return clampRate(base * rateScale(node));
}

// --- Deterministic per-occurrence draws ---------------------------------------
//
// `?` and `|` must decide identically on every client, and — because an
// occurrence widened by `@` or `/` is clipped across several cycles — must
// decide ONCE for the whole occurrence rather than re-flipping at each cycle
// boundary. Seeding by (stack, node, repetition, replica) does both: the seed
// names the occurrence, not the cycle it is being viewed through. The draw
// itself is the room's shared one (SeededRandom.js), which patterned `#` effect
// arguments read from as well.

function occurrenceRandom(ctx, entry, rep, salt) {
  return occurrenceDraw(ctx.stack, ctx.nodeIds.get(entry.el) ?? 0, rep, entry.replica, salt);
}

// `?` drops the occurrence — it becomes a REST, so the slot is silent and the
// cycle advances regardless. A synthesized rest rather than nothing: the
// aggregator reads open-but-empty time as a deliberate rest and keeps its own
// output path (and so the `# room` tail) running, where an absent slot would
// instead let its pacing fallback fill the gap with a participant. The node is
// fresh, so it is in no index map and addresses no `~` in the source.
// `|` picks one of its branches. Both are per-occurrence.
function resolveEntry(ctx, entry, rep) {
  const el = entry.el;
  const q = (el.modifiers || []).find(m => m.op === '?');
  if (q && occurrenceRandom(ctx, entry, rep, 1) < (q.value == null ? 0.5 : q.value)) return { type: 'rest' };
  if (el.type === 'choice') {
    const options = el.options || [];
    if (!options.length) return null;
    const pick = Math.floor(occurrenceRandom(ctx, entry, rep, 2) * options.length) % options.length;
    return { type: 'run', elements: options[pick] };
  }
  return el;
}

// --- Emission ------------------------------------------------------------------

// A token carrying its own rate repeats inside its slot (`0*2` → two
// half-length turns) or holds it unbroken (`0/2`).
function emitParticipant(ctx, el, start, span, phaseCycle) {
  const rate = clampRate(rateScale(el));
  if (Math.abs(rate - 1) <= EPS) {
    ctx.events.push({ token: el.token, start, dur: span, stack: ctx.stack, index: ctx.written.get(el) ?? null });
    return;
  }
  const w0 = phaseCycle * rate;
  const w1 = w0 + rate;
  const scale = span / rate;
  const last = Math.ceil(w1 - EPS) - 1;
  for (let rep = Math.floor(w0 + EPS); rep <= last; rep++) {
    if (ctx.budget-- <= 0) return;
    const lo = Math.max(rep, w0);
    const hi = Math.min(rep + 1, w1);
    if (!(hi - lo > EPS)) continue;
    ctx.events.push({
      token: el.token, start: start + (lo - w0) * scale, dur: (hi - lo) * scale,
      stack: ctx.stack, index: ctx.written.get(el) ?? null
    });
  }
}

// Emit `node` occupying [start, start+span) of the cycle. `phaseCycle` is how
// many times the ENCLOSING sequence has come round, so a nested `<…>` advances
// once per visit rather than once per cycle of the room.
function emitNode(ctx, node, start, span, phaseCycle) {
  if (!node || !(span > EPS)) return;
  if (node.type === 'rest') {
    // A rest is a slot like any other — it just has nobody in it. Emitting it
    // (rather than letting time advance silently) is what lets a consumer say
    // "resting HERE": the aggregator outlines the rest in the shared editor and
    // streams no participant for its span, while its own output path — and so
    // the `# room` reverb tail — keeps running. `token: null` marks it; nothing
    // downstream schedules audio for a slot with no token. `index` addresses the
    // rest's own space, and is null for a rest the program did not WRITE (a `0?`
    // this occurrence's draw degraded), which has no glyph to outline.
    ctx.events.push({
      token: null, rest: true, start, dur: span,
      stack: ctx.stack, index: ctx.rests?.get(node) ?? null
    });
    return;
  }
  if (node.type === 'participant') { emitParticipant(ctx, node, start, span, phaseCycle); return; }
  if (node.type === 'run') { emitSequence(ctx, node, node.elements, 'subdivide', start, span, phaseCycle); return; }
  if (node.type === 'sequence') {
    // A nested `,` stack overlays the same span rather than splitting it.
    for (const st of node.stacks || []) emitSequence(ctx, node, st.elements, node.mode, start, span, phaseCycle);
  }
}

// Show the window of `elements` that cycle `phaseCycle` reveals, across
// [start, start+span).
function emitSequence(ctx, node, elements, mode, start, span, phaseCycle) {
  const layout = layoutRepetition(elements, mode);
  if (!layout) return;
  const { entries, repLength } = layout;
  const rate = rateOf(node, layout);
  const w0 = phaseCycle * rate;
  const w1 = w0 + rate;
  const scale = span / rate;
  const lastRep = Math.ceil((w1 - EPS) / repLength) - 1;
  for (let rep = Math.floor((w0 + EPS) / repLength); rep <= lastRep; rep++) {
    const base = rep * repLength;
    for (const entry of entries) {
      if (ctx.budget-- <= 0) return;
      const lo = Math.max(base + entry.start, w0);
      const hi = Math.min(base + entry.end, w1);
      if (!(hi - lo > EPS)) continue;
      // Children are phased by the repetition they sit in, so `<0 <1 2>>`
      // alternates the inner pair across VISITS (0 1 0 2), not across cycles.
      emitNode(ctx, resolveEntry(ctx, entry, rep), start + (lo - w0) * scale, (hi - lo) * scale, rep);
    }
  }
}

// Stable identity for every node in the program. `nodeIds` numbers them all so
// a seed can name one occurrence; `written` numbers the participant tokens
// alone, pre-order, matching how the editor's highlighter scans the source text
// (depth-first, every branch of a `|` choice — see participantPositions in
// components/MetaprogrammerCycleHighlighter.js). The latter is emitted on each
// slot event as `index` so a consumer can tell WHICH occurrence is playing: in
// `$ participants <0 1 0>` the two `0`s are different slots.
//
// `rests` numbers the REST elements (`~`, `_`, `-`) in their OWN space rather
// than sharing the participants' numbering, so a rest slot can say WHICH rest
// is resting — `<0 ~ 1 ~>` has two, and the editor outlines the one in force.
//
// Separate numbering on purpose. The browser bundle and the bot image deploy
// independently, so the two sides are routinely a version apart; folding rests
// into `written` would renumber every participant after the first rest and a
// skewed pair would outline the wrong token. With two spaces an older
// highlighter simply never draws a rest (rest slots carry `token: null`, which
// it already treats as "nothing to outline") and participant outlines stay
// correct in every combination.
//
// Version skew degrades, but a rest highlight still needs all THREE hops
// deployed — the aggregator emits it, the SIDECAR relays it (an older
// latency-instrument rebuilds the jp-active message field by field and drops
// `kind`), and the bundle draws it. New bots alone show no rests anywhere.
function indexNodes(participants) {
  const nodeIds = new Map();
  const written = new Map();
  const rests = new Map();
  let nextNode = 0, nextWritten = 0, nextRest = 0;
  const walk = (els) => {
    for (const el of els || []) {
      if (!el) continue;
      nodeIds.set(el, nextNode++);
      if (el.type === 'participant') written.set(el, nextWritten++);
      else if (el.type === 'rest') rests.set(el, nextRest++);
      else if (el.type === 'choice') (el.options || []).forEach(walk);
      else if (el.type === 'sequence') (el.stacks || []).forEach(st => walk(st.elements));
    }
  };
  ((participants && participants.stacks) || []).forEach(st => walk(st.elements));
  return { nodeIds, written, rests };
}

// Expand one cycle of the participants sequence into slot events with
// fractional [start, dur) within the cycle. Stacked sequences (`,`) run
// concurrently, each reading the sequence as of `cycleNumber − cycleOffset`
// (the spec's one-cycle offset); a stack whose offset predates the epoch is
// silent that cycle.
export function expandCycle(participants, cycleNumber) {
  const events = [];
  if (!participants || !Array.isArray(participants.stacks)) return events;
  const { nodeIds, written, rests } = indexNodes(participants);

  participants.stacks.forEach((stack, k) => {
    const effCycle = cycleNumber - (stack.cycleOffset || 0);
    if (effCycle < 0) return;
    // One budget per stack, shared down the recursion by reference, so a
    // pathological rate in one stack cannot starve the others.
    emitSequence(
      { events, nodeIds, written, rests, stack: k, budget: MAX_EXPANSION_STEPS },
      participants, stack.elements, participants.mode, 0, 1, effCycle
    );
  });
  events.sort((a, b) => a.start - b.start || a.stack - b.stack);
  return events;
}

// --- AV buffer queues -----------------------------------------------------------

// Bounded FIFO per performer. Entries are AV objects: { audio, video,
// messages, status, pattern, bytes, t }. Bounds come from the health
// monitor's memory constraints; when full, the oldest buffer is evicted so a
// performer who never gets a slot can't grow without bound (deadlock/OOM
// prevention). dequeue() on empty returns null — the slot plays silence and
// the cycle advances regardless.

//This AVBufferQueue class is not getting used, DO NOT use this or anything for which it is currently a dependency
export class AVBufferQueue {
  constructor({ maxBuffers = 8, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.maxBuffers = maxBuffers;
    this.maxBytes = maxBytes;
    this._items = [];
    this._bytes = 0;
    this.evicted = 0;
  }

  get length() { return this._items.length; }
  get bytes() { return this._bytes; }

  enqueue(av) {
    const entry = av || {};
    const bytes = typeof entry.bytes === 'number' && entry.bytes >= 0 ? entry.bytes : 0;
    this._items.push(entry);
    this._bytes += bytes;
    while (this._items.length > this.maxBuffers || (this._bytes > this.maxBytes && this._items.length > 1)) {
      const dropped = this._items.shift();
      this._bytes -= (typeof dropped.bytes === 'number' ? dropped.bytes : 0);
      this.evicted++;
    }
    return entry;
  }

  dequeue() {
    const entry = this._items.shift() || null;
    if (entry) this._bytes -= (typeof entry.bytes === 'number' ? entry.bytes : 0);
    return entry;
  }

  peek() { return this._items[0] || null; }
  clear() { this._items = []; this._bytes = 0; }
}

// --- Scheduler --------------------------------------------------------------------

// Emits timestamped events ahead of time (lookahead window) so the audio
// layer can schedule sample-accurately:
//   { type: 'cycle-start', cycle, t, seconds, beats }
//   { type: 'slot-open',  id, token, index, rest, t, dur, cycle, stack }
//   { type: 'slot-close', id, token, index, rest, t, cycle, stack }
// A REST slot is `token: null, rest: true` with `index` in the rest index
// space; every other slot names a participant.
// Program and metrics changes land at the next cycle boundary — mid-cycle
// slots are never yanked.
//
// The aggregator PACES its rotation off the slot events (see
// bots/src/bot/aggregator-bot.js #serveFromScheduler), so `id` and `index`
// are load-bearing, not decoration: see the emit site in tick().

// How far the next cycle boundary may sit from the clock before the grid is
// treated as stranded rather than merely early/late — whichever of these is
// larger. Ordinary lateness is a tick interval; this is orders above that.
const GRID_REANCHOR_CYCLES = 4;
const GRID_REANCHOR_MIN_S = 10;
// Seconds of network time between "still this length" cycle-length log lines
// when nothing changed. Changes always print immediately.
const CYCLE_LOG_HEARTBEAT_S = 30;
// Scheduled boundaries retained for getCyclePosition(), as a floor rather
// than a cap: the lookahead schedules as many boundaries ahead of the clock
// as fit in it, so a fast grid (a high `# tempo`, where a cycle is a fraction
// of the lookahead) can hold a dozen future entries. Trimming to a fixed
// count would throw away the entry containing NOW and leave every value
// pattern frozen on its first element, so the trim also requires a later
// entry to have started — see the push site in tick().
const GRID_HISTORY = 4;

export class MetaprogramScheduler {
  constructor({
    now,                       // () → seconds (network time)
    onEvent,                   // (event) → void
    lookaheadS = 0.2,
    tickMs = 50,
    label = 'jpattern',       // tags this scheduler's log lines (browser vs aggregator)
    log = null,                // (line) => void; null = console.log, false = silent
    setIntervalFn = (typeof setInterval !== 'undefined' ? setInterval : null),
    clearIntervalFn = (typeof clearInterval !== 'undefined' ? clearInterval : null)
  }) {
    if (typeof now !== 'function' || typeof onEvent !== 'function') {
      throw new TypeError('MetaprogramScheduler needs now() and onEvent()');
    }
    this._now = now;
    this._emit = onEvent;
    this._lookaheadS = lookaheadS;
    this._tickMs = tickMs;
    this._label = label;
    this._log = log === false ? () => {} : (log || ((line) => console.log(line)));
    this._loggedSeconds = null;   // last cycle length printed
    this._loggedAtT = null;       // network time of that print
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;

    this._ast = null;
    this._pendingAst = null;
    this._metrics = { wcl: 0, wcpl: 0 };
    this._pendingMetrics = null;

    this._running = false;
    this._timer = null;
    this._cycle = 0;
    this._nextCycleStart = null;
    this._grid = [];              // recent { cycle, t0, seconds }, newest last
  }

  setProgram(ast) {
    if (!ast || !ast.participants) return false;
    if (!this._running || this._ast == null) this._ast = ast;
    else this._pendingAst = ast; // swap at the next boundary
    return true;
  }

  setMetrics(wc) {
    if (!wc) return;
    if (!this._running) this._metrics = { ...this._metrics, ...wc };
    else this._pendingMetrics = { ...(this._pendingMetrics || this._metrics), ...wc };
  }

  getProgram() { return this._ast; }
  getCycle() { return this._cycle; }

  /**
   * Whether the grid is currently tracking the clock: running, programmed, and
   * with its next boundary within the same tolerance _reanchorIfAdrift uses.
   *
   * A consumer pacing off slot events needs this to tell a genuine REST (no
   * slot open, healthy grid) from a STALLED grid (no slot open because the
   * schedule has parted company with the clock). Those look identical from the
   * outside — an empty lookahead window either way — and confusing them is
   * what turned a stranded grid into an endless silence.
   */
  isGridHealthy() {
    if (!this._running || !this._ast || this._nextCycleStart == null) return false;
    const { seconds } = cycleLength({
      cycles: this._ast.cycles, tempo: this._ast.tempo, metrics: this._metrics
    });
    const tolerance = Math.max(GRID_REANCHOR_MIN_S, seconds * GRID_REANCHOR_CYCLES);
    return Math.abs(this._nextCycleStart - this._now()) <= tolerance;
  }

  // The cycle length in force right now — what the last boundary scheduled,
  // not what a pending metrics/program change will produce at the next one.
  // null before a program is set. The aggregator's turn length is this value.
  getCycleLength() {
    if (!this._ast) return null;
    return cycleLength({ cycles: this._ast.cycles, tempo: this._ast.tempo, metrics: this._metrics });
  }

  /**
   * Where `t` sits on the cycle grid, in fractional cycles: 2.5 is halfway
   * through cycle 2. null until a cycle has been scheduled at or before `t`.
   *
   * Read off the boundaries actually EMITTED rather than computed as
   * (t - epoch) / cycleLength, because cycle length moves with the metrics —
   * dividing by the current length would renumber every past cycle each time
   * the network changed, and anything paced off the position (patterned
   * effect arguments) would jump rather than advance. Cycles are scheduled up
   * to a lookahead ahead of the clock, so the newest entry can still be in
   * the future; walk back to the one that has actually begun.
   */
  getCyclePosition(t = this._now()) {
    for (let i = this._grid.length - 1; i >= 0; i--) {
      const g = this._grid[i];
      if (t >= g.t0) return g.cycle + Math.max(0, Math.min(1, (t - g.t0) / g.seconds));
    }
    return null;
  }

  start(epoch = this._now()) {
    if (this._running) return;
    this._running = true;
    this._cycle = 0;
    this._nextCycleStart = epoch;
    this._grid = [];
    if (this._setInterval) {
      this._timer = this._setInterval(() => this.tick(), this._tickMs);
    }
    this.tick();
  }

  stop() {
    this._running = false;
    if (this._timer && this._clearInterval) this._clearInterval(this._timer);
    this._timer = null;
    // A stopped grid has no position: without this the last boundary stays
    // readable for ever and getCyclePosition() keeps answering (clamped to
    // the end of that cycle) off a grid that is no longer advancing.
    this._grid = [];
  }

  // Advance the schedule up to now + lookahead. Safe to call manually (tests)
  // or from the interval timer.
  tick() {
    if (!this._running || !this._ast) return;
    const now = this._now();
    this._reanchorIfAdrift(now);
    const horizon = now + this._lookaheadS;
    while (this._nextCycleStart <= horizon) {
      // Boundary: apply pending program/metrics before computing the cycle.
      if (this._pendingAst) { this._ast = this._pendingAst; this._pendingAst = null; }
      if (this._pendingMetrics) { this._metrics = this._pendingMetrics; this._pendingMetrics = null; }

      const spec = {
        cycles: this._ast.cycles,
        tempo: this._ast.tempo,
        metrics: this._metrics
      };
      const { beats, seconds } = cycleLength(spec);
      const t0 = this._nextCycleStart;
      this._logCycleLength(spec, seconds, t0);
      // Keep a short tail of scheduled boundaries so getCyclePosition() can
      // find the cycle containing a given instant. Only ever drop a boundary
      // that a LATER one has already superseded (`_grid[1]` has begun) — a
      // count alone would discard the current cycle whenever the lookahead
      // holds more future boundaries than the cap.
      this._grid.push({ cycle: this._cycle, t0, seconds });
      while (this._grid.length > GRID_HISTORY && this._grid[1].t0 <= now) this._grid.shift();
      this._emit({ type: 'cycle-start', cycle: this._cycle, t: t0, seconds, beats });

      // open/close share one `id` so a consumer pacing off these events can
      // pair them without guessing: (cycle, stack, token) is not unique — a
      // token may occupy several slots in one cycle.
      expandCycle(this._ast.participants, this._cycle).forEach((ev, i) => {
        const t = t0 + ev.start * seconds;
        const dur = ev.dur * seconds;
        const slot = {
          id: `${this._cycle}:${ev.stack}:${i}`,
          token: ev.token, cycle: this._cycle, stack: ev.stack, index: ev.index,
          // Rest slots carry `token: null`; `rest` says the emptiness is the
          // program's intent rather than an absent participant, and `index`
          // then addresses the rest's own index space (see indexNodes).
          rest: ev.rest === true
        };
        this._emit({ ...slot, type: 'slot-open', t, dur });
        this._emit({ ...slot, type: 'slot-close', t: t + dur });
      });

      this._nextCycleStart = t0 + seconds;
      this._cycle++;
    }
  }

  /**
   * Snap the grid back onto the clock when the two have parted company.
   *
   * The clock this scheduler reads is not guaranteed continuous: ClockSync
   * converging swaps a local estimate for the relay's reference, and the
   * relay's reference is process.hrtime since the SIDECAR started, so a
   * sidecar restart moves it backwards past everything already scheduled.
   * Both leave `_nextCycleStart` stranded:
   *
   *   - far in the FUTURE — the loop below never runs, no cycle is ever
   *     emitted again, and anything pacing off these events goes silent for
   *     ever. This silenced a live room.
   *   - far in the PAST — the loop would grind out every missed cycle one at a
   *     time. Nobody heard them and nobody can now; at a large enough gap that
   *     is a hang rather than a catch-up.
   *
   * Either way the honest response is the same: give up on the old anchor and
   * start a fresh cycle at `now`. Tolerance scales with cycle length so a slow
   * grid isn't re-anchored by ordinary lateness, with a floor for fast ones.
   */
  _reanchorIfAdrift(now) {
    if (this._nextCycleStart == null) return;
    const { seconds } = cycleLength({
      cycles: this._ast.cycles, tempo: this._ast.tempo, metrics: this._metrics
    });
    const tolerance = Math.max(GRID_REANCHOR_MIN_S, seconds * GRID_REANCHOR_CYCLES);
    const gap = this._nextCycleStart - now;
    if (Math.abs(gap) <= tolerance) return;
    this._log(`[${this._label}] cycle grid re-anchored: next boundary was ` +
      `${gap.toFixed(1)}s ${gap > 0 ? 'ahead of' : 'behind'} the clock ` +
      `(tolerance ${tolerance.toFixed(1)}s) — the clock moved, not the music`);
    this._nextCycleStart = now;
    // The retained boundaries were stamped on the clock we just gave up on;
    // a backwards jump would leave getCyclePosition() reading a position off
    // the abandoned grid. Start the history fresh with the anchor.
    this._grid = [];
  }

  // Print the cycle length this boundary is actually scheduling — which is
  // also the length of each performer's turn. Every change is printed (that is
  // the signal: cycle length tracks the network), plus a heartbeat so a value
  // that never moves is still visibly being recomputed rather than merely
  // absent from the log.
  _logCycleLength(spec, seconds, t0) {
    const changed = this._loggedSeconds == null || Math.abs(seconds - this._loggedSeconds) > 1e-6;
    const stale = this._loggedAtT == null || (t0 - this._loggedAtT) >= CYCLE_LOG_HEARTBEAT_S;
    if (!changed && !stale) return;
    const from = changed && this._loggedSeconds != null
      ? ` (was ${this._loggedSeconds.toFixed(3)}s)` : '';
    const tag = changed ? 'cycle length' : 'cycle length steady';
    this._loggedSeconds = seconds;
    this._loggedAtT = t0;
    this._log(`[${this._label}] ${tag} @ cycle ${this._cycle}: ${describeCycleLength(spec)}${from}`);
  }
}
