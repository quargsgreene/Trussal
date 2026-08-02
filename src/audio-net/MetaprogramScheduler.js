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
// amount on the cycles directive pins the metric there (seconds for wcl/wcj,
// loss fraction for wcpl) regardless of the live measurement — the pin only
// reaches timing, never the effects/readouts that consume metrics directly.
export function timingTargetSeconds(cycles, metrics) {
  const m = metrics || {};
  const factor = cycles && cycles.factor > 0 ? cycles.factor : 1;
  const fixed = cycles && cycles.fixed > 0 ? cycles.fixed : null;
  switch (cycles && cycles.metric) {
    case 'wcj': return (fixed ?? (m.wcj || 0) / 1000) * factor;
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
    ? `# cycles ${metric} ${factor} ${fixed} (pinned)`
    : `# cycles ${metric} ${factor}`;
  const m = metrics || {};
  return `${seconds.toFixed(3)}s [${beats} beat(s) @ ${beatS.toFixed(3)}s] ← ${source} ` +
    `target ${targetS.toFixed(3)}s (wcl ${(m.wcl || 0).toFixed(1)}ms, wcj ${(m.wcj || 0).toFixed(1)}ms, ` +
    `wcrtt ${(m.wcrtt || 0).toFixed(1)}ms, wcpl ${((m.wcpl || 0) * 100).toFixed(1)}%)`;
}

// --- Deterministic RNG --------------------------------------------------------

// mulberry32 — tiny, good-enough, identical everywhere.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Cycle expansion -----------------------------------------------------------

function modValue(el, op, dflt) {
  const m = (el.modifiers || []).find(x => x.op === op);
  return m ? m.value : dflt;
}

// Flatten a run of elements into weighted entries, applying `!` replication.
function weightedEntries(elements) {
  const out = [];
  for (const el of elements) {
    const repeats = Math.max(1, Math.round(modValue(el, '!', 1)));
    const weight = modValue(el, '@', 1);
    for (let r = 0; r < repeats; r++) out.push({ el, weight });
  }
  return out;
}

// Resolve `?` (probabilistic rest) and `|` choices deterministically.
function resolveEntry(entry, rng) {
  const el = entry.el;
  if (el.type === 'choice') {
    const pick = el.options[Math.floor(rng() * el.options.length) % el.options.length] || [];
    return { resolved: { type: 'run', elements: pick }, weight: entry.weight };
  }
  const q = (el.modifiers || []).find(m => m.op === '?');
  if (q) {
    const p = q.value == null ? 0.5 : q.value;
    if (rng() < p) return { resolved: { type: 'rest' }, weight: entry.weight };
  }
  return { resolved: el, weight: entry.weight };
}

// Pre-order index of every participant element in the program, matching how
// the editor's highlighter scans the source text (depth-first, every branch of
// a `|` choice, repeats included — see participantPositions in
// components/MetaprogrammerCycleHighlighter.js). Emitted on each slot event as
// `index` so a consumer can tell WHICH occurrence is playing: in
// `$ participants <0 1 0>` the two `0`s are different slots.
function writtenIndices(participants) {
  return preOrderIndices(participants, 'participant');
}

// The same pre-order scan over REST elements (`~`, `_`, `-`), in their OWN
// index space rather than sharing the participants' numbering. Rests get an
// index so a rest slot can say WHICH rest is resting — `<0 ~ 1 ~>` has two, and
// the editor outlines the one actually in force.
//
// Separate numbering on purpose. The browser bundle and the bot image deploy
// independently, so the two sides are routinely a version apart; folding rests
// into `writtenIndices` would renumber every participant after the first rest
// and a skewed pair would outline the wrong token. With two spaces an older
// highlighter simply never draws a rest (rest slots carry `token: null`, which
// it already treats as "nothing to outline") and participant outlines stay
// correct in every combination.
//
// Version skew degrades, but a rest highlight still needs all THREE hops
// deployed — the aggregator emits it, the SIDECAR relays it (an older
// latency-instrument rebuilds the nc-active message field by field and drops
// `kind`), and the bundle draws it. New bots alone show no rests anywhere.
function restIndices(participants) {
  return preOrderIndices(participants, 'rest');
}

// Depth-first index of every element of `type` in the program (every branch of
// a `|` choice, repeats included), matching how the editor's highlighter scans
// the source text — see participantPositions/restPositions in
// components/MetaprogrammerCycleHighlighter.js.
function preOrderIndices(participants, type) {
  const map = new Map();
  let next = 0;
  const walk = (els) => {
    for (const el of els || []) {
      if (!el) continue;
      if (el.type === type) map.set(el, next++);
      else if (el.type === 'choice') (el.options || []).forEach(walk);
      else if (el.type === 'sequence') (el.stacks || []).forEach(st => walk(st.elements));
    }
  };
  ((participants && participants.stacks) || []).forEach(st => walk(st.elements));
  return map;
}

// Emit events for `resolved` occupying [start, start+span) of the cycle.
// `ctx` is { events, indices, restIndices, rng } — one per stack, since the RNG
// is seeded per (cycle, stack). A missing index map costs a null index, never a
// throw, so a partially-built ctx degrades to "unaddressable" rather than
// taking the expansion down.
function emitInto(ctx, resolved, start, span, cycleForNesting, stack) {
  if (resolved.type === 'participant') {
    ctx.events.push({
      token: resolved.token, start, dur: span, stack,
      index: ctx.indices.get(resolved) ?? null
    });
    return;
  }
  if (resolved.type === 'rest') {
    // A rest is a slot like any other — it just has nobody in it. Emitting it
    // (rather than letting time advance silently, as this did) is what lets a
    // consumer say "resting HERE": the aggregator outlines the rest in the
    // shared editor and streams no participant into the master for its span,
    // while its own output path — and so the `# room` reverb tail — keeps
    // running. `token: null` marks it; nothing downstream schedules audio for a
    // slot with no token.
    //
    // `index` is null for a rest the program did not WRITE — a `0?` that this
    // cycle's RNG resolved to a rest (resolveEntry synthesizes that one, so it
    // is in no index map). There is no rest glyph in the source to outline, so
    // the editor draws nothing, exactly as before.
    ctx.events.push({
      token: null, rest: true, start, dur: span, stack,
      index: ctx.restIndices?.get(resolved) ?? null
    });
    return;
  }
  if (resolved.type === 'run') {
    subdivideInto(ctx, resolved.elements, start, span, cycleForNesting, stack);
    return;
  }
  if (resolved.type === 'sequence') {
    // Nested group: subdivide groups split their span; alternate groups pick
    // one member per enclosing cycle.
    if (resolved.mode === 'subdivide') {
      const speed = Math.max(1, Math.round(modValue(resolved, '*', 1)));
      for (let r = 0; r < speed; r++) {
        for (const st of resolved.stacks) {
          subdivideInto(ctx, st.elements, start + (span / speed) * r, span / speed, cycleForNesting, stack);
        }
      }
    } else {
      for (const st of resolved.stacks) {
        const entries = weightedEntries(st.elements);
        if (!entries.length) continue;
        const pick = entries[((cycleForNesting % entries.length) + entries.length) % entries.length];
        const { resolved: r2 } = resolveEntry(pick, ctx.rng);
        emitInto(ctx, r2, start, span, cycleForNesting, stack);
      }
    }
  }
}

// Lay `elements` out across [start, start+span), each taking a share of the
// span proportional to its `@` weight.
function subdivideInto(ctx, elements, start, span, cycle, stack) {
  const entries = weightedEntries(elements);
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(totalWeight > 0)) return;
  let cursor = start;
  for (const entry of entries) {
    const entrySpan = (entry.weight / totalWeight) * span;
    const { resolved } = resolveEntry(entry, ctx.rng);
    emitInto(ctx, resolved, cursor, entrySpan, cycle, stack);
    cursor += entrySpan;
  }
}

