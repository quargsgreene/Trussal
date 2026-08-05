import test from 'node:test';
import assert from 'node:assert/strict';

import { isAudioFile, isImageFile, compressedSize } from '../src/user-samples.js';
import { mosaicCellSource, usesLocalImage } from '../src/hydra-code.js';

test('images: the upload accepts pictures alongside sounds', () => {
  assert.equal(isImageFile('cat.PNG'), true);
  assert.equal(isImageFile('shot.jpeg'), true);
  assert.equal(isImageFile('loop.wav'), false);
  assert.equal(isAudioFile('loop.wav'), true);
  assert.equal(isAudioFile('cat.png'), false);
});

test('images: crush decimates a copy, and a block of 1 is the untouched size', () => {
  assert.deepEqual(compressedSize(640, 480, 1), { width: 640, height: 480 });
  assert.deepEqual(compressedSize(640, 480, 8), { width: 80, height: 60 });
  // Never smaller than one pixel, however hard the crush.
  assert.deepEqual(compressedSize(4, 4, 999), { width: 1, height: 1 });
});

test('images: an img() preamble is blitted, not re-executed', () => {
  // The URL is minted against the performer's own IndexedDB, so an aggregator
  // re-executing this would draw a broken image. Same answer as the camera.
  const code = 'await initHydra()\ns1.initImage(img("mypics"))\nsrc(s1).out(o0)';
  assert.equal(usesLocalImage(code), true);
  assert.equal(mosaicCellSource(code), 'blit');
});

test('images: a preamble with no img() is still re-executed', () => {
  assert.equal(mosaicCellSource('await initHydra()\nosc(10).out(o0)'), 'reexecute');
});
