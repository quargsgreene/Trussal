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

// --- optional preambles (auto-inject) --------------------------------------

test('hydra-code: preamble-less Hydra is recognised and gets its await initHydra()', () => {
  assert.equal(looksLikeHydra('osc(10).out()'), true);
  assert.equal(looksLikeHydra('src(s0).out()'), true);
  assert.equal(looksLikeHydra('s("bd sd").fast(2)'), false);
  assert.equal(hasHydraCode('osc(10).out()'), true);
  const split = splitHydraCode('osc(10).out()\n\ns("bd sd")');
  assert.ok(split);
  assert.match(split.preamble, /await initHydra\(\)/);
  assert.equal(split.strudel, 's("bd sd")');
  // camera preamble-less still earns a blit cell
  assert.equal(mosaicCellSource('src(s0).out()'), 'blit');
  assert.equal(mosaicCellSource('osc(10).out()'), 'reexecute');
});

test('hydra-code: an explicit preamble is left exactly as written', () => {
  const explicit = 'await initHydra()\nosc(10).out()';
  assert.equal(ensureCapabilityPreambles(explicit), explicit);
});

test('hydra-code: a word()/css() voice gets its own init line supplied', () => {
  assert.match(ensureCapabilityPreambles('word("hi there")'), /^await initTextCycles\(\)\n\nword/);
  assert.match(ensureCapabilityPreambles('css(`body{color:red}`)'), /^await initCss\(\)\n\ncss/);
  // shared preamble when several capabilities are present
  const both = ensureCapabilityPreambles('osc(4).out()\n\nword("x")');
  assert.match(both, /await initHydra\(\)\nawait initTextCycles\(\)\n\n/);
  // spliced into the existing preamble (before its first blank), not stacked
  // ahead of it
  const spliced = ensureCapabilityPreambles('await initHydra()\nosc(4).out()\n\nword("x")');
  assert.equal(spliced, 'await initHydra()\nosc(4).out()\nawait initTextCycles()\n\nword("x")');
  assert.ok(splitHydraCode(spliced).preamble.includes('await initTextCycles()'));
});

// --- detection ----------------------------------------------------------------

test('hydra-code: a block opening with await initHydra is Hydra', () => {
  assert.equal(hasHydraCode('await initHydra()\nosc(10).out()'), true);
});

test('hydra-code: a plain Strudel block is not Hydra', () => {
  assert.equal(hasHydraCode('s("bd sd").fast(2)'), false);
  assert.equal(hasHydraCode(''), false);
  assert.equal(hasHydraCode(null), false);
});

// --- teardown test (combined programs) ---------------------------------------

test('hydra-code: a combined program declares Hydra wherever the preamble sits', () => {
  // strudel.js joins every playing peer into one program, so the peer running
  // Hydra is rarely the first block — a rule anchored to the start of the text
  // would take a live performer's canvas down.
  assert.equal(programDeclaresHydra('s("bd sd")\n\nawait initHydra()\nosc(10).out()'), true);
  assert.equal(programDeclaresHydra('await initHydra()\nosc(10).out()'), true);
});

test('hydra-code: a program with no Hydra, or only a commented one, declares none', () => {
  // Commenting the preamble out is how a performer takes their visuals down,
  // so it must read as "no Hydra" — this is the exact text that left a
  // fullscreen canvas covering the room with no way to remove it.
  assert.equal(programDeclaresHydra('//await initHydra()\n//osc(10).out()\n\nn("0 1").s("piano")'), false);
  assert.equal(programDeclaresHydra('s("bd sd").fast(2)'), false);
  assert.equal(programDeclaresHydra(''), false);
  assert.equal(programDeclaresHydra(null), false);
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

test('hydra-code: a blank line between two rendering Hydra layers stays in the preamble', () => {
  const code = 'await initHydra()\nvoronoi(8, 0.4).out(o0)\n\nosc(10)\n.out()\n\nn("0 1").s("piano")';
  const split = splitHydraCode(code);
  assert.equal(split.preamble, 'await initHydra()\nvoronoi(8, 0.4).out(o0)\n\nosc(10)\n.out()');
  assert.equal(split.strudel, 'n("0 1").s("piano")');
});

test('hydra-code: a blank line before a NON-rendering paragraph still ends the preamble there', () => {
  // Only paragraphs that render (.out(...)) extend the preamble — this is what
  // keeps a genuine Strudel pattern from being swallowed just because it
  // happens to sit after a multi-layer Hydra preamble.
  const code = 'await initHydra()\nosc(10).out(o0)\n\nn("0 1").s("piano")\n\nnote("c e g")';
  const split = splitHydraCode(code);
  assert.equal(split.preamble, 'await initHydra()\nosc(10).out(o0)');
  assert.equal(split.strudel, 'n("0 1").s("piano")\n\nnote("c e g")');
});

test('hydra-code: normalization strips trailing noise and widget lines', () => {
  assert.equal(normalizePeerCode('s("bd")  ;;\n'), 's("bd")');
  assert.equal(normalizePeerCode('*go: s("bd")\ns("sd")'), 's("sd")');
});

// --- what the aggregator can reproduce ----------------------------------------

test('hydra-code: a camera-fed preamble is detected', () => {
  assert.equal(usesExternalSource('await initHydra()\nsrc(s0).out()'), true);
});

test('hydra-code: any of s0-s3 counts, not just s0', () => {
  assert.equal(usesExternalSource('await initHydra()\ns1.initCam()\nsrc(s1).out()'), true);
  assert.equal(usesExternalSource('await initHydra()\ns2.initScreen()\nsrc(s2).out()'), true);
  assert.equal(usesExternalSource('await initHydra()\ns3.initVideo(\'x\')\nsrc(s3).out()'), true);
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

test('hydra-code: external-source cells are blitted, everything else re-executed', () => {
  assert.equal(mosaicCellSource('await initHydra()\nsrc(s0).out()'), 'blit');
  assert.equal(mosaicCellSource('await initHydra()\ns2.initScreen()\nsrc(s2).out()'), 'blit');
  assert.equal(mosaicCellSource('await initHydra()\nosc(10).out()'), 'reexecute');
  assert.equal(mosaicCellSource('s("bd")'), null);
});
