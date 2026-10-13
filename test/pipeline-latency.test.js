import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pipelineLatencyMs,
  firstImpulseOffset,
} from '../src/audio-net/observability/PipelineLatency.js';

test('pipeline latency sums the loopback round trip and the device buffers', () => {
  assert.equal(pipelineLatencyMs({ loopbackS: 0.06, baseLatencyS: 0.01, outputLatencyS: 0.02 }), 90);
});

test('with no loopback result, device latency alone is still worth publishing', () => {
  assert.equal(pipelineLatencyMs({ loopbackS: null, baseLatencyS: 0.01, outputLatencyS: 0.02 }), 30);
});

test('nothing measurable yields null, never a fabricated zero', () => {
  assert.equal(pipelineLatencyMs({ loopbackS: null, baseLatencyS: 0, outputLatencyS: 0 }), null);
  assert.equal(pipelineLatencyMs({}), null);
  assert.equal(pipelineLatencyMs({ loopbackS: NaN }), null);
  assert.equal(pipelineLatencyMs({ loopbackS: -1 }), null);
});

test('impulse detection finds the first sample over the threshold', () => {
  assert.equal(firstImpulseOffset(new Float32Array([0, 0, 0.9, 0.1])), 2);
  assert.equal(firstImpulseOffset(new Float32Array([0, -0.9, 0])), 1, 'polarity does not matter');
  assert.equal(firstImpulseOffset(new Float32Array([0.001, 0.002, 0.0005])), -1);
  assert.equal(firstImpulseOffset(new Float32Array(128)), -1);
  assert.equal(firstImpulseOffset(null), -1);
});
