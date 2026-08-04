import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePeerCode,
  splitHydraCode,
  hasHydraCode,
  usesCameraSource,
  usesPatternParams,
  mosaicCellSource
} from '../src/hydra-code.js';

// --- detection ----------------------------------------------------------------

test('hydra-code: a block opening with await initHydra is Hydra', () => {
  assert.equal(hasHydraCode('await initHydra()\nosc(10).out()'), true);
});

test('hydra-code: a plain Strudel block is not Hydra', () => {
  assert.equal(hasHydraCode('s("bd sd").fast(2)'), false);
  assert.equal(hasHydraCode(''), false);
  assert.equal(hasHydraCode(null), false);
});

test('hydra-code: initHydra further down the block does not count', () => {
  // The convention is a PREAMBLE — the room's browsers only run it when it
  // opens the block, so the mosaic must agree or a cell appears for code the
  // performer's own page never treated as Hydra.
  assert.equal(hasHydraCode('s("bd")\n\nawait initHydra()\nosc(10).out()'), false);
});

test('hydra-code: leading widget declarations do not hide the preamble', () => {
  const code = '*go: s("bd")\nawait initHydra()\nosc(10).out()';
  assert.equal(hasHydraCode(code), true);
});

// --- splitting ----------------------------------------------------------------

test('hydra-code: the preamble runs to the first blank line', () => {
  const split = splitHydraCode('await initHydra()\nosc(10).out()\n\ns("bd sd")');
  assert.equal(split.preamble, 'await initHydra()\nosc(10).out()');
  assert.equal(split.strudel, 's("bd sd")');
});

test('hydra-code: a Hydra-only block has no Strudel voice', () => {
  const split = splitHydraCode('await initHydra()\nosc(10).out()');
  assert.equal(split.strudel, '');
});

test('hydra-code: a non-Hydra block splits to null', () => {
  assert.equal(splitHydraCode('s("bd")'), null);
});

test('hydra-code: normalization strips trailing noise and widget lines', () => {
  assert.equal(normalizePeerCode('s("bd")  ;;\n'), 's("bd")');
  assert.equal(normalizePeerCode('*go: s("bd")\ns("sd")'), 's("sd")');
});

// --- what the aggregator can reproduce ----------------------------------------

test('hydra-code: a camera-fed preamble is detected', () => {
  assert.equal(usesCameraSource('await initHydra()\nsrc(s0).out()'), true);
});

test('hydra-code: s0 is matched as a whole word', () => {
  assert.equal(usesCameraSource('await initHydra()\nosc(10).out(s01)'), false);
  assert.equal(usesCameraSource('await initHydra()\nfoos0.out()'), false);
});

test('hydra-code: s0 below the blank line is Strudel, not a camera source', () => {
  assert.equal(usesCameraSource('await initHydra()\nosc(10).out()\n\ns("s0")'), false);
});

test('hydra-code: H() pattern binding is detected', () => {
  assert.equal(usesPatternParams('await initHydra()\nosc(H("<10 40>")).out()'), true);
  assert.equal(usesPatternParams('await initHydra()\nosc(10).out()'), false);
});

test('hydra-code: camera cells are blitted, everything else re-executed', () => {
  assert.equal(mosaicCellSource('await initHydra()\nsrc(s0).out()'), 'blit');
  assert.equal(mosaicCellSource('await initHydra()\nosc(10).out()'), 'reexecute');
  assert.equal(mosaicCellSource('s("bd")'), null);
});
