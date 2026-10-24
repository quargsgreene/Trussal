import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodePcm, decodePcm } from '../src/bot/pcm-wire.js';

test('pcm-wire: Float32 round-trips bit-exactly through base64', () => {
  const samples = Float32Array.from([0, 1, -1, 0.1, -0.333, 1e-7]);
  const back = decodePcm(encodePcm(samples));
  assert.ok(back instanceof Float32Array);
  assert.deepEqual(Array.from(back), Array.from(samples));
});

test('pcm-wire: a plain array encodes as Float32, like the JSON arrays it replaced carried after the ring', () => {
  assert.deepEqual(Array.from(decodePcm(encodePcm([0.5, -0.25]))), [0.5, -0.25]);
});

test('pcm-wire: a view at an odd byte offset still decodes (no alignment assumption)', () => {
  const bytes = Buffer.from(encodePcm(Float32Array.from([0.5, 0.25])), 'base64');
  const padded = Buffer.concat([Buffer.from([7]), bytes]);
  assert.deepEqual(Array.from(decodePcm(padded.subarray(1).toString('base64'))), [0.5, 0.25]);
});

test('pcm-wire: anything that is not a string decodes to no samples', () => {
  for (const bad of [undefined, null, 42, [0.5]]) assert.equal(decodePcm(bad).length, 0);
});

test('pcm-wire: base64 Float32 is ~4x smaller than the JSON array of numbers', () => {
  const samples = Float32Array.from({ length: 9600 }, (_, i) => Math.sin(i / 7) * 0.5);
  const json = JSON.stringify(Array.from(samples)).length;
  const b64 = JSON.stringify(encodePcm(samples)).length;
  assert.ok(json / b64 > 3, `JSON ${json} bytes vs base64 ${b64} bytes`);
});
