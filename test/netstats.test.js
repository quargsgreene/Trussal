import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveNetSample, mergeSamples } from '../src/audio-net/observability/NetStats.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const poll1 = JSON.parse(readFileSync(join(fixturesDir, 'rtcstats-poll1.json'), 'utf8'));
const poll2 = JSON.parse(readFileSync(join(fixturesDir, 'rtcstats-poll2.json'), 'utf8'));

test('first poll: RTT from selected candidate pair, jitter is worst stream, lifetime loss', () => {
  const { sample, totals } = deriveNetSample(poll1, null);
  assert.equal(sample.rtcRtt, 62); // 0.062 s → ms, not the failed pair's 900
  assert.equal(sample.rtcJitter, 11); // video stream's 0.011 s is the worst
  // Lifetime totals on the first poll: (100+400) / (100+400+9000+45000)
  assert.ok(Math.abs(sample.packetLoss - 500 / 54500) < 1e-9);
  assert.deepEqual(totals, { lost: 500, received: 54000 });
});

test('second poll derives loss from the delta, not the lifetime average', () => {
  const { totals: prev } = deriveNetSample(poll1, null);
  const { sample, totals } = deriveNetSample(poll2, prev);
  // Delta: lost 510-500=10, received 54490-54000=490 → 10/500 = 2%
  assert.ok(Math.abs(sample.packetLoss - 0.02) < 1e-9);
  assert.equal(sample.rtcRtt, 80);
  assert.deepEqual(totals, { lost: 510, received: 54490 });
});

test('candidate pair missing → falls back to remote-inbound-rtp roundTripTime', () => {
  const entries = poll1.filter(s => s.type !== 'candidate-pair');
  const { sample } = deriveNetSample(entries, null);
  assert.equal(sample.rtcRtt, 58); // 0.058 s from remote-inbound-rtp
});

test('no packets moved in the interval → loss is null (not a fake 0%)', () => {
  const { totals: prev } = deriveNetSample(poll1, null);
  const { sample } = deriveNetSample(poll1, prev); // identical report again
  assert.equal(sample.packetLoss, null);
  assert.equal(sample.rtcRtt, 62); // RTT still derived
});

test('empty / garbage reports yield no sample', () => {
  assert.equal(deriveNetSample([], null).sample, null);
  assert.equal(deriveNetSample(null, null).sample, null);
  assert.equal(deriveNetSample([{ type: 'codec' }, null], null).sample, null);
});

test('mergeSamples takes the worst value per field across connections', () => {
  const merged = mergeSamples([
    { rtcRtt: 50, rtcJitter: 2, packetLoss: 0.01 },
    null,
    { rtcRtt: 90, rtcJitter: null, packetLoss: 0.2 }
  ]);
  assert.deepEqual(merged, { rtcRtt: 90, rtcJitter: 2, packetLoss: 0.2 });
  assert.equal(mergeSamples([]), null);
  assert.equal(mergeSamples([null]), null);
});
