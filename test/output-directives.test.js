// The shape / stage directives as the PARSER reads them: bracket groups,
// media sets, tiling modes, background forms, and the errors each one names.
// How the parsed chain resolves into stage parameters is OutputState's side
// (test/output-state.test.js); this file is the grammar alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMetaprogram, THREE_SHAPES, P5_SHAPES } from './helpers/metaprogram.js';
import { isValuePattern } from '../src/audio-net/ValuePattern.js';

// parseProgram requires a scheduling sequence; these grammar tests care only
// about the directives, so supply a minimal one when the text lacks any.
function withSchedule(text) {
  return text.includes('$') ? text : `$ participants <0>\n${text}`;
}

// Parse a program and hand back its chain, failing loudly on an error the
// test did not ask for.
function chain(text) {
  const { ast, errors, valid } = parseMetaprogram(withSchedule(text));
  assert.deepEqual(errors.map((e) => e.message), [], 'unexpected parse errors');
  assert.equal(valid, true);
  return ast.chain;
}

// The messages of every error a program produces.
function errorsOf(text) {
  return parseMetaprogram(withSchedule(text)).errors.map((e) => e.message);
}

// At least one error matching `re` — recover() may record companions.
function hasError(text, re) {
  return errorsOf(text).some((m) => re.test(m));
}

// --- shapes ------------------------------------------------------------------

test('shape directives: every name parses its positional groups', () => {
  for (const name of Object.keys(THREE_SHAPES)) {
    const [entry] = chain(`# ${name} [1.5] [2 4] [0.5 ~ 0.1]`);
    assert.equal(entry.fn, name);
    assert.deepEqual(entry.args, [[1.5], [2, 4], [0.5, null, 0.1]], name);
  }
  for (const name of Object.keys(P5_SHAPES)) {
    const [entry] = chain(`# ${name} [1.5] [2 4] [0.5]`);
    assert.equal(entry.fn, name);
    assert.deepEqual(entry.args, [[1.5], [2, 4], [0.5]], name);
  }
});

test('shape groups are positional and may stop at any boundary', () => {
  assert.deepEqual(chain('# sphere [3]')[0].args, [[3]]);
  assert.deepEqual(chain('# sphere [3] [64 32]')[0].args, [[3], [64, 32]]);
  assert.deepEqual(chain('# square')[0].args, [], 'every group is optional');
});

test('shape parameters accept rests, commas, and nested patterns', () => {
  assert.deepEqual(chain('# torus [2, 0.5, 8, 24]')[0].args, [[2, 0.5, 8, 24]]);
  assert.deepEqual(chain('# star [100 5 ~]')[0].args, [[100, 5, null]]);
  const [pat] = chain('# tetrahedron [1 <2 3>]');
  assert.equal(isValuePattern(pat.args[0][1]), true, 'an element may be a pattern');
});

test('shape over-counts name the slot instead of silently dropping a parameter', () => {
  assert.ok(hasError('# sphere [30 32 16 9]',
    /'sphere' geometry takes 3 parameters \(radius, widthSegments, heightSegments\), got 4/));
  assert.ok(hasError('# tetrahedron [1] [2] [0.5 0.5 0.5 0.5]',
    /'tetrahedron' animation takes 3 parameters \(spinX, spinY, spinZ\), got 4/));
});

test('shape directives reject a fourth bracket group', () => {
  assert.ok(hasError('# tetrahedron [1] [2] [3] [4]',
    /takes at most 3 bracket groups — 1: geometry, 2: scene, 3: animation/));
});

test('shape directives reject empty groups and stray arguments', () => {
  assert.ok(hasError('# square []', /empty parameter group on 'square'/));
  assert.ok(hasError('# circle 80', /'circle' got an unexpected argument '80'/));
});

test('a medium set rides last and gates the picture like every other effect', () => {
  const [gated] = chain('# tetrahedron [1.5] ["video"]');
  assert.ok(gated.media, 'the medium set lands on the entry');
  assert.ok(hasError('# tetrahedron ["video"] [1.5]', /takes its medium set last/));
});

// --- skybox ------------------------------------------------------------------

test('# skybox reads bare-on, explicit-false, and nothing else', () => {
  assert.deepEqual(chain('# skybox')[0].args, []);
  assert.deepEqual(chain('# skybox false')[0].args, [false]);
  assert.deepEqual(chain('# skybox true')[0].args, [true]);
  assert.equal(errorsOf('# skybox maybe').length, 1);
});

// --- particles, tessellation, tiling ----------------------------------------

test('# particle2/3 and # tessellation take exactly one parameter group', () => {
  assert.deepEqual(chain('# particle2 [400 4 2]')[0].args, [[400, 4, 2]]);
  assert.deepEqual(chain('# particle3 [800]')[0].args, [[800]]);
  assert.deepEqual(chain('# tessellation [8 6 0.5]')[0].args, [[8, 6, 0.5]]);
  assert.ok(hasError('# particle2 [400] [2]', /takes at most 1 bracket group/));
});

test('# tiling takes a mode word, then an optional count group', () => {
  const [grid] = chain('# tiling grid [5]');
  assert.equal(grid.fn, 'tiling');
  assert.equal(grid.mode, 'grid');
  assert.deepEqual(grid.args, [[5]]);
  const [hex] = chain('# tiling hex');
  assert.equal(hex.mode, 'hex');
  assert.deepEqual(hex.args, []);
  assert.equal(chain('# tiling none')[0].mode, 'none');
  assert.ok(hasError('# tiling', /tiling needs a mode/));
  assert.ok(hasError('# tiling banana', /mode must be one of none, grid, hex, strip/));
});

// --- camera3d / controls3d / lighting3d ------------------------------------------

