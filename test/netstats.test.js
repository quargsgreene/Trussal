import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveNetSample, mergeSamples } from '../src/audio-net/observability/NetStats.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const poll1 = JSON.parse(readFileSync(join(fixturesDir, 'rtcstats-poll1.json'), 'utf8'));
const poll2 = JSON.parse(readFileSync(join(fixturesDir, 'rtcstats-poll2.json'), 'utf8'));

test('first poll: RTT from selected candidate pair, jitter is worst AUDIO stream, lifetime loss', () => {
  const { sample, totals } = deriveNetSample(poll1, null);
  assert.equal(sample.rtcRtt, 62); // 0.062 s → ms, not the failed pair's 900
  // Worst audio jitter across both directions: inbound 0.004 s and the far
  // end's 0.006 s on our outbound. The video stream's 0.011 s is EXCLUDED —
  // see the audio-only test below for why that matters.
  assert.equal(sample.rtcJitter, 6);
  // Lifetime totals on the first poll: (100+400) / (100+400+9000+45000)
  assert.ok(Math.abs(sample.packetLoss - 500 / 54500) < 1e-9);
  assert.deepEqual(totals, { lost: 500, received: 54000, jbDelay: 0, jbEmitted: 0 });
  assert.equal(sample.jitterBufferMs, null, 'fixture reports no buffer stats');
});

test('rtcJitter is audio-only, so turning a camera on cannot change WCJ', () => {
  // rtcJitter drives WCJ, which paces turns and tunes the echo. Video on the
  // same connection routinely jitters an order of magnitude more than Opus;
  // unfiltered it wins the max and the room's musical timing would track
  // whether cameras happen to be on.
  const audioOnly = [
    { type: 'inbound-rtp', kind: 'audio', jitter: 0.003, packetsReceived: 500, packetsLost: 0 }
  ];
  const withVideo = [
    ...audioOnly,
    { type: 'inbound-rtp', kind: 'video', jitter: 0.09, packetsReceived: 9000, packetsLost: 0 }
  ];
  assert.equal(deriveNetSample(audioOnly, null).sample.rtcJitter, 3);
  assert.equal(deriveNetSample(withVideo, null).sample.rtcJitter, 3,
    'a 90 ms video stream must not become the room worst-case jitter');

  // Legacy reports label the stream `mediaType` instead of `kind`.
  const legacy = [{ type: 'inbound-rtp', mediaType: 'audio', jitter: 0.005, packetsReceived: 10, packetsLost: 0 }];
  assert.equal(deriveNetSample(legacy, null).sample.rtcJitter, 5, 'mediaType is honoured as an alias');

  // Neither field present: not assumed to be audio.
  const unlabelled = [{ type: 'inbound-rtp', jitter: 0.07, packetsReceived: 10, packetsLost: 0 }];
  assert.equal(deriveNetSample(unlabelled, null).sample.rtcJitter, null);
});

test('second poll derives loss from the delta, not the lifetime average', () => {
  const { totals: prev } = deriveNetSample(poll1, null);
  const { sample, totals } = deriveNetSample(poll2, prev);
  // Delta: lost 510-500=10, received 54490-54000=490 → 10/500 = 2%
  assert.ok(Math.abs(sample.packetLoss - 0.02) < 1e-9);
  assert.equal(sample.rtcRtt, 80);
  assert.deepEqual(totals, { lost: 510, received: 54490, jbDelay: 0, jbEmitted: 0 });
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

test('de-jitter buffer delay comes from the DELTA, not the lifetime average', () => {
  // Both fields are cumulative. A call that has been up a while has a large
  // lifetime average that barely moves, so only the delta tracks the buffer's
  // current depth — which is the term that dominates mouth-to-ear latency.
  const at = (delay, emitted) => ([
    { type: 'inbound-rtp', jitterBufferDelay: delay, jitterBufferEmittedCount: emitted,
      packetsLost: 0, packetsReceived: 1000 },
  ]);
  // Lifetime so far: 480 s over 48000 samples = 10 ms average.
  const { sample: first, totals } = deriveNetSample(at(480, 48000), null);
  assert.ok(Math.abs(first.jitterBufferMs - 10) < 1e-9);
  // Next interval: 4800 s over 48000 more samples = 100 ms — the buffer grew,
  // and the delta says so even though the lifetime average is now only ~54 ms.
  const { sample: second } = deriveNetSample(at(5280, 96000), totals);
  assert.ok(Math.abs(second.jitterBufferMs - 100) < 1e-9,
    `delta-derived (${second.jitterBufferMs}ms), not lifetime`);
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
  assert.deepEqual(merged, { rtcRtt: 90, rtcJitter: 2, packetLoss: 0.2, jitterBufferMs: null });
  assert.equal(mergeSamples([]), null);
  assert.equal(mergeSamples([null]), null);
});
