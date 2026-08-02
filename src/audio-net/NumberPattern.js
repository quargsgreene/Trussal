// Numeric patterns for `#` directive arguments: `<2 3 0.5>` alternates one
// value per cycle, `[1 4]` subdivides the cycle, and the two nest. Same two
// brackets the `$ participants` sequence uses, but the leaves here are plain
// numbers rather than participant tokens — hence a separate tiny evaluator
// instead of a detour through expandCycle(), whose elements carry ownership,
// suffixes and per-element modifiers that a scale factor has no use for.
//
// Sampling is a pure function of CYCLE POSITION (cycles elapsed since the
// grid's epoch, fractional), so two clients sampling the same program at the
// same network time get the same number. That is the same determinism rule the
// scheduler grid and the metric-derived effect parameters already follow —
// without it a patterned scale factor would make each browser's audio differ.
//
// Pure module: no DOM, no WebAudio, so it runs in the bundle, in bots, and
// under node:test alike.

export function isNumberPattern(v) {
  return !!v && typeof v === 'object' && v.type === 'numseq' && Array.isArray(v.values);
}

// Floor-mod. Cycle position runs NEGATIVE for the fraction of a cycle before
// the grid's first boundary — the scheduler emits each cycle-start a lookahead
// early, so `now` sits before the boundary it just announced — and -1 % 3 must
// select the last element rather than index off the end of the array.
function wrap(i, n) { return ((i % n) + n) % n; }

// The value in force at `cyclePos`. Plain numbers pass straight through, so
// callers never have to ask which kind of argument they hold.
export function sampleNumberPattern(node, cyclePos = 0) {
  if (typeof node === 'number') return node;
  if (!isNumberPattern(node) || node.values.length === 0) return null;
  const values = node.values;
  const pos = Number.isFinite(cyclePos) ? cyclePos : 0;

  if (node.mode === 'alternate') {
    // One element per cycle, and the chosen element spans that whole cycle —
    // so it is sampled at the same position, letting a nested [a b] subdivide
    // the cycle it is active in.
    return sampleNumberPattern(values[wrap(Math.floor(pos), values.length)], pos);
  }

  // Subdivide: n equal steps across the current cycle. The step's own span is
  // remapped back onto [cycle, cycle + 1) so nesting composes — and a nested
  // <a b> still alternates per OUTER cycle, since the remap leaves the floor
  // untouched.
  const cycle = Math.floor(pos);
  const scaled = (pos - cycle) * values.length;
  const i = Math.min(values.length - 1, Math.floor(scaled));
  return sampleNumberPattern(values[i], cycle + (scaled - i));
}
