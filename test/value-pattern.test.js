import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateValuePattern, isValuePattern, formatValuePattern,
  entryHasValuePattern, chainHasValuePattern, isDataRefNode, setDataRefReader
} from '../src/audio-net/ValuePattern.js';
import { parseMetaprogram } from './helpers/metaprogram.js';

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
  const pattern = alt(1, 2, 3);
  assert.equal(evaluateValuePattern(pattern, 0), 1);
  assert.equal(evaluateValuePattern(pattern, 1), 2);
  assert.equal(evaluateValuePattern(pattern, 2), 3);
  assert.equal(evaluateValuePattern(pattern, 3), 1);
  // Constant across the cycle: the value turns over on the boundary only.
  assert.equal(evaluateValuePattern(pattern, 1.0), 2);
  assert.equal(evaluateValuePattern(pattern, 1.99), 2);
});

test('[] splits one cycle into equal parts', () => {
  const pattern = sub('a', 'b', 'c', 'd');
  assert.equal(evaluateValuePattern(pattern, 0), 'a');
  assert.equal(evaluateValuePattern(pattern, 0.25), 'b');
  assert.equal(evaluateValuePattern(pattern, 0.5), 'c');
  assert.equal(evaluateValuePattern(pattern, 0.999), 'd');
  assert.equal(evaluateValuePattern(pattern, 5.25), 'b', 'same split every cycle');
});

test('nesting: an inner <> advances per VISIT inside <>, per cycle inside []', () => {
  // <a <b c>> — the inner alternation turns over each time it is reached,
  // i.e. on cycles 1, 3, 5 …
  const outer = alt('a', alt('b', 'c'));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(cycle => evaluateValuePattern(outer, cycle)),
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

test('*n / /n scale the rate the sequence is read at', () => {
  // <a b>*2 — both elements inside one cycle.
  const fast = { ...alt('a', 'b'), speed: 2 };
  assert.deepEqual([0, 0.25, 0.5, 0.75, 1].map(cyclePos => evaluateValuePattern(fast, cyclePos)),
    ['a', 'a', 'b', 'b', 'a']);
  // <a b>/2 — each element held for two cycles.
  const slow = { ...alt('a', 'b'), speed: 0.5 };
  assert.deepEqual([0, 1, 2, 3, 4].map(cyclePos => evaluateValuePattern(slow, cyclePos)),
    ['a', 'a', 'b', 'b', 'a']);
  // [a b]*2 — the subdivision repeats twice per cycle.
  const chopped = { ...sub('a', 'b'), speed: 2 };
  assert.deepEqual([0, 0.25, 0.5, 0.75].map(cyclePos => evaluateValuePattern(chopped, cyclePos)),
    ['a', 'b', 'a', 'b']);
  // A nested group applies its own on top of its parent's position.
  const nested = alt('a', { ...sub('b', 'c'), speed: 2 });
  assert.deepEqual([1, 1.25, 1.5, 1.75].map(cyclePos => evaluateValuePattern(nested, cyclePos)),
    ['b', 'c', 'b', 'c']);
  // A missing or unusable rate is 1, not a division by zero.
  assert.equal(evaluateValuePattern({ ...alt('a', 'b'), speed: 0 }, 1), 'b');
  assert.equal(evaluateValuePattern({ ...alt('a', 'b'), speed: NaN }, 1), 'b');
});

test('@n weights an element: cycles in an alternation, a share of one in a subdivision', () => {
  // <a@2 b> — a holds two whole cycles, unbroken across the boundary, exactly
  // as `<0@2 1>` holds the ring in a participants sequence.
  const held = { ...alt('a', 'b'), weights: [2, 1] };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(cycle => evaluateValuePattern(held, cycle)),
    ['a', 'a', 'b', 'a', 'a', 'b', 'a']);

  // [a@2 b] — a takes two thirds of ONE cycle.
  const shared = { ...sub('a', 'b'), weights: [2, 1] };
  assert.deepEqual([0, 0.3, 0.6, 0.7, 0.99].map(cyclePos => evaluateValuePattern(shared, cyclePos)),
    ['a', 'a', 'a', 'b', 'b']);

  // A widened element holds ONE value across its whole span: the nested
  // alternation advances per visit of its parent, not per cycle it covers.
  const nested = { ...alt(alt('a', 'b'), 'c'), weights: [2, 1] };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(cycle => evaluateValuePattern(nested, cycle)),
    ['a', 'a', 'c', 'b', 'b', 'c', 'a', 'a', 'c']);

  // Weights compose with a rate, and an all-1 weights array changes nothing.
  // At 2 units a cycle the 3-unit repetition takes 1.5 cycles, so a's two
  // units run to cyclePos 1 and the whole thing comes round again at 1.5.
  assert.deepEqual([0, 0.5, 1, 1.4, 1.5].map(cyclePos => evaluateValuePattern({ ...held, speed: 2 }, cyclePos)),
    ['a', 'a', 'b', 'b', 'a']);
  assert.deepEqual([0, 1, 2].map(cycle => evaluateValuePattern({ ...alt('a', 'b', 'c'), weights: [1, 1, 1] }, cycle)),
    ['a', 'b', 'c']);
  // A weightless sequence is unreadable rather than a division by zero.
  assert.equal(evaluateValuePattern({ ...alt('a', 'b'), weights: [0, 0] }, 0), 'a',
    'a non-positive weight falls back to 1 rather than vanishing');
});

