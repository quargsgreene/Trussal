import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeShards,
  shardForRoom,
  shardRankForRoom,
  shardDistribution,
  rehomedFraction,
} from '../src/deploy/room-shard.js';

const rooms = Array.from({ length: 3000 }, (_, i) => `room-${i.toString(36)}-${(i * 7 % 13)}`);

// --- basics ----------------------------------------------------------------

test('shardForRoom is deterministic and returns one of the given shards', () => {
  const shards = ['s1', 's2', 's3'];
  for (const room of ['algorave', 'jungle', 'a', '', 'RoomWithCaps']) {
    const a = shardForRoom(room, shards);
    const b = shardForRoom(room, [...shards].reverse());
    assert.equal(a, b, 'independent of the order shards are listed');
    assert.ok(shards.includes(a), `${room} -> ${a}`);
  }
});

test('no shards -> null', () => {
  assert.equal(shardForRoom('x', []), null);
  assert.equal(shardForRoom('x', null), null);
});

test('normalizeShards dedupes, stringifies, sorts, and defaults weight to 1', () => {
  assert.deepEqual(normalizeShards(['s2', 's1', 's2']), [
    { name: 's1', weight: 1 }, { name: 's2', weight: 1 },
  ]);
  assert.deepEqual(normalizeShards({ s1: 3, s2: 0, s3: -4 }), [
    { name: 's1', weight: 3 }, { name: 's2', weight: 1 }, { name: 's3', weight: 1 },
  ]);
});

// --- the property that matters: even spread + minimal disruption ----------

test('rooms spread roughly evenly across shards', () => {
  const dist = shardDistribution(rooms, ['s1', 's2']);
  const ideal = rooms.length / 2;
  for (const n of Object.values(dist)) {
    assert.ok(Math.abs(n - ideal) / ideal < 0.1, `shard got ${n}, ideal ${ideal}`);
  }
});

test('adding a 3rd shard re-homes about 1/3 of rooms and never swaps the other two', () => {
  const before = ['s1', 's2'];
  const after = ['s1', 's2', 's3'];
  const moved = rehomedFraction(rooms, before, after);
  // theoretical 1/3; allow a band for a 3000-room sample
  assert.ok(moved > 0.25 && moved < 0.42, `moved ${moved}`);
  // every room that did NOT move to s3 kept the exact shard it had
  for (const room of rooms) {
    const a = shardForRoom(room, before);
    const b = shardForRoom(room, after);
    if (b !== 's3') assert.equal(b, a, `${room} swapped ${a} -> ${b} without going to s3`);
  }
});

test('draining a shard re-homes only the rooms it held', () => {
  const before = ['s1', 's2', 's3'];
  const after = ['s1', 's2'];
  for (const room of rooms) {
    const a = shardForRoom(room, before);
    const b = shardForRoom(room, after);
    if (a !== 's3') assert.equal(b, a, `${room} on ${a} moved to ${b} though s3 stayed up`);
    else assert.ok(after.includes(b), `${room} left s3 for ${b}`);
  }
});

// --- weighting -----------------------------------------------------------

test('a heavier shard takes proportionally more rooms', () => {
  const dist = shardDistribution(rooms, { s1: 3, s2: 1 });
  assert.ok(dist.s1 > 2 * dist.s2, `s1 ${dist.s1} vs s2 ${dist.s2}`);
});

test('weights can be passed alongside a name array', () => {
  const dist = shardDistribution(rooms, ['s1', 's2'], { weights: { s1: 3 } });
  assert.ok(dist.s1 > 2 * dist.s2, `s1 ${dist.s1} vs s2 ${dist.s2}`);
});

// --- rank / fallback ---------------------------------------------------------

test('shardRankForRoom is a best-first permutation of every shard', () => {
  const shards = ['s1', 's2', 's3', 's4'];
  for (const room of ['a', 'bb', 'ccc']) {
    const rank = shardRankForRoom(room, shards);
    assert.deepEqual([...rank].sort(), [...shards].sort(), 'every shard once');
    assert.equal(rank[0], shardForRoom(room, shards), 'head of the rank is the primary');
  }
});

test('rehomedFraction of an unchanged shard set is 0', () => {
  assert.equal(rehomedFraction(rooms, ['s1', 's2'], ['s2', 's1']), 0);
});
