import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fnv1a32,
  hashUnitInterval,
  orderTokens,
  weightedRingSlots,
  nextOwner,
  ringDisruption,
  positionDisruption,
  rejoinRestoresSlot,
  jainFairness,
} from '../src/audio-net/TurnRing.js';

// --- hash primitives ---------------------------------------------------------

test('fnv1a32 is deterministic and 32-bit unsigned', () => {
  assert.equal(fnv1a32('trussal 0'), fnv1a32('trussal 0'));
  const h = fnv1a32('trussal 0');
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
  assert.notEqual(fnv1a32('trussal 0'), fnv1a32('trussal 1'));
});

test('the seed/token separator stops boundary collisions', () => {
  // "ab" + "c"  vs  "a" + "bc" would collide without the separator
  assert.notEqual(hashUnitInterval('ab', 'c'), hashUnitInterval('a', 'bc'));
  assert.notEqual(hashUnitInterval('room1', '0'), hashUnitInterval('room10', ''));
});

test('hashUnitInterval stays strictly inside (0, 1)', () => {
  for (const token of ['0', '1', '2', '15', '0a', '3b', 'pi']) {
    const u = hashUnitInterval('room-xyz', token);
    assert.ok(u > 0 && u < 1, `${token} -> ${u}`);
  }
});

// --- ordering: determinism + total order ------------------------------------

test('orderTokens is a deterministic permutation of the input set', () => {
  const tokens = ['0', '1', '2', '3', '4', '0a', '1b'];
  const a = orderTokens(tokens, { seed: 'r1' });
  const b = orderTokens([...tokens].reverse(), { seed: 'r1' });
  assert.deepEqual(a, b, 'order is independent of input order');
  assert.deepEqual([...a].sort(), [...tokens].sort(), 'every token present exactly once');
});

test('orderTokens dedupes and stringifies', () => {
  assert.deepEqual(
    orderTokens([0, 0, '0', 1, 1], { seed: 'r' }).sort(),
    ['0', '1'],
  );
});

test('a different seed generally yields a different order', () => {
  const tokens = ['0', '1', '2', '3', '4', '5', '6', '7'];
  assert.notDeepEqual(
    orderTokens(tokens, { seed: 'A' }),
    orderTokens(tokens, { seed: 'B' }),
  );
});

// --- the property that matters: minimal disruption under churn -------------

test('removing one token leaves every other token in the same relative order', () => {
  const seed = 'churn-room';
  const full = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const before = orderTokens(full, { seed });
  for (const dropped of full) {
    const after = orderTokens(full.filter((t) => t !== dropped), { seed });
    assert.deepEqual(after, before.filter((t) => t !== dropped),
      `dropping ${dropped} reshuffled the survivors`);
    assert.equal(ringDisruption(before, after), 0,
      `dropping ${dropped} reported non-zero disruption`);
  }
});

test('adding one token inserts it without moving the incumbents', () => {
  const seed = 'grow-room';
  const base = ['0', '1', '2', '3', '4', '5'];
  const before = orderTokens(base, { seed });
  const after = orderTokens([...base, '6'], { seed });
  assert.deepEqual(after.filter((t) => t !== '6'), before);
});

test('successor disruption: a pure shift preserves successors (0); a re-sort does not', () => {
  const before = ['0', '1', '2', '3', '4', '5', '6', '7'];
  // '0' leaves, everyone slides down a slot — who-follows-whom is unchanged
  assert.equal(ringDisruption(before, ['1', '2', '3', '4', '5', '6', '7']), 0);
  // the editor re-sorts the surviving set into a new order — successors change
  assert.ok(ringDisruption(before, ['7', '3', '1', '5', '2', '6', '4']) > 0.7);
});

test('position disruption is NOT small for hash ordering under churn (that is expected)', () => {
  const seed = 'pos-room';
  const full = Array.from({ length: 10 }, (_, i) => String(i));
  const before = orderTokens(full, { seed });
  // drop whichever token is first on the ring -> everyone after shifts up one
  const after = orderTokens(full.filter((t) => t !== before[0]), { seed });
  assert.equal(ringDisruption(before, after), 0, 'successors preserved');
  assert.ok(positionDisruption(before, after) > 0.8, 'absolute slots do move');
});

test('rejoin lands a token back on the same ring slot (hash) ', () => {
  const seed = 'rejoin-room';
  const present = ['0', '1', '2', '3', '4', '5'];
  // '3' leaves then rejoins; roster is the same set again
  assert.equal(rejoinRestoresSlot(present, present, '3', { seed }), true);
  // and even if OTHER churn happened while it was gone, its successor among the
  // still-common tokens is restored
  const whileGone = ['0', '1', '2', '4', '5', '6', '7'];
  const afterBack = ['0', '1', '2', '3', '4', '5', '6', '7'];
  assert.equal(rejoinRestoresSlot(whileGone.concat('3'), afterBack, '3', { seed }),
    rejoinRestoresSlot(afterBack, afterBack, '3', { seed }));
});

// --- weighting -------------------------------------------------------------

test('weightedRingSlots gives a heavier token proportionally more slots', () => {
  const tokens = ['0', '1', '2', '3'];
  const weights = { '0': 3 };   // token 0 three times as prominent
  const slots = weightedRingSlots(tokens, { seed: 'w', weights, slotCount: 24 });
  const tally = {};
  for (const t of slots) tally[t] = (tally[t] || 0) + 1;
  assert.equal(slots.length, 24);
  assert.ok(tally['0'] >= 2 * tally['1'], `0:${tally['0']} vs 1:${tally['1']}`);
});

test('weightedRingSlots with equal weights ~ orderTokens repeated', () => {
  const tokens = ['0', '1', '2', '3', '4'];
  const slots = weightedRingSlots(tokens, { seed: 's', slotCount: 5 });
  assert.deepEqual([...slots].sort(), [...tokens].sort());
});

// --- helpers ------------------------------------------------------------------

test('nextOwner wraps around the ring', () => {
  const tokens = ['0', '1', '2', '3'];
  const order = orderTokens(tokens, { seed: 'n' });
  assert.equal(nextOwner(tokens, order[0], { seed: 'n' }), order[1]);
  assert.equal(nextOwner(tokens, order[order.length - 1], { seed: 'n' }), order[0]);
  assert.equal(nextOwner(tokens, 'not-present', { seed: 'n' }), order[0]);
});

test('jainFairness: even tally -> 1, monopoly -> 1/N', () => {
  assert.equal(jainFairness({ a: 5, b: 5, c: 5, d: 5 }), 1);
  assert.ok(Math.abs(jainFairness({ a: 20, b: 0, c: 0, d: 0 }) - 0.25) < 1e-9);
});

test('hash ring keeps fairness high across many laps', () => {
  const tokens = Array.from({ length: 12 }, (_, i) => String(i));
  const slots = weightedRingSlots(tokens, { seed: 'fair', slotCount: 12 * 20 });
  const tally = {};
  for (const t of slots) tally[t] = (tally[t] || 0) + 1;
  assert.ok(jainFairness(tally) > 0.95, `fairness ${jainFairness(tally)}`);
});
