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
  looksLikeHydra,
  stripCapabilityPreambles
} from '../src/hydra-code.js';
import { mosaicCellsForPeers } from '../src/audio-net/MosaicCells.js';

test('hydra-code: stripCapabilityPreambles removes every line ensureCapabilityPreambles can add', () => {
  const code = 'osc(10).out()\n\n$: word("hi")\n$: css(`.x { color: red }`)\n$: image("a.png")\n$: poll("a?")';
  const added = ensureCapabilityPreambles(code);
  for (const name of ['initHydra', 'initTextCycles', 'initCss', 'initFileCycles', 'initPolls']) {
    assert.ok(added.includes(name), `the shape implies ${name}`);
  }
  assert.equal(stripCapabilityPreambles(added), code);
});

// Live-confirmed: any program with both Hydra and a word() voice left the
// aggregator's stage black ("cell 0 (hydra) failed: initTextCycles is not
// defined"). The word() voice brings its init line into the Hydra preamble, and
// on the aggregator's page it threw before the first render call.
test('mosaic: a cell runs only Hydra, whatever else the block implies', () => {
  const pattern = "'personal editor'\nosc(100)\n.out()\n\n\nlead: s(\"sine\")\ntext: typeface(\"Monaco\").word(\"hi\")\n\nfx: reaction(\"tu\")\n\nbotConfig({\"spawn\":3})\n";
  const [cell] = mosaicCellsForPeers([{ roomIndex: '0', playing: true, jitsiId: 'j', pattern }]);
  assert.equal(cell.source, 'reexecute');
  assert.equal(cell.preamble, 'osc(100)\n.out()');
});

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

test('hydra-code: a widget declaration is stripped with its continuation lines', () => {
  // A `.method` chain left behind would glue onto the voice above it.
  assert.equal(
    normalizePeerCode('$: s("bd")\n*btn: sound("piano:2")\n  .note("a4 b4")\n$: s("hh")'),
    '$: s("bd")\n\n$: s("hh")'
  );
  // So would the rest of a call left open across lines.
  assert.equal(
    normalizePeerCode('*pad: stack(\n  s("bd"),\n  s("sd")\n)\n\ns("hh")'),
    's("hh")'
  );
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