test('?p drops an element identically on every client, once per occurrence', () => {
  const maybe = { ...alt('a', 'b'), chances: [0.5, null], line: 2, col: 13 };
  const at = (cycle) => evaluateValuePattern(maybe, cycle);

  // Pure: the same position gives the same answer for ever, so every client
  // and the aggregator drop and keep exactly the same elements.
  const first = [...Array(64).keys()].map(at);
  assert.deepEqual([...Array(64).keys()].map(at), first, 'the draw is a function of position alone');
  // A node at a different source position draws differently — two `?` in one
  // program must not move in lockstep.
  const elsewhere = { ...maybe, col: 20 };
  const other = [...Array(64).keys()].map(cycle => evaluateValuePattern(elsewhere, cycle));
  assert.notDeepEqual(other, first);
  // The undropped element is never touched.
  assert.ok([...Array(32).keys()].every(rep => at(rep * 2 + 1) === 'b'));

  // A dropped element reads as a rest, and the rate honours the probability.
  const measuredDropRate = (chance) => {
    const node = { ...alt('a', 'b'), chances: [chance, null], line: 2, col: 13 };
    const draws = 20000;
    let drops = 0;
    for (let cycle = 0; cycle < draws; cycle++) if (evaluateValuePattern(node, cycle * 2) === null) drops++;
    return drops / draws;
  };
  for (const chance of [0.25, 0.5, 0.9]) {
    assert.ok(Math.abs(measuredDropRate(chance) - chance) < 0.02, `drop rate ~${chance}`);
  }

  // Seeded per OCCURRENCE, not per cycle: an element widened by `@` decides
  // once for its whole span instead of flickering at each boundary.
  const widened = { ...alt('a', 'b'), weights: [2, 1], chances: [0.5, null], line: 2, col: 13 };
  for (let rep = 0; rep < 40; rep++) {
    const firstCycle = rep * 3;
    assert.equal(evaluateValuePattern(widened, firstCycle), evaluateValuePattern(widened, firstCycle + 1),
      `repetition ${rep} decided as a whole`);
  }
});

test("an element's own rate reads its content that many times inside its span", () => {
  // <[a b]*2 c> — the group runs twice over the span cycle 0 gives it, which
  // is the value analogue of `1*2` splitting participant 1's turn in two.
  const split = { ...alt(sub('a', 'b'), 'c'), rates: [2, 1] };
  assert.deepEqual([0, 0.25, 0.5, 0.75].map(cyclePos => evaluateValuePattern(split, cyclePos)),
    ['a', 'b', 'a', 'b']);
  assert.equal(evaluateValuePattern(split, 1), 'c', 'the rate stays inside the element');

  // /n stretches the same way: the group takes two visits to get through.
  const stretched = { ...alt(alt('a', 'b'), 'c'), rates: [0.5, 1] };
  assert.deepEqual([0, 2, 4, 6].map(cycle => evaluateValuePattern(stretched, cycle)),
    ['a', 'a', 'b', 'b']);

  // On a constant leaf it is inert — the same value twice running is that
  // value — so it neither changes the reading nor errors.
  assert.deepEqual([0, 1, 2].map(cycle => evaluateValuePattern({ ...alt('a', 'b'), rates: [4, 1] }, cycle)),
    ['a', 'b', 'a']);
  // A missing or unusable rate is 1.
  assert.equal(evaluateValuePattern({ ...alt(alt('a', 'b'), 'c'), rates: [0, 1] }, 0), 'a');
});

test('a rest leaf reads as null — no value for that span', () => {
  const pattern = alt(1, null, 2);
  assert.deepEqual([0, 1, 2].map(cycle => evaluateValuePattern(pattern, cycle)), [1, null, 2]);
  // Rests nest and survive a rate like any other leaf.
  assert.equal(evaluateValuePattern({ ...sub(1, null), speed: 2 }, 0.25), null);
});

test('a missing or nonsensical cycle position reads the first element', () => {
  const pattern = alt(1, 2);
  assert.equal(evaluateValuePattern(pattern), 1);
  assert.equal(evaluateValuePattern(pattern, null), 1);
  assert.equal(evaluateValuePattern(pattern, NaN), 1);
  assert.equal(evaluateValuePattern({ type: 'valueSeq', mode: 'alternate', terms: [] }, 3), null);
});

