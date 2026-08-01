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

// Emit events for `resolved` occupying [start, start+span) of the cycle.
function emitInto(events, resolved, start, span, cycleForNesting, stack, rng) {
  if (resolved.type === 'participant') {
    events.push({ token: resolved.token, start, dur: span, stack });
    return;
  }
  if (resolved.type === 'rest') return; // rests advance time silently
  if (resolved.type === 'run') {
    subdivideInto(events, resolved.elements, start, span, cycleForNesting, stack, rng);
    return;
  }
  if (resolved.type === 'sequence') {
    // Nested group: subdivide groups split their span; alternate groups pick
    // one member per enclosing cycle.
    if (resolved.mode === 'subdivide') {
      const speed = Math.max(1, Math.round(modValue(resolved, '*', 1)));
      for (let r = 0; r < speed; r++) {
        for (const st of resolved.stacks) {
          subdivideInto(events, st.elements, start + (span / speed) * r, span / speed, cycleForNesting, stack, rng);
        }
      }
    } else {
      for (const st of resolved.stacks) {
        const entries = weightedEntries(st.elements);
        if (!entries.length) continue;
        const pick = entries[((cycleForNesting % entries.length) + entries.length) % entries.length];
        const { resolved: r2 } = resolveEntry(pick, rng);
        emitInto(events, r2, start, span, cycleForNesting, stack, rng);
      }
    }
  }
}

function subdivideInto(events, elements, start, span, cycle, stack, rng) {
  const entries = weightedEntries(elements);
  const totalW = entries.reduce((a, e) => a + e.weight, 0);
  if (!(totalW > 0)) return;
  let cursor = start;
  for (const entry of entries) {
    const w = (entry.weight / totalW) * span;
    const { resolved } = resolveEntry(entry, rng);
    emitInto(events, resolved, cursor, w, cycle, stack, rng);
    cursor += w;
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

  participants.stacks.forEach((stack, k) => {
    const effCycle = cycleNumber - (stack.cycleOffset || 0);
    if (effCycle < 0) return;
    const rng = seededRandom((effCycle * 7919 + k * 104729 + 1) >>> 0);

    if (participants.mode === 'subdivide') {
      for (let r = 0; r < seqSpeed; r++) {
        subdivideInto(events, stack.elements, r / seqSpeed, 1 / seqSpeed, effCycle, k, rng);
      }
    } else {
      // alternate: `speed` consecutive entries per cycle, each 1/speed wide.
      const entries = weightedEntries(stack.elements);
      if (!entries.length) return;
      for (let j = 0; j < seqSpeed; j++) {
        const idx = (effCycle * seqSpeed + j) % entries.length;
        const { resolved } = resolveEntry(entries[idx], rng);
        emitInto(events, resolved, j / seqSpeed, 1 / seqSpeed, effCycle, k, rng);
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
//   { type: 'slot-open',  token, t, dur, cycle, stack }
//   { type: 'slot-close', token, t, cycle, stack }
// Program and metrics changes land at the next cycle boundary — mid-cycle
// slots are never yanked.
// How far the next cycle boundary may sit from the clock before the grid is
// treated as stranded rather than merely early/late — whichever of these is
// larger. Ordinary lateness is a tick interval; this is orders above that.
const GRID_REANCHOR_CYCLES = 4;
const GRID_REANCHOR_MIN_S = 10;

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

      const { beats, seconds } = cycleLength({
        cycles: this._ast.cycles,
        tempo: this._ast.tempo,
        metrics: this._metrics
      });
      const t0 = this._nextCycleStart;
      this._emit({ type: 'cycle-start', cycle: this._cycle, t: t0, seconds, beats });

      for (const ev of expandCycle(this._ast.participants, this._cycle)) {
        const t = t0 + ev.start * seconds;
        const dur = ev.dur * seconds;
        this._emit({ type: 'slot-open', token: ev.token, t, dur, cycle: this._cycle, stack: ev.stack });
        this._emit({ type: 'slot-close', token: ev.token, t: t + dur, cycle: this._cycle, stack: ev.stack });
      }

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
}
