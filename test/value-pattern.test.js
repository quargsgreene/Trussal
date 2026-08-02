import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateValuePattern, isValuePattern, formatValuePattern,
  entryHasValuePattern, chainHasValuePattern
} from '../src/audio-net/ValuePattern.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';

const alt = (...terms) => ({ type: 'valueSeq', mode: 'alternate', terms });
const sub = (...terms) => ({ type: 'valueSeq', mode: 'subdivide', terms });

test('scalars pass straight through', () => {
  assert.equal(evaluateValuePattern(2, 7), 2);
  assert.equal(evaluateValuePattern('wcl', 7), 'wcl');
  assert.equal(evaluateValuePattern(null, 7), null);
  assert.equal(isValuePattern(2), false);
  assert.equal(isValuePattern(alt(1, 2)), true);
});

test('<> advances one element per cycle and wraps', () => {
  const p = alt(1, 2, 3);
  assert.equal(evaluateValuePattern(p, 0), 1);
  assert.equal(evaluateValuePattern(p, 1), 2);
  assert.equal(evaluateValuePattern(p, 2), 3);
  assert.equal(evaluateValuePattern(p, 3), 1);
  // Constant across the cycle: the value turns over on the boundary only.
  assert.equal(evaluateValuePattern(p, 1.0), 2);
  assert.equal(evaluateValuePattern(p, 1.99), 2);
});

test('[] splits one cycle into equal parts', () => {
  const p = sub('a', 'b', 'c', 'd');
  assert.equal(evaluateValuePattern(p, 0), 'a');
  assert.equal(evaluateValuePattern(p, 0.25), 'b');
  assert.equal(evaluateValuePattern(p, 0.5), 'c');
  assert.equal(evaluateValuePattern(p, 0.999), 'd');
  assert.equal(evaluateValuePattern(p, 5.25), 'b', 'same split every cycle');
});

test('nesting: an inner <> advances per VISIT inside <>, per cycle inside []', () => {
  // <a <b c>> — the inner alternation turns over each time it is reached,
  // i.e. on cycles 1, 3, 5 …
  const outer = alt('a', alt('b', 'c'));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(c => evaluateValuePattern(outer, c)),
    ['a', 'b', 'a', 'c', 'a', 'b']);

  // [a <b c>] — the inner sits in the second half of every cycle and turns
  // over once per cycle.
  const inSub = sub('a', alt('b', 'c'));
  assert.equal(evaluateValuePattern(inSub, 0.0), 'a');
  assert.equal(evaluateValuePattern(inSub, 0.5), 'b');
  assert.equal(evaluateValuePattern(inSub, 1.5), 'c');
  assert.equal(evaluateValuePattern(inSub, 2.5), 'b');

  // <[a b] c> — the subdivision splits the cycle it lands on.
  const subInAlt = alt(sub('a', 'b'), 'c');
  assert.equal(evaluateValuePattern(subInAlt, 0), 'a');
  assert.equal(evaluateValuePattern(subInAlt, 0.5), 'b');
  assert.equal(evaluateValuePattern(subInAlt, 1.5), 'c');
});

test('a missing or nonsensical cycle position reads the first element', () => {
  const p = alt(1, 2);
  assert.equal(evaluateValuePattern(p), 1);
  assert.equal(evaluateValuePattern(p, null), 1);
  assert.equal(evaluateValuePattern(p, NaN), 1);
  assert.equal(evaluateValuePattern({ type: 'valueSeq', mode: 'alternate', terms: [] }, 3), null);
});

test('a position before the epoch keeps counting backwards rather than clamping', () => {
  // Negative positions are produced deliberately: the scheduler emits each
  // cycle-start a lookahead EARLY, so between the event and the boundary the
  // position sits before the grid's origin and still names the previous cycle
  // (see cyclePosition in Metaprogrammer.js, which leaves the arithmetic
  // unclamped on the understanding that consumers floor-mod). Clamping to the
  // first element would make every argument misread for that whole window.
  const p = alt(1, 2);
  assert.equal(evaluateValuePattern(p, -1), 2, 'the cycle before 0 is the last element');
  assert.equal(evaluateValuePattern(p, -2), 1);
  assert.equal(evaluateValuePattern(p, -5), 2);
  // …and it stays continuous across the boundary rather than jumping.
  assert.equal(evaluateValuePattern(p, -0.25), 2, 'still in cycle -1');
  assert.equal(evaluateValuePattern(p, 0.25), 1, 'now in cycle 0');
});

test('chains report whether anything in them needs a per-cycle re-read', () => {
  const chainOf = (text) => parseMetaprogram(text).ast.chain;
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# crush wcl 2\n')), false);
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# crush wcl <2 4>\n')), true);
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# crush <wcl wcj> 2\n')), true,
    'a patterned metric counts too');
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# room wcl 2\n# noise\n')), false);
  assert.equal(chainHasValuePattern([]), false);
  assert.equal(entryHasValuePattern(null), false);
});

test('patterns round-trip back to source text', () => {
  assert.equal(formatValuePattern(alt(2, 4)), '<2 4>');
  assert.equal(formatValuePattern(sub(2, alt(4, 8))), '[2 <4 8>]');
  assert.equal(formatValuePattern(3), '3');
});
