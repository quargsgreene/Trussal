import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrussalCaptureProcessor, TrussalMasterPlayerProcessor } from '../src/bot/page-audio-worklet.js';

// The processors run in an AudioWorkletGlobalScope in the page; under Node
// they extend a bare class, so each test gives them a recording port.
const withPort = (proc) => {
  proc.port = { posted: [], postMessage(m) { this.posted.push(m); } };
  return proc;
};

// primeMs that buys exactly `frames` frames at the 48 kHz the module assumes
// outside a worklet scope.
const primeFrames = (frames) => ({ processorOptions: { primeMs: (frames * 1000) / 48000 } });

test('capture: interleaves stereo L,R per frame and posts 2048 frames at a time', () => {
  const cap = withPort(new TrussalCaptureProcessor());
  const quantum = (l, r) => [[new Float32Array(128).fill(l), new Float32Array(128).fill(r)]];
  for (let q = 0; q < 15; q++) assert.equal(cap.process(quantum(0.5, -0.5)), true);
  assert.equal(cap.port.posted.length, 0, 'nothing posted before 2048 frames have accumulated');
  cap.process(quantum(0.5, -0.5)); // the 16th quantum completes 2048 frames
  assert.equal(cap.port.posted.length, 1);
  const [chunk] = cap.port.posted;
  assert.equal(chunk.length, 4096);
  assert.deepEqual(Array.from(chunk.subarray(0, 4)), [0.5, -0.5, 0.5, -0.5], 'L,R per frame');
});

test('capture: a one-channel input is up-mixed to dual-mono, an unconnected quantum is skipped', () => {
  const cap = withPort(new TrussalCaptureProcessor());
  assert.equal(cap.process([[]]), true, 'no input this quantum: keep running');
  for (let q = 0; q < 16; q++) cap.process([[Float32Array.from({ length: 128 }, (_, i) => i / 128)]]);
  const [chunk] = cap.port.posted;
  assert.deepEqual(Array.from(chunk.subarray(0, 4)), [0, 0, 1 / 128, 1 / 128]);
});

test('capture: stop lets the processor be collected', () => {
  const cap = withPort(new TrussalCaptureProcessor());
  cap.stopped = true; // what the 'stop' message sets
  assert.equal(cap.process([[new Float32Array(128)]]), false);
});

test('player: holds silence until the cushion is queued, then plays de-interleaved', () => {
  const player = new TrussalMasterPlayerProcessor(primeFrames(3));
  const L = new Float32Array(2);
  const R = new Float32Array(2);
  player.enqueue(Float32Array.from([0.5, -0.5, 0.25, -0.25])); // 2 frames: below the 3-frame cushion
  player.render(L, R);
  assert.deepEqual([...L, ...R], [0, 0, 0, 0], 'priming: nothing plays yet');
  assert.equal(player.queued, 4, 'and nothing was consumed');

  player.enqueue(Float32Array.from([0.75, -0.75])); // 3 frames: cushion reached
  player.render(L, R);
  assert.deepEqual([...L], [0.5, 0.25], 'left channel carries the L samples');
  assert.deepEqual([...R], [-0.5, -0.25], 'right channel carries the R samples');
  assert.equal(player.priming, false);
  assert.equal(player.consumed, 4);
});

test('player: running dry mid-stream counts an underrun and re-primes instead of trickling', () => {
  const player = new TrussalMasterPlayerProcessor(primeFrames(2));
  const L = new Float32Array(4);
  const R = new Float32Array(4);
  player.enqueue(Float32Array.from([0.5, 0.5, 0.25, 0.25]));
  player.render(L, R);
  assert.deepEqual([...L], [0.5, 0.25, 0, 0], 'the queue empties, then silence');
  assert.equal(player.underruns, 1);
  assert.equal(player.priming, true, 're-priming after running dry');

  player.enqueue(Float32Array.from([0.75, 0.75])); // 1 frame: below the 2-frame cushion
  player.render(L, R);
  assert.deepEqual([...L], [0, 0, 0, 0], 'a single late frame does not play on its own');
  assert.equal(player.underruns, 1, 'silence while priming is not another underrun');
});

test('player: an odd-length chunk plays its last L with a 0 R, never NaN', () => {
  const player = new TrussalMasterPlayerProcessor(primeFrames(0));
  const L = new Float32Array(2);
  const R = new Float32Array(2);
  player.enqueue(Float32Array.from([0.75]));
  player.render(L, R);
  assert.deepEqual([...L], [0.75, 0]);
  assert.deepEqual([...R], [0, 0], 'the missing half of a split frame reads as 0, not NaN');
  assert.equal(player.queued, 0);
  assert.equal(player.consumed, 1);
});

test('player: overflow drops the oldest chunk and counts it as consumed', () => {
  const player = new TrussalMasterPlayerProcessor({ processorOptions: { primeMs: 0, maxChunks: 2 } });
  player.enqueue(Float32Array.from([0.1, 0.1]));
  player.enqueue(Float32Array.from([0.2, 0.2]));
  player.enqueue(Float32Array.from([0.3, 0.3]));
  assert.equal(player.chunks.length, 2);
  assert.equal(player.queued, 4);
  assert.equal(player.consumed, 2, 'the dropped chunk still counts, so the page\'s depth stays right');
});

test('player: reports its position every 8 render quanta', () => {
  const player = withPort(new TrussalMasterPlayerProcessor(primeFrames(0)));
  const out = () => [[new Float32Array(128), new Float32Array(128)]];
  player.enqueue(new Float32Array(128 * 2 * 3).fill(0.5));
  for (let q = 0; q < 7; q++) assert.equal(player.process([], out()), true);
  assert.equal(player.port.posted.length, 0);
  player.process([], out());
  assert.deepEqual(player.port.posted, [{ consumed: 128 * 2 * 3, underruns: 1, priming: true }]);
});
