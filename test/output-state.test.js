// av-effects/OutputState.js: the parsed chain RESOLVED into stage parameters —
// last-shape-wins, the independent layers, per-cycle sampling of patterned
// slots, media gating, and the library set each state asks the page for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  outputStateFor, outputStageActive, outputStageLibraries, neutralOutputState,
  PARTICLE2_DEFAULTS, PARTICLE3_DEFAULTS, TESSELLATION_DEFAULTS, TILING_DEFAULT_COUNT,
  MAX_PARTICLES, MAX_TILING_COUNT, MAX_TESSELLATION_COLS, MAX_TESSELLATION_ROWS,
} from '../src/audio-net/av-effects/OutputState.js';
import { chainHasValuePattern } from '../src/audio-net/ValuePattern.js';
import { parseMetaprogram } from './helpers/metaprogram.js';

// parseProgram requires a scheduling sequence; these tests resolve `#`
// directives only, so supply a minimal one when the text lacks any.
function chainOf(text) {
  const { ast, errors } = parseMetaprogram(
    text.includes('$') ? text : `$ participants <0>\n${text}`);
  assert.deepEqual(errors.map((e) => e.message), [], 'program parses');
  return ast.chain;
}

function stateOf(text, cycle) {
  return outputStateFor(chainOf(text), cycle || {});
}

// --- the neutral stage -------------------------------------------------------

test('a program with no stage directives leaves the stage neutral and inactive', () => {
  // `# ring` / `# cycles` are chain directives with no stage meaning: they
  // must fall through untouched rather than disturbing the stage.
  const state = stateOf('# ring\n# cycles "wcl" 20\n');
  assert.deepEqual(state, neutralOutputState());
  assert.equal(outputStageActive(state), false);
  assert.deepEqual(outputStageLibraries(state), { three: false, p5: false });
});

test('a background alone resolves but does not arm the stage', () => {
  const state = stateOf('# background "#123456"');
  assert.deepEqual(state.background, { type: 'color', color: '#123456' });
  assert.equal(outputStageActive(state), false,
    'with no shape the frame IS the video — a backdrop has nothing to sit behind');
  assert.deepEqual(outputStageLibraries(state), { three: false, p5: false });
});

// --- the shape slot ----------------------------------------------------------

test('the last shape wins, and families replace each other', () => {
  const first = stateOf('# tetrahedron [1.5]');
  assert.equal(first.shape.name, 'tetrahedron');
  assert.equal(first.shape.family, 'three');
  const replaced = stateOf('# tetrahedron [1.5]\n# sphere [2]\n');
  assert.equal(replaced.shape.name, 'sphere', 'a re-typed shape replaces, not stacks');
  assert.deepEqual(replaced.shape.geometry, [2]);
  const flipped = stateOf('# sphere [2]\n# square [80]\n');
  assert.equal(flipped.shape.name, 'square');
  assert.equal(flipped.shape.family, 'p5');
});

test('geometry, scene and animation resolve slot-by-slot, rests preserved as null', () => {
  const state = stateOf('# tetrahedron [1.5] [2 ~ 4 8] [0.5 ~ 0.1]\n');
  assert.deepEqual(state.shape.geometry, [1.5]);
  assert.deepEqual(state.shape.scene, [2, null, 4, 8]);
  assert.deepEqual(state.shape.animation, [0.5, null, 0.1]);
  assert.equal(outputStageActive(state), true);
});

test('a medium set gates the stage exactly as it gates every other effect', () => {
  const video = stateOf('# tetrahedron [1.5] ["video"]\n');
  assert.equal(video.shape && video.shape.name, 'tetrahedron');
  const audio = stateOf('# tetrahedron [1.5] ["audio"]\n');
  assert.equal(audio.shape, null, '["audio"] leaves the picture alone');
  assert.equal(outputStageActive(audio), false);
});

// --- the independent layers --------------------------------------------------

test('# skybox: bare on, explicit off, and it needs three.js', () => {
  const on = stateOf('# skybox\n');
  assert.equal(on.skybox, true);
  assert.equal(outputStageActive(on), true);
  assert.deepEqual(outputStageLibraries(on), { three: true, p5: false });
  const off = stateOf('# skybox false\n');
  assert.equal(off.skybox, false);
  assert.equal(outputStageActive(off), false);
});

test('# particle2/3 fall back to their defaults and clamp past the ceilings', () => {
  assert.deepEqual(stateOf('# particle2\n').particle2, PARTICLE2_DEFAULTS);
  assert.deepEqual(stateOf('# particle2 [400 4 2]\n').particle2,
    { count: 400, size: 4, speed: 2 });
  assert.deepEqual(stateOf('# particle2 [99999 99 99]\n').particle2,
    { count: MAX_PARTICLES, size: 32, speed: 8 }, 'the ceiling holds');
  assert.deepEqual(stateOf('# particle2 [4 0.1 99]\n').particle2,
    { count: 16, size: 0.5, speed: 8 }, 'the floors hold and speed caps');
  assert.deepEqual(stateOf('# particle3\n').particle3, PARTICLE3_DEFAULTS);
  assert.deepEqual(stateOf('# particle3 [800 5 0.5]\n').particle3,
    { count: 800, size: 5, speed: 0.5 });
});

