import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  percentile,
  worstCase,
  computeWorstCaseMetrics,
  PIPELINE_ALLOWANCE_MS
} from '../src/audio-net/network-modulation/WorstCaseCalculationUtils.js';

test('percentile matches the R-7 interpolation ported from bots/src/shared/stats.js', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.throws(() => percentile([], 50), RangeError);
  assert.throws(() => percentile([1], 101), RangeError);
});

test('worstCase is the max over finite samples, null when nothing usable', () => {
  assert.equal(worstCase([12, 90, 45]), 90);
  assert.equal(worstCase([12, null, NaN, 45]), 45);
  assert.equal(worstCase([]), null);
  assert.equal(worstCase([null, undefined]), null);
  assert.equal(worstCase(undefined), null);
});

test('computeWorstCaseMetrics over a mixed roster', () => {
  const peers = [
    { rtt: 40, jitter: 2, packetLoss: 0.01, rtcRtt: 60 },   // rtcRtt preferred
    { rtt: 120, jitter: 8, packetLoss: 0.2, rtcRtt: null }, // WS fallback
    { rtt: null, jitter: null, packetLoss: null, rtcRtt: null } // contributes nothing
  ];
  const wc = computeWorstCaseMetrics(peers);
  assert.equal(wc.wcrtt, 120);
  // Mouth-to-ear: the two worst legs halved and summed (sender -> JVB ->
  // receiver), plus the measured de-jitter buffer, plus the fixed pipeline
  // allowance. No jitterBufferMs reported here, so that term is 0.
  assert.equal(wc.wcl, 120 / 2 + 60 / 2 + 0 + PIPELINE_ALLOWANCE_MS);
  assert.equal(wc.wcj, 8);
  assert.equal(wc.wcpl, 0.2);
  assert.equal(wc.sampleCount, 2);
});

test('the de-jitter buffer is measured, and normally dominates wcl', () => {
  const peers = [
    { rtcRtt: 6, jitterBufferMs: 55 },   // a WiFi human
    { rtcRtt: 1, jitterBufferMs: 40 },   // a LAN bot
  ];
  const wc = computeWorstCaseMetrics(peers);
  assert.equal(wc.wcjb, 55, 'worst buffer is carried for the readout');
  assert.equal(wc.wcl, 6 / 2 + 1 / 2 + 55 + PIPELINE_ALLOWANCE_MS);
  // The point of the model: on a LAN the network is single-digit ms while what
  // a performer hears is ~100 ms, so a network-only figure was ~25x too small.
  assert.ok(wc.wcl > 90 && wc.wcl < 110, `physically plausible (${wc.wcl}ms)`);
  assert.ok(wc.wcl > wc.wcrtt * 10, 'buffer + pipeline dwarf the network leg');
});

test('wcl counts BOTH legs — it is not a halved single leg', () => {
  // Two symmetric peers at 20 ms each: sender->JVB 10 + JVB->receiver 10 = 20,
  // i.e. one leg's full RTT. The old max/2 model returned 10 and so
  // under-reported the network path by 2x.
  const wc = computeWorstCaseMetrics([{ rtcRtt: 20 }, { rtcRtt: 20 }]);
  assert.equal(wc.wcl - PIPELINE_ALLOWANCE_MS, 20);
});

test('empty roster degrades to zeros, not NaN', () => {
  for (const roster of [[], null, undefined, [{}]]) {
    const wc = computeWorstCaseMetrics(roster);
    assert.equal(wc.wcl, 0);
    assert.equal(wc.wcj, 0);
    assert.equal(wc.wcrtt, 0);
    assert.equal(wc.wcpl, 0);
    assert.equal(wc.sampleCount, 0);
  }
});

test('single peer roster (alone in room) assumes a symmetric partner leg', () => {
  const wc = computeWorstCaseMetrics([{ rtt: 33, jitter: 1.5, packetLoss: 0.05 }]);
  assert.equal(wc.wcrtt, 33);
  // No second peer to measure, so the partner leg is assumed to match: the
  // network term is 33/2 + 33/2 = one full leg RTT.
  assert.equal(wc.wcl, 33 + PIPELINE_ALLOWANCE_MS);
  assert.equal(wc.wcj, 1.5);
  assert.equal(wc.wcpl, 0.05);
});

test('bot-only roster works like any other roster (bots self-report metrics too)', () => {
  const wc = computeWorstCaseMetrics([
    { isBot: true, rtt: 200, jitter: 12, packetLoss: 0.4 },
    { isBot: true, rtt: 90, jitter: 3, packetLoss: 0.1 }
  ]);
  assert.equal(wc.wcrtt, 200);
  assert.equal(wc.wcpl, 0.4);
});

test('packet loss is clamped to [0, 1]', () => {
  const wc = computeWorstCaseMetrics([{ rtt: 10, packetLoss: 3.5 }, { rtt: 10, packetLoss: -1 }]);
  assert.equal(wc.wcpl, 1);
});