test('# camera3d takes one group of up to five slots', () => {
  assert.deepEqual(chain('# camera3d [30 60 2 35 10]')[0].args, [[30, 60, 2, 35, 10]]);
  assert.deepEqual(chain('# camera3d [~ 45]')[0].args, [[null, 45]]);
  assert.deepEqual(chain('# camera3d')[0].args, []);
  assert.ok(hasError('# camera3d [1 2 3 4 5 6]', /takes 5 parameters \(azimuth, polar, zoom, fov, roll\), got 6/));
  assert.ok(hasError('# camera3d [1] [2]', /takes at most 1 bracket group/));
});

test('# controls3d takes a mode, bare or quoted, then [speed amount]', () => {
  const [orbit] = chain('# controls3d orbit [0.25 30]');
  assert.equal(orbit.fn, 'controls3d');
  assert.equal(orbit.mode, 'orbit');
  assert.deepEqual(orbit.args, [[0.25, 30]]);
  assert.equal(chain('# controls3d "trackball"')[0].mode, 'trackball',
    'the mini notation carries a quoted mode through');
  assert.ok(hasError('# controls3d', /controls3d needs a mode \(none \| orbit \| trackball \| map \| fly\)/));
  assert.ok(hasError('# controls3d spin', /mode must be one of none, orbit, trackball, map, fly/));
  assert.ok(hasError('# controls3d orbit [1 2 3]', /takes 2 parameters/));
});

test('# lighting3d takes a mode, a group, and one color or color pattern', () => {
  const [dir] = chain('# lighting3d directional [2 90 30 0.5] "#ffccaa"');
  assert.equal(dir.mode, 'directional');
  assert.deepEqual(dir.args, [[2, 90, 30, 0.5]]);
  assert.equal(dir.color, '#ffccaa');
  const [pat] = chain('# lighting3d studio <"#fff" "#f80">');
  assert.equal(isValuePattern(pat.color), true, 'the color is patternable');
  const [gated] = chain('# lighting3d point "#f00" ["video"]');
  assert.ok(gated.media, 'a medium set still comes last');
  assert.equal(gated.color, '#f00');
  assert.ok(hasError('# lighting3d point "#f00" "#0f0"', /takes one color/));
  assert.ok(hasError('# lighting3d', /lighting3d needs a mode/));
  assert.ok(hasError('# camera3d "#fff"', /unexpected argument/), 'only lighting3d takes a color');
});

test('mini notation: the view directives lower to their # forms', () => {
  const { ast, errors } = parseMetaprogram(
    "'metaprogram editor'\n" +
    '$: participants("<0 1>")\n' +
    '.camera3d("[30 60 2]")\n' +
    '.controls3d("orbit", "[0.25]")\n' +
    '.lighting3d("point", "[1.5]", "#ffd0a0")\n');
  assert.deepEqual(errors.map((e) => e.message), []);
  const byFn = Object.fromEntries(ast.chain.map((e) => [e.fn, e]));
  assert.deepEqual(byFn.camera3d.args, [[30, 60, 2]]);
  assert.equal(byFn.controls3d.mode, 'orbit');
  assert.equal(byFn.lighting3d.mode, 'point');
  assert.equal(byFn.lighting3d.color, '#ffd0a0');
});

// --- background --------------------------------------------------------------

test('# background: a color, a two-color gradient, an image, or a clear', () => {
  assert.deepEqual(chain('# background "#123456"')[0].background,
    { mode: 'color', color: '#123456' });
  assert.deepEqual(chain('# background "gradient" "#ff0000" "#0000ff" 45')[0].background,
    { mode: 'gradient', from: '#ff0000', to: '#0000ff', angle: 45 });
  assert.deepEqual(chain('# background "image" "https://example.test/sky.jpg"')[0].background,
    { mode: 'image', url: 'https://example.test/sky.jpg' });
  assert.equal(chain('# background')[0].background, null, 'bare clears');
});

test('# background rejects the malformed forms by name', () => {
  assert.ok(hasError('# background "gradient" "#ff0000"', /takes two colors/));
  assert.ok(hasError('# background "image" "a.jpg" "b.jpg"', /takes one URL/));
  assert.ok(hasError('# background red', /colors are quoted/));
  assert.ok(hasError('# background "#ff0000" 45', /angle belongs to a gradient/));
  assert.ok(hasError('# background "#a" "#b"', /takes one color/));
});

test('# background colors and angle may pattern per cycle', () => {
  const [grad] = chain('# background "gradient" <"#f00" "#0f0"> "#000" 45');
  assert.equal(isValuePattern(grad.background.from), true, 'a color is patternable');
  assert.equal(grad.background.to, '#000');
  assert.equal(grad.background.angle, 45);
  const [ang] = chain('# background "gradient" "#f00" "#0f0" <45 90>');
  assert.equal(isValuePattern(ang.background.angle), true, 'the angle is patternable');
  const [gated] = chain('# background "#123456" ["audio"]');
  assert.ok(gated.media, 'background takes a medium set too');
});

// --- mini notation -----------------------------------------------------------

test('mini notation: a shape method in a voice chain lowers to its # directive', () => {
  const { ast, errors } = parseMetaprogram(
    "'metaprogram editor'\n" +
    '$: participants("<0 1>")\n' +
    '.tetrahedron("[1.5]", "[2 4 2 4]", "[0.5 ~ 0.1]")\n');
  assert.deepEqual(errors.map((e) => e.message), []);
  const entry = ast.chain.find((e) => e.fn === 'tetrahedron');
  assert.ok(entry, 'the method reached the chain');
  assert.deepEqual(entry.args, [[1.5], [2, 4, 2, 4], [0.5, null, 0.1]]);
});
