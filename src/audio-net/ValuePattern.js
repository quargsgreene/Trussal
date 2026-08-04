// Value patterns: mini-notation-valued arguments for `#` effect directives.
//
// `# crush wcl <2 4>` gives the scale factor a value per cycle instead of one
// for the whole program. The parser turns each `<…>` / `[…]` argument into a
// `valueSeq` node; this module reads one back at a point on the cycle grid:
//
//   <a b>   alternate — one element per cycle
//   [a b]   subdivide — the cycle split into equal parts
//
// Leaves are numbers (a scale factor, a pinned metric amount) or metric words
// (`# crush <wcl wcj> 2`), and the two nest freely. A leaf may also be a REST
// (`~`), which is `null` here: no value for that span, so the parameter falls
// back to whatever default its effect uses for a missing one.
//
// The modifiers a value pattern takes are the ones that make sense for a
// parameter, and they are read on the same model MetaprogramScheduler uses for
// a `$ participants` sequence — a node owns a TIMELINE in its own units, and a
// cycle shows a window of it:
//
//   <a b>*2   RATE — units per cycle. `*2` reads the sequence twice as fast
//   [a b]/2   (both elements inside one cycle), `/2` half as fast. The parser
//             folds a composed rate into one `speed` multiplier.
//   <a@2 b>   WEIGHT — a takes 2 units instead of 1, held as ONE value across
//   [a@2 b]   the whole span. What a unit is worth is the mode: subdividing
//             packs the repetition into one cycle (`[a@2 b]` gives a two
//             thirds of it), while alternating spends one cycle per unit
//             (`<a@2 b>` holds a for two whole cycles). Stored parallel to
//             `terms` in `weights`.
//   <a? b>    CHANCE — a is dropped with probability 0.5 (or `?p`), reading as
//             a rest for that occurrence. Stored parallel in `chances`.
//   <a!3 b>   REPEAT — a is taken three times in a row, as three INDEPENDENT
//             elements (so each draws its own `?`), where `a@3` would be one
//             element of triple width. Expanded into repeated terms at parse
//             time, so nothing here has to know about it.
//   <a*2 b>   ELEMENT RATE — a's own content is read twice inside its span.
//             Stored parallel in `rates`. Observable when a is a group
//             (`<[c d]*2 b>` reads c d twice over); on a constant leaf the
//             same value twice running is that value, so it reads as inert
//             rather than as an error.
//
// The draw is SEEDED, never Math.random(): by the pattern's source position,
// the element's index in it, and which repetition of the sequence this is. So
// every client — and the aggregator — drops and keeps exactly the same
// elements at the same instants, and an element widened by `@` or `/` decides
// once for its whole span instead of flickering at each cycle boundary. That
// is the same guarantee, from the same generator (SeededRandom.js), that the
// scheduler gives `?` on a participant turn.
//
// `cyclePos` is fractional cycles since the scheduler's epoch: 2.5 is halfway
// through cycle 2. Reading a pattern is pure — same position, same value
// everywhere — so a pattern is exactly as agreed across the room as the cycle
// GRID it is read against, and no more. That is a real caveat rather than a
// formality: MetaprogramScheduler counts cycles in a per-instance counter that
// start() zeroes and _reanchorIfAdrift does NOT re-derive, so a client whose
// clock re-anchored (or that joined late and adopted the shared epoch from the
// past) is on its own cycle NUMBER. Such a client already schedules different
// participants for `$ participants <0 1>`; patterned effect arguments inherit
// that, they do not add to it.
//
// Pure module: no DOM, no WebAudio, so it runs in the bundle, in bots, and
// under node:test.

import { occurrenceDraw } from './SeededRandom.js';

export function isValuePattern(node) {
  return !!node && typeof node === 'object' && node.type === 'valueSeq';
}

// True when any argument of this chain entry is patterned — the caller needs
// to know whether params must be re-derived as the cycle advances, or only
// when metrics change.
//
// Every argument shape counts, since a directive uses one of them: the
// positional `args` (with `metric` in front) that `# crush` and `# room` take,
// the metric/scale `pairs` plus `bounds` that `# echo` takes, and the two
// interleaved `metrics` that `# noise` takes.
export function entryHasValuePattern(entry) {
  if (!entry) return false;
  const candidates = [
    entry.metric,
    ...(entry.metrics || []),
    ...(entry.args || []),
    ...(entry.pairs || []).map(p => p && p.value),
    ...(entry.bounds || [])
  ];
  return candidates.some(isValuePattern);
}

export function chainHasValuePattern(chainEntries) {
  return (chainEntries || []).some(entryHasValuePattern);
}

// Probability a bare `?` drops its element, matching the participants grammar.
export const DEFAULT_DROP_CHANCE = 0.5;