// Expand one cycle of the participants sequence into slot events with
// fractional [start, dur) within the cycle. Stacked sequences (`,`) run
// concurrently, each reading the sequence as of `cycleNumber − cycleOffset`
// (the spec's one-cycle offset); a stack whose offset predates the epoch is
// silent that cycle.
export function expandCycle(participants, cycleNumber) {
  const events = [];
  if (!participants || !Array.isArray(participants.stacks)) return events;
  const seqSpeed = Math.max(1, Math.round(modValue(participants, '*', 1)));
  const indices = writtenIndices(participants);
  const rests = restIndices(participants);

  participants.stacks.forEach((stack, k) => {
    const effCycle = cycleNumber - (stack.cycleOffset || 0);
    if (effCycle < 0) return;
    const ctx = {
      events, indices, restIndices: rests,
      rng: seededRandom((effCycle * 7919 + k * 104729 + 1) >>> 0)
    };

    if (participants.mode === 'subdivide') {
      for (let r = 0; r < seqSpeed; r++) {
        subdivideInto(ctx, stack.elements, r / seqSpeed, 1 / seqSpeed, effCycle, k);
      }
    } else {
      // alternate: `speed` consecutive entries per cycle, each 1/speed wide.
      const entries = weightedEntries(stack.elements);
      if (!entries.length) return;
      for (let j = 0; j < seqSpeed; j++) {
        const idx = (effCycle * seqSpeed + j) % entries.length;
        const { resolved } = resolveEntry(entries[idx], ctx.rng);
        emitInto(ctx, resolved, j / seqSpeed, 1 / seqSpeed, effCycle, k);
      }
    }
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

export class MetaprogramScheduler {
  constructor({
    now,                       // () → seconds (network time)
    onEvent,                   // (event) → void
    lookaheadS = 0.2,
    tickMs = 50,
    label = 'netcycles',       // tags this scheduler's log lines (browser vs aggregator)
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
    this._metrics = { wcl: 0, wcj: 0, wcrtt: 0, wcpl: 0 };
    this._pendingMetrics = null;

    this._running = false;
    this._timer = null;
    this._cycle = 0;
    this._nextCycleStart = null;
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

  start(epoch = this._now()) {
    if (this._running) return;
    this._running = true;
    this._cycle = 0;
    this._nextCycleStart = epoch;
    if (this._setInterval) {
      this._timer = this._setInterval(() => this.tick(), this._tickMs);
    }
    this.tick();
  }

  stop() {
    this._running = false;
    if (this._timer && this._clearInterval) this._clearInterval(this._timer);
    this._timer = null;
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
          // then addresses the rest's own index space (see restIndices).
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