test('# tessellation defaults and ceilings', () => {
  assert.deepEqual(stateOf('# tessellation\n').tessellation, TESSELLATION_DEFAULTS);
  assert.deepEqual(stateOf('# tessellation [20 20 9]\n').tessellation,
    { cols: MAX_TESSELLATION_COLS, rows: MAX_TESSELLATION_ROWS, spin: 4 });
});

test('# tiling: mode plus count, none clears, count clamps', () => {
  assert.deepEqual(stateOf('# tiling hex\n').tiling,
    { mode: 'hex', count: TILING_DEFAULT_COUNT });
  assert.deepEqual(stateOf('# tiling grid [7]\n').tiling, { mode: 'grid', count: 7 });
  assert.deepEqual(stateOf('# tiling strip [99]\n').tiling,
    { mode: 'strip', count: MAX_TILING_COUNT });
  assert.equal(stateOf('# tiling grid [7]\n# tiling none\n').tiling, null);
});

test('tiling is a modifier of the shape, not a stage of its own', () => {
  const state = stateOf('# tiling grid [7]\n');
  assert.deepEqual(state.tiling, { mode: 'grid', count: 7 });
  assert.equal(outputStageActive(state), false);
});

test('# background resolves to the fill forms the page consumes', () => {
  assert.deepEqual(stateOf('# background "#123456"\n').background,
    { type: 'color', color: '#123456' });
  assert.deepEqual(stateOf('# background "gradient" "#ff0000" "#0000ff"\n').background,
    { type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90 },
    'an unwritten angle is the classic straight-down sweep');
  assert.deepEqual(stateOf('# background "image" "https://example.test/sky.jpg"\n').background,
    { type: 'image', url: 'https://example.test/sky.jpg' });
  assert.equal(stateOf('# background\n').background, null);
});

// --- per-cycle sampling ------------------------------------------------------

test('patterned background colors and angle sample with the cycle', () => {
  const text = '# background "gradient" <"#f00" "#0f0"> "#000" <45 90>\n';
  assert.deepEqual(stateOf(text, { cyclePos: 0 }).background,
    { type: 'gradient', from: '#f00', to: '#000', angle: 45 });
  assert.deepEqual(stateOf(text, { cyclePos: 1 }).background,
    { type: 'gradient', from: '#0f0', to: '#000', angle: 90 });
});

test('a patterned geometry parameter samples with the cycle', () => {
  const text = '# tetrahedron [<1 2>]\n';
  assert.deepEqual(stateOf(text, { cyclePos: 0 }).shape.geometry, [1]);
  assert.deepEqual(stateOf(text, { cyclePos: 1 }).shape.geometry, [2]);
});

test('a data reference in a group resolves to the default when no pack is loaded', () => {
  // readDataRef defaults to () => null, so an unloaded reference is a null
  // slot — the page uses the documented default, never NaN.
  assert.deepEqual(stateOf('# particle2 [Weather:3]\n').particle2, PARTICLE2_DEFAULTS);
});

// --- libraries ---------------------------------------------------------------

test('outputStageLibraries names the family each layer needs', () => {
  assert.deepEqual(outputStageLibraries(stateOf('# tetrahedron [1]\n')),
    { three: true, p5: false });
  assert.deepEqual(outputStageLibraries(stateOf('# square [80]\n')),
    { three: false, p5: true });
  assert.deepEqual(outputStageLibraries(stateOf('# skybox\n# square [80]\n')),
    { three: true, p5: true }, 'layers stack: skybox needs three, the shape p5');
  assert.deepEqual(outputStageLibraries(stateOf('# particle3\n')),
    { three: true, p5: false });
  assert.deepEqual(outputStageLibraries(stateOf('# particle2\n# tessellation\n')),
    { three: false, p5: true });
});

// --- pattern-tick arming -----------------------------------------------------

test('patterned stage arguments arm the pattern tick; plain ones do not', () => {
  assert.equal(chainHasValuePattern(chainOf('# tetrahedron [<1 2>]\n')), true);
  assert.equal(chainHasValuePattern(chainOf('# tetrahedron [1.5]\n')), false);
  assert.equal(chainHasValuePattern(chainOf('# background "gradient" <"#f00" "#0f0"> "#000" 45\n')),
    true, 'patterned colors need the same per-cycle tick as numeric arguments');
  assert.equal(chainHasValuePattern(chainOf('# background "#123456"\n')), false);
  assert.equal(chainHasValuePattern(chainOf('# tiling grid [<3 5>]\n')), true);
  assert.equal(chainHasValuePattern(chainOf('# particle2 [400 4 2]\n')), false);
});
