import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  avDecouplingSeconds,
  compressionParams,
  landmarkDensityScale,
  healthActions
} from '../src/audio-net/RoomHealth.js';

test('AV decoupling defaults to one cycle and widens with latency, capped at two', () => {
  assert.equal(avDecouplingSeconds(2, { wcl: 0 }), 2);          // default: one cycle length
  assert.equal(avDecouplingSeconds(2, { wcl: 250 }), 3);        // +½ cycle at 250 ms WCL
  assert.equal(avDecouplingSeconds(2, { wcl: 500 }), 4);        // +1 cycle at 500 ms
  assert.equal(avDecouplingSeconds(2, { wcl: 5000 }), 4);       // saturates at 2×
  assert.equal(avDecouplingSeconds(0, { wcl: 500 }), 0);
});

test('compression mapping: transparent when healthy, monotonic in pressure, bounded', () => {
  const idle = compressionParams({});
  assert.equal(idle.ratio, 1);
  assert.equal(idle.engaged, false);

  const mid = compressionParams({ serverLoad: 0.5 });
  const high = compressionParams({ serverLoad: 1 });
  assert.ok(mid.ratio > idle.ratio && high.ratio > mid.ratio);
  assert.equal(high.ratio, 12);
  assert.equal(high.thresholdDb, -30);
  assert.ok(mid.thresholdDb < idle.thresholdDb);

  // The binding constraint wins: bad fps alone engages it.
  const starving = compressionParams({ fps: 6, fpsMin: 24 });
  assert.ok(starving.engaged);
  assert.ok(Math.abs(starving.pressure - 0.75) < 1e-9);
  // Garbage inputs never produce NaN.
  const garbage = compressionParams({ serverLoad: 'x', cpuPressure: -3, fps: null });
  assert.equal(garbage.ratio, 1);
});

test('landmark density tiers: 1 → 0.5 → 0.25', () => {
  assert.equal(landmarkDensityScale({}), 1);
  assert.equal(landmarkDensityScale({ cpuPressure: 0.4 }), 0.5);
  assert.equal(landmarkDensityScale({ ramPressure: 0.7 }), 0.25);
});

test('healthActions names what a load snapshot makes the room do', () => {
  assert.deepEqual(healthActions({}), []);
  const acts = healthActions(
    { serverLoad: 0.8 },
    { cycleSeconds: 2, metrics: { wcl: 400 } }
  );
  const types = acts.map(a => a.type);
  assert.ok(types.includes('compress-global'));
  assert.ok(types.includes('reduce-landmark-density'));
  assert.ok(types.includes('widen-av-decoupling'));
  const local = healthActions({ cpuPressure: 0.5 });
  assert.equal(local[0].type, 'compress-local');
});
