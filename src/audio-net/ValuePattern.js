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
// (`# crush <wcl wcj> 2`), and the two nest freely.
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

// Read the value in force at `cyclePos`. Scalars pass straight through, so
// callers can hand it every argument without first asking whether it is one.
export function evaluateValuePattern(node, cyclePos = 0) {
  if (!isValuePattern(node)) return node;
  const terms = node.terms || [];
  if (!terms.length) return null;
  // Negative positions are real, not a caller's mistake: the scheduler emits
  // each cycle-start a lookahead EARLY, so between the event and the boundary
  // the position sits before the grid's origin and correctly still names the
  // previous cycle. Floor-mod rather than clamping, so -1 selects the last
  // element instead of indexing off the end of the array.
  const pos = Number.isFinite(cyclePos) ? cyclePos : 0;
  const cycle = Math.floor(pos);
  const phase = pos - cycle;

  if (node.mode === 'alternate') {
    const i = ((cycle % terms.length) + terms.length) % terms.length;
    // A nested sequence sees one cycle per VISIT, not per outer cycle: in
    // `<a <c d>>` the inner alternation advances on each pass of the outer
    // one, as it does in Strudel. Passing `cycle` straight down instead would
    // step the inner pattern on cycles where it is not even sounding.
    return evaluateValuePattern(terms[i], Math.floor(cycle / terms.length) + phase);
  }

  // subdivide: equal parts of one cycle. The part keeps the outer cycle
  // number (so a nested `<…>` still turns over once per cycle) and gets the
  // phase stretched across its own span.
  const n = terms.length;
  const part = Math.min(n - 1, Math.floor(phase * n));
  return evaluateValuePattern(terms[part], cycle + (phase * n - part));
}

// Render a pattern back to source text — for logs, readouts, and round-trip
// tests. Scalars stringify as themselves.
export function formatValuePattern(node) {
  if (!isValuePattern(node)) return String(node);
  const open = node.mode === 'alternate' ? '<' : '[';
  const close = node.mode === 'alternate' ? '>' : ']';
  return `${open}${(node.terms || []).map(formatValuePattern).join(' ')}${close}`;
}