// One repetition of a sequence laid out on its own timeline, in units. Mirrors
// MetaprogramScheduler's layoutRepetition: subdividing packs the repetition
// into ONE unit (so a weight is a share of a cycle), while alternating spends
// one unit per weight (so a weight is a number of cycles). With no weights
// written this is the equal split it has always been — n spans of 1 unit for
// an alternation, of 1/n for a subdivision.
//
// Returns null for a sequence with no placeable weight, which reads as "no
// value" rather than dividing by zero.
function layout(node) {
  const terms = node.terms || [];
  const weights = node.weights;
  const spans = [];
  let totalWeight = 0;
  for (let i = 0; i < terms.length; i++) {
    const written = weights ? weights[i] : null;
    const weight = (Number.isFinite(written) && written > 0) ? written : 1;
    spans.push({ index: i, start: totalWeight, end: totalWeight + weight });
    totalWeight += weight;
  }
  if (!(totalWeight > 0)) return null;
  const repLength = node.mode === 'subdivide' ? 1 : totalWeight;
  const unitsPerStep = repLength / totalWeight;
  for (const span of spans) {
    span.start *= unitsPerStep;
    span.end *= unitsPerStep;
  }
  return { spans, repLength };
}

// Read the value in force at `cyclePos`. Scalars pass straight through, so
// callers can hand it every argument without first asking whether it is one.
export function evaluateValuePattern(node, cyclePos = 0) {
  if (!isValuePattern(node)) return node;
  const terms = node.terms || [];
  if (!terms.length) return null;
  const grid = layout(node);
  if (!grid) return null;

  // Negative positions are real, not a caller's mistake: the scheduler emits
  // each cycle-start a lookahead EARLY, so between the event and the boundary
  // the position sits before the grid's origin and correctly still names the
  // previous cycle. Floor-mod rather than clamping, so -1 selects the last
  // element instead of indexing off the end of the array.
  const raw = Number.isFinite(cyclePos) ? cyclePos : 0;
  // The rate scales the position this node reads, which is all `*n` / `/n`
  // mean: `<a b>*2` is the same sequence against a grid running twice as fast.
  // Nested groups apply their own on the way down, so `<a [b c]*2>` compounds.
  const speed = (Number.isFinite(node.speed) && node.speed > 0) ? node.speed : 1;
  const units = raw * speed;

  // Which repetition of the sequence this is, and how far into it we are.
  // `rep` is what NAMES the occurrence — it does not change while a widened
  // element is still in force, which is what makes one `?` draw cover the
  // whole span rather than re-flipping every cycle.
  const rep = Math.floor(units / grid.repLength);
  const offset = units - rep * grid.repLength;
  let span = grid.spans[grid.spans.length - 1];
  for (const candidate of grid.spans) {
    if (offset < candidate.end) { span = candidate; break; }
  }

  const chance = node.chances ? node.chances[span.index] : null;
  if (Number.isFinite(chance) && occurrenceDraw(node.line | 0, node.col | 0, span.index, rep) < chance) {
    return null; // dropped for this occurrence — reads as a rest
  }

  // A nested sequence sees one cycle per VISIT of its parent, not one per
  // outer cycle: in `<a <c d>>` the inner alternation advances on each pass of
  // the outer one, as it does in mondo. Passing the outer cycle straight down
  // would step the inner pattern on cycles where it is not even sounding.
  // Inside a `[…]` the repetition IS the cycle, so `rep` carries the cycle
  // number and a nested `<…>` still turns over once per cycle.
  //
  // An element's own `*n` / `/n` scales that: `<[a b]*2 c>` reads the group
  // twice inside its span. On a constant leaf it changes nothing — the same
  // value twice in a row is that value — so it is accepted and inert there,
  // rather than an error a performer would hit moving a line over from a
  // participants sequence.
  const width = span.end - span.start;
  const rate = node.rates ? node.rates[span.index] : null;
  const elementRate = (Number.isFinite(rate) && rate > 0) ? rate : 1;
  return evaluateValuePattern(terms[span.index], (rep + (offset - span.start) / width) * elementRate);
}

// Render a pattern back to source text — for logs, readouts, and round-trip
// tests. Scalars stringify as themselves; a rest is written the way it was.
export function formatValuePattern(node) {
  if (node == null) return '~';
  if (!isValuePattern(node)) return String(node);
  const open = node.mode === 'alternate' ? '<' : '[';
  const close = node.mode === 'alternate' ? '>' : ']';
  // `*n` and `/n` fold into one multiplier at parse time, so both come back
  // out as the `*` form — `<a b>/2` round-trips as `<a b>*0.5`, which reads
  // the same sequence at the same rate.
  const rate = (Number.isFinite(node.speed) && node.speed !== 1) ? `*${node.speed}` : '';
  // `!` is expanded into repeated terms at parse time, so it comes back out as
  // those repeats rather than as the count that was written.
  const terms = (node.terms || []).map((term, i) => {
    const weight = node.weights ? node.weights[i] : null;
    const chance = node.chances ? node.chances[i] : null;
    const rate = node.rates ? node.rates[i] : null;
    return formatValuePattern(term)
      + (Number.isFinite(weight) && weight !== 1 ? `@${weight}` : '')
      + (Number.isFinite(chance) ? `?${chance}` : '')
      + (Number.isFinite(rate) && rate !== 1 ? `*${rate}` : '');
  });
  return `${open}${terms.join(' ')}${close}${rate}`;
}
