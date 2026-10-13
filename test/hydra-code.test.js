import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePeerCode,
  splitHydraCode,
  hasHydraCode,
  usesExternalSource,
  usesPatternParams,
  mosaicCellSource,
  programDeclaresHydra,
  ensureCapabilityPreambles,
  looksLikeHydra
} from '../src/hydra-code.js';

test('hydra-code: a plain Strudel block is not Hydra', () => {
  assert.equal(hasHydraCode('s("bd sd").fast(2)'), false);
  assert.equal(hasHydraCode(''), false);
  assert.equal(hasHydraCode(null), false);
});

test('hydra-code: a blank line between two rendering Hydra layers stays in the preamble', () => {
  const code = 'await initHydra()\nvoronoi(8, 0.4).out(o0)\n\nosc(10)\n.out()\n\nn("0 1").s("piano")';
  const split = splitHydraCode(code);
  assert.equal(split.preamble, 'await initHydra()\nvoronoi(8, 0.4).out(o0)\n\nosc(10)\n.out()');
  assert.equal(split.strudel, 'n("0 1").s("piano")');
});

test('hydra-code: normalization strips trailing noise and widget lines', () => {
  assert.equal(normalizePeerCode('s("bd")  ;;\n'), 's("bd")');
  assert.equal(normalizePeerCode('*go: s("bd")\ns("sd")'), 's("sd")');
});


test('hydra-code: a camera-fed preamble is detected', () => {
  assert.equal(usesExternalSource('await initHydra()\nsrc(s0).out()'), true);
});

test('hydra-code: any of s0-s3 counts for initCam/initScreen, not just s0', () => {
  assert.equal(usesExternalSource('await initHydra()\ns1.initCam()\nsrc(s1).out()'), true);
  assert.equal(usesExternalSource('await initHydra()\ns2.initScreen()\nsrc(s2).out()'), true);
});

test('hydra-code: initImage/initVideo alone do not force a blit', () => {
  assert.equal(usesExternalSource('await initHydra()\ns3.initVideo(\'x\')\nsrc(s3).out()'), false);
  assert.equal(usesExternalSource('await initHydra()\ns0.initImage("https://example.com/x.png")\nsrc(s0).out()'), false);
});

test('hydra-code: initCam/initScreen still force a blit even alongside initImage/initVideo', () => {
  assert.equal(usesExternalSource(
    'await initHydra()\ns0.initImage("https://example.com/x.png")\ns1.initCam()\nsrc(s0).blend(src(s1)).out()'
  ), true);
});

test('hydra-code: sN is matched as a whole word', () => {
  assert.equal(usesExternalSource('await initHydra()\nosc(10).out(s01)'), false);
  assert.equal(usesExternalSource('await initHydra()\nfoos0.out()'), false);
  assert.equal(usesExternalSource('await initHydra()\nosc(10).out(s14)'), false);
});

test('hydra-code: sN below the blank line is Strudel, not an external source', () => {
  assert.equal(usesExternalSource('await initHydra()\nosc(10).out()\n\ns("s0")'), false);
});

test('hydra-code: H() pattern binding is detected', () => {
  assert.equal(usesPatternParams('await initHydra()\nosc(H("<10 40>")).out()'), true);
  assert.equal(usesPatternParams('await initHydra()\nosc(10).out()'), false);
});
