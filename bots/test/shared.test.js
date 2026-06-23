import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DOG_BREEDS, breedNameFor } from '../src/shared/dog-breeds.js';
import {
  percentile, isAtOrAbovePercentile, worstCaseLatency, staggerOffsetMs,
} from '../src/shared/stats.js';
import { gainForBotCount, effectsChain } from '../src/shared/audio-math.js';
import { defaultConfig, mergeConfig } from '../src/shared/config.js';

test('DOG_BREEDS is a single deduplicated list with scent hounds included', () => {
  assert.ok(DOG_BREEDS.length >= 10, 'enough names for the max fleet');
  assert.equal(new Set(DOG_BREEDS).size, DOG_BREEDS.length, 'no duplicates');
  for (const hound of ['Bloodhound', 'Basset Hound', 'Bluetick Coonhound', 'Hamiltonstovare', 'Porcelaine']) {
    assert.ok(DOG_BREEDS.includes(hound), `${hound} (scent hound) present`);
  }
});

test('breedNameFor is deterministic per (id, seed) and unique across the fleet', () => {
  const names = Array.from({ length: 10 }, (_, i) => breedNameFor(i, 42));
  assert.equal(new Set(names).size, 10, 'names unique within a session');
  assert.equal(breedNameFor(3, 42), breedNameFor(3, 42), 'same id+seed gives same name');
  for (const n of names) assert.ok(DOG_BREEDS.includes(n));
});

test('percentile: linear-interpolation (R-7) definition', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([0, 100], 95), 95);
  assert.throws(() => percentile([], 50));
});

test('isAtOrAbovePercentile flags fleet outliers, guards tiny fleets', () => {
  const fleet = [10, 11, 12, 13, 14, 15, 16, 17, 18, 200];
  assert.equal(isAtOrAbovePercentile(200, fleet, 95), true);
  assert.equal(isAtOrAbovePercentile(12, fleet, 95), false);
  // Fewer than 4 samples: a 95th-percentile judgment is meaningless — never flag.
  assert.equal(isAtOrAbovePercentile(200, [200, 1], 95), false);
});

test('worstCaseLatency is the fleet max; staggerOffsetMs subdivides it per bot', () => {
  assert.equal(worstCaseLatency([20, 180, 95]), 180);
  assert.throws(() => worstCaseLatency([]));
  assert.equal(staggerOffsetMs(0, 4, 180), 0);
  assert.equal(staggerOffsetMs(3, 4, 180), 540);
  assert.equal(staggerOffsetMs(3, 4, 180, 2), 270, 'subdivisions shrink the step');
  assert.throws(() => staggerOffsetMs(4, 4, 180), 'index out of range');
});

test('gainForBotCount stages gain down as the fleet grows, never clipping', () => {
  const g1 = gainForBotCount(1);
  const g10 = gainForBotCount(10);
  assert.ok(g1 <= 1.0, 'headroom even for a single bot');
  assert.ok(g10 < g1, 'more bots → less gain each');
  // Total power stays within the single-bot power budget.
  assert.ok(10 * g10 ** 2 <= g1 ** 2 * 1.0001);
});

test('effectsChain derives delay/feedback from own latency and jitter', () => {
  const fx = effectsChain({ latencyMs: 250, jitterMs: 40 });
  assert.equal(fx.delaySeconds, 0.25);
  assert.ok(fx.feedback > 0 && fx.feedback < 0.95, 'feedback stays stable');
  const calm = effectsChain({ latencyMs: 250, jitterMs: 0 });
  assert.ok(fx.feedback > calm.feedback, 'more jitter → more feedback');
  const wild = effectsChain({ latencyMs: 250, jitterMs: 10000 });
  assert.ok(wild.feedback <= 0.85, 'feedback capped below self-oscillation');
});

test('effectsChain bakes audible distortion/bitcrush that intensify with a worse link', () => {
  const lan = effectsChain({ latencyMs: 3, jitterMs: 1 });
  assert.ok(lan.distortion >= 0.8, 'distortion audible even at LAN latency');
  assert.ok(lan.crushBits > 4 && lan.crushBits <= 7, 'gentle crush on a calm link');
  const wan = effectsChain({ latencyMs: 120, jitterMs: 30 });
  assert.ok(wan.distortion > lan.distortion, 'more latency → more distortion');
  assert.ok(wan.crushBits < lan.crushBits, 'more jitter → heavier crush (fewer bits)');
  const extreme = effectsChain({ latencyMs: 5000, jitterMs: 5000 });
  assert.ok(extreme.distortion <= 2.8, 'distortion capped');
  assert.ok(extreme.crushBits >= 4, 'crush floored at 4 bits');
});

test('config merge: overrides apply, unknown keys/roles rejected', () => {
  const cfg = mergeConfig({ maxBots: 6, roles: { frequencyBands: true } });
  assert.equal(cfg.maxBots, 6);
  assert.equal(cfg.roles.frequencyBands, true);
  assert.equal(cfg.roles.unison, true, 'untouched roles keep defaults');
  assert.equal(cfg.jitsiUrl, defaultConfig.jitsiUrl);
  assert.throws(() => mergeConfig({ nope: 1 }));
  assert.throws(() => mergeConfig({ roles: { nope: true } }));
});

test('default network endpoints match the spec', () => {
  assert.equal(defaultConfig.jitsiUrl, 'http://localhost/0');
  assert.equal(defaultConfig.jamulusServer, 'trussal.duckdns.org:22000');
  assert.equal(defaultConfig.maxBots, 10);
});