test('a position before the epoch keeps counting backwards rather than clamping', () => {
  // Negative positions are produced deliberately: the scheduler emits each
  // cycle-start a lookahead EARLY, so between the event and the boundary the
  // position sits before the grid's origin and still names the previous cycle
  // (see cyclePosition in Metaprogrammer.js, which leaves the arithmetic
  // unclamped on the understanding that consumers floor-mod). Clamping to the
  // first element would make every argument misread for that whole window.
  const pattern = alt(1, 2);
  assert.equal(evaluateValuePattern(pattern, -1), 2, 'the cycle before 0 is the last element');
  assert.equal(evaluateValuePattern(pattern, -2), 1);
  assert.equal(evaluateValuePattern(pattern, -5), 2);
  // …and it stays continuous across the boundary rather than jumping.
  assert.equal(evaluateValuePattern(pattern, -0.25), 2, 'still in cycle -1');
  assert.equal(evaluateValuePattern(pattern, 0.25), 1, 'now in cycle 0');
});

test('chains report whether anything in them needs a per-cycle re-read', () => {
  const chainOf = (text) => parseMetaprogram(text).ast.chain;
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# crush "wcl" 2\n')), false);
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# crush "wcl" <2 4>\n')), true);
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# crush <"wcl" "wcpl"> 2\n')), true,
    'a patterned metric counts too');
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# room "wcl" 2\n# noise\n')), false);
  assert.equal(chainHasValuePattern([]), false);
  assert.equal(entryHasValuePattern(null), false);
});

test('patterns round-trip back to source text', () => {
  assert.equal(formatValuePattern(alt(2, 4)), '<2 4>');
  assert.equal(formatValuePattern(sub(2, alt(4, 8))), '[2 <4 8>]');
  assert.equal(formatValuePattern(3), '3');
  assert.equal(formatValuePattern(alt(1, null, 2)), '<1 ~ 2>');
  // `*n` and `/n` fold into one multiplier at parse time, so both come back
  // out as the `*` form.
  assert.equal(formatValuePattern({ ...alt(1, 2), speed: 2 }), '<1 2>*2');
  assert.equal(formatValuePattern({ ...alt(1, 2), speed: 0.5 }), '<1 2>*0.5');
});

test('room, crush and echo report a patterned argument; a rate alone is not one', () => {
  const chainOf = (text) => parseMetaprogram(text).ast.chain;
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# room <"wcl" "wcpl"> <1 2 ~ 2 3>*2\n')), true);
  assert.equal(chainHasValuePattern(chainOf('$ participants <0>\n# room "wcl" 2 [0.1 0.4]\n')), true,
    'a patterned pinned amount counts');
});

// ---------------------------------------------------------------------------
// Data-pack references
// ---------------------------------------------------------------------------

test('a data reference reads its column against the cycle grid', () => {
  const ref = { type: 'dataRef', name: 'Weather', index: 3 };
  assert.equal(isValuePattern(ref), true, 'counts as patterned: re-derived per cycle');
  assert.equal(isDataRefNode(ref), true);

  // No reader installed yet: a reference reads as a rest, never a wrong number.
  assert.equal(evaluateValuePattern(ref, 0), null);

  setDataRefReader((text, cycle) => {
    assert.equal(text, 'Weather:3');
    const values = [10, 20, 30, 40];
    const phase = ((cycle % 1) + 1) % 1;
    return values[Math.floor(phase * values.length)];
  });
  try {
    assert.equal(evaluateValuePattern(ref, 0), 10);
    assert.equal(evaluateValuePattern(ref, 0.25), 20);
    assert.equal(evaluateValuePattern(ref, 0.75), 40);
    assert.equal(evaluateValuePattern(ref, 5.5), 30, 'the same every cycle');
  } finally {
    setDataRefReader(null);
  }
});

test('a non-numeric reading is a rest rather than a bad parameter', () => {
  setDataRefReader(() => 'c4');
  try {
    assert.equal(evaluateValuePattern({ type: 'dataRef', name: 'W', index: 1 }, 0), null);
  } finally {
    setDataRefReader(null);
  }
});

test('a data reference composes inside a sequence and round-trips', () => {
  const ref = { type: 'dataRef', name: 'Weather', index: 3 };
  assert.equal(formatValuePattern(ref), 'Weather:3');
  assert.equal(formatValuePattern(alt(ref, 5)), '<Weather:3 5>');

  setDataRefReader(() => 7);
  try {
    // Cycle 0 takes the reference, cycle 1 the literal.
    assert.equal(evaluateValuePattern(alt(ref, 5), 0), 7);
    assert.equal(evaluateValuePattern(alt(ref, 5), 1), 5);
  } finally {
    setDataRefReader(null);
  }
});
