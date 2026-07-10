import { test } from 'node:test';
import assert from 'node:assert/strict';

import { electAggregator } from '../src/aggregator-election.js';

const agg = (roomIndex, jitsiId, extra = {}) => ({
  isAggregator: true, jitsiId, roomIndex, ...extra,
});
const human = (roomIndex, jitsiId) => ({ isAggregator: false, jitsiId, roomIndex });

test('electAggregator: no peers / no aggregator -> null', () => {
  assert.equal(electAggregator([]), null);
  assert.equal(electAggregator(undefined), null);
  assert.equal(electAggregator([human('0', 'h0'), human('1', 'h1')]), null);
});

test('electAggregator: the sole aggregator wins', () => {
  const a = agg('2', 'aggA');
  assert.equal(electAggregator([human('0', 'h0'), a, human('1', 'h1')]), a);
});

test('electAggregator: lowest room index (first to join) wins when several announce', () => {
  const first = agg('3', 'aggFirst');
  const second = agg('7', 'aggSecond');
  // Order in the roster must not matter — only the room index.
  assert.equal(electAggregator([second, human('0', 'h0'), first]), first);
  assert.equal(electAggregator([first, second]), first);
});

test('electAggregator: promotes the next-lowest when the winner has left the roster', () => {
  const survivor = agg('7', 'aggSecond');
  // The winner (index 3) is gone; only the higher-index aggregator remains.
  assert.equal(electAggregator([human('0', 'h0'), survivor]), survivor);
});

test('electAggregator: ties break deterministically by jitsiId', () => {
  const a = agg('5', 'bbb');
  const b = agg('5', 'aaa');
  assert.equal(electAggregator([a, b]), b, 'lower jitsiId wins the tie');
  assert.equal(electAggregator([b, a]), b, 'independent of roster order');
});

test('electAggregator: a missing/non-numeric room index sorts last, never ahead of a real one', () => {
  const real = agg('9', 'aggReal');
  const pending = agg(null, 'aggPending');
  assert.equal(electAggregator([pending, real]), real);
  // With only an unindexed aggregator present, it still wins (better than none).
  assert.equal(electAggregator([pending]), pending);
});

test('electAggregator: ignores aggregators without a jitsiId (not yet identified)', () => {
  const identified = agg('4', 'aggId');
  const anon = agg('1', null);
  assert.equal(electAggregator([anon, identified]), identified);
});
