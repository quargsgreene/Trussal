import { test } from 'node:test';
import assert from 'node:assert/strict';

import { downsampleBins } from '../src/audio-net/observability/SpectrumAnalysis.js';

test('downsampleBins averages contiguous bin groups', () => {
  const bins = [0, 10, 20, 30, 40, 50, 60, 70];
  assert.deepEqual(downsampleBins(bins, 4), [5, 25, 45, 65]);
  assert.deepEqual(downsampleBins(bins, 2), [15, 55]);
});

test('bands >= bins passes values through', () => {
  assert.deepEqual(downsampleBins([1, 2, 3], 8), [1, 2, 3]);
  assert.deepEqual(downsampleBins([1, 2, 3], 3), [1, 2, 3]);
});

test('non-divisible bin counts still cover every bin exactly once', () => {
  const bins = Array.from({ length: 10 }, (_, i) => i);
  const out = downsampleBins(bins, 3);
  assert.equal(out.length, 3);
  // Sum of (band mean × band width) must equal the sum of all bins.
  const widths = [3, 3, 4]; // floor boundaries at 0,3,6,10
  const reconstructed = out.reduce((acc, v, i) => acc + v * widths[i], 0);
  assert.equal(reconstructed, bins.reduce((a, b) => a + b, 0));
});

test('degenerate inputs yield empty output', () => {
  assert.deepEqual(downsampleBins([], 4), []);
  assert.deepEqual(downsampleBins(null, 4), []);
  assert.deepEqual(downsampleBins([1, 2], 0), []);
});
