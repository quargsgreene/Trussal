// room-shard.js — consistent-hash placement of a ROOM onto a Jitsi SHARD.
//
// The edge tier (edge/haproxy.cfg) fronts N full Jitsi stacks ("shards", one
// per rack machine). Every surface of a given room — the SPA HTML, XMPP
// (BOSH / websocket), the latency sidecar (`/ws`, `/o2`), colibri-ws — must
// terminate on the SAME shard, because the sidecar holds all room/roster/CRDT
// state in one in-memory process (latency-instrument/server.js) with no shared
// store. HAProxy enforces that at runtime (stick-table + `hash-type
// consistent`); this module is the OFFLINE MODEL of the same mapping:
//
//   1. the conductor pre-computes which shard a room is (probably) on, before
//      its per-shard `?role=control` discovery confirms it
//      (bots/src/orchestrator/fleet-service.js);
//   2. loadtest/figures/fig11_shard_balance.py replays it over an observed
//      room set to measure rooms-per-shard balance and how few rooms re-home
//      when a shard is added or drained;
//   3. scripts/ sanity checks / the edge README's worked examples.
//
// It is NOT the runtime authority — HAProxy is — so a small divergence in tie
// handling is harmless. What matters is the property both share: RENDEZVOUS
// (highest-random-weight) hashing, so adding an Nth shard re-homes ~1/N of
// rooms and removing one re-homes only that shard's rooms, instead of a
// modulo map reshuffling almost everything.
//
// Pure module: no imports beyond the bundle's own hash primitive, no DOM, no
// node built-ins — runs in the browser bundle, the conductor (Node), and
// node:test alike, exactly like TurnRing.js which it borrows `hashUnitInterval`
// from so the two hashing layers are literally the same function.

import { hashUnitInterval } from '../audio-net/TurnRing.js';

// Rendezvous score for (room, shard). weight scales a shard's share of rooms
// the "logarithmic method" way (score = -weight / ln u), matching
// TurnRing.rendezvousScore — a shard with twice the weight wins about twice as
// many rooms. weight <= 0 or absent means 1.
function shardScore(room, shard, weight) {
  const u = hashUnitInterval(String(room), String(shard));
  return -(weight > 0 ? weight : 1) / Math.log(u);
}

// Normalise the shard argument: an array of names (`['s1','s2']`) or a
// { name: weight } object. Returns [{ name, weight }] with stable order
// (names sorted) so a tie resolves identically everywhere.
export function normalizeShards(shards) {
  if (!shards) return [];
  const entries = Array.isArray(shards)
    ? shards.map((name) => [String(name), 1])
    : Object.entries(shards).map(([name, weight]) => [String(name), weight > 0 ? weight : 1]);
  const seen = new Set();
  return entries
    .filter(([name]) => (seen.has(name) ? false : (seen.add(name), true)))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, weight]) => ({ name, weight }));
}

// The shard that owns `room`. `shards` is an array of names or a
// { name: weight } map. Deterministic; a tie (equal score — vanishingly rare)
// breaks on the shard name so the result is total. Returns null for no shards.
export function shardForRoom(room, shards, { weights = null } = {}) {
  const list = normalizeShards(weights ? mergeWeights(shards, weights) : shards);
  if (!list.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const { name, weight } of list) {
    const s = shardScore(room, name, weight);
    if (s > bestScore || (s === bestScore && best !== null && name < best)) {
      bestScore = s;
      best = name;
    }
  }
  return best;
}

// The full ranking of shards for `room`, best first — HAProxy's ordered
// fallback list when the primary shard is down (drain / failure). Every shard
// appears once.
export function shardRankForRoom(room, shards, { weights = null } = {}) {
  const list = normalizeShards(weights ? mergeWeights(shards, weights) : shards);
  return list
    .map(({ name, weight }) => ({ name, score: shardScore(room, name, weight) }))
    .sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => e.name);
}

function mergeWeights(shards, weights) {
  const base = normalizeShards(shards);
  const out = {};
  for (const { name, weight } of base) {
    out[name] = weights && weights[name] > 0 ? weights[name] : weight;
  }
  return out;
}

// rooms-per-shard tally for a set of room names — the balance a real edge
// should approximate. `{ [shard]: count }`, every shard present (0 if it drew
// nothing).
export function shardDistribution(rooms, shards, opts = {}) {
  const tally = Object.fromEntries(normalizeShards(shards).map(({ name }) => [name, 0]));
  for (const room of rooms || []) {
    const owner = shardForRoom(room, shards, opts);
    if (owner != null) tally[owner] = (tally[owner] || 0) + 1;
  }
  return tally;
}

// Fraction of `rooms` whose owning shard changes when the shard set goes from
// `shardsBefore` to `shardsAfter` (add or drain). Rendezvous hashing keeps
// this near the theoretical minimum: adding one shard to N moves ~1/(N+1);
// draining one moves only the rooms it held. A modulo map would move ~all.
export function rehomedFraction(rooms, shardsBefore, shardsAfter, opts = {}) {
  const list = rooms || [];
  if (!list.length) return 0;
  let moved = 0;
  for (const room of list) {
    if (shardForRoom(room, shardsBefore, opts) !== shardForRoom(room, shardsAfter, opts)) moved++;
  }
  return moved / list.length;
}
