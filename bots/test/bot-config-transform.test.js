import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyParamFactor,
  colorForText,
  colorHydraPostlude,
  degreesToSemitones,
  detectScale,
  harmonySuffix,
  hslToHex,
  hueForScheme,
  isDegreeBased,
  mapNumericLiterals,
  randomizeParams,
} from '../src/script-gen/bot-config-transform.js';

// --- Numeric literal rewriting ----------------------------------------------

test('rewrites numeric parameters outside strings', () => {
  const out = applyParamFactor('osc(10, 0.1, 1.2).out(o0)', 2);
  assert.equal(out, 'osc(20, 0.2, 2.4).out(o0)');
});

test('leaves mini notation alone', () => {
  const code = 's("bd*2 [~ sd] hh*4")';
  assert.equal(applyParamFactor(code, 3), code);
});

test('leaves note names and scales alone', () => {
  const code = 'n("0 3 5 7").scale("C:minor")';
  assert.equal(applyParamFactor(code, 5), code);
});

test('rewrites the parameter but not the mini string beside it', () => {
  const out = applyParamFactor('s("bd*2 sd").cutoff(800)', 2);
  assert.equal(out, 's("bd*2 sd").cutoff(1600)');
});

test('does not touch digits that are part of an identifier', () => {
  const code = 'src(s0).out(o1)';
  assert.equal(applyParamFactor(code, 4), code);
});

test('does not touch digits inside a comment', () => {
  const code = 'osc(10) // was 40 before\n';
  assert.equal(applyParamFactor(code, 2), 'osc(20) // was 40 before\n');
});

test('handles an escaped quote without losing string state', () => {
  const code = 'word("say \\"2\\" twice").cutoff(100)';
  assert.equal(applyParamFactor(code, 2), 'word("say \\"2\\" twice").cutoff(200)');
});

test('preserves integer-ness and never collapses a non-zero to zero', () => {
  assert.equal(applyParamFactor('.slow(3)', 0.0001), '.slow(1)');
  assert.equal(applyParamFactor('.fast(4)', 0.1), '.fast(1)');
});

test('preserves sign', () => {
  const out = applyParamFactor('.pan(-0.5)', 2);
  assert.match(out, /-1/);
});

test('a zero parameter stays zero', () => {
  assert.equal(applyParamFactor('.gain(0)', 7), '.gain(0)');
});

test('mapNumericLiterals reports each literal once, in order', () => {
  const seen = [];
  mapNumericLiterals('osc(10, 0.1).kaleid(4)', (v) => { seen.push(v); return v; });
  assert.deepEqual(seen, [10, 0.1, 4]);
});

test('randomizeParams is deterministic for a seed and stays within +/-50%', () => {
  const code = 'osc(100).cutoff(1000)';
  const a = randomizeParams(code, 42);
  const b = randomizeParams(code, 42);
  assert.equal(a, b, 'same seed must rebuild the same script');
  assert.notEqual(randomizeParams(code, 43), a);

  for (const value of a.match(/\d+(\.\d+)?/g).map(Number)) {
    const original = value > 400 ? 1000 : 100;
    assert.ok(value >= original * 0.5 && value <= original * 1.5, `${value} within range of ${original}`);
  }
});

test('randomizeParams leaves mini notation alone', () => {
  const out = randomizeParams('s("bd*2 sd:3").cutoff(800)', 7);
  assert.match(out, /s\("bd\*2 sd:3"\)/);
});

// --- Harmony ----------------------------------------------------------------

test('detects a declared scale and its mode', () => {
  assert.deepEqual(detectScale('n("0 2").scale("D:dorian")'), {
    name: 'D:dorian', mode: 'dorian', declared: true,
  });
});

test('falls back to C major when no scale is declared', () => {
  const scale = detectScale('note("c3 e3 g3")');
  assert.equal(scale.mode, 'major');
  assert.equal(scale.declared, false);
});

test('an unknown mode falls back to major rather than throwing', () => {
  assert.equal(detectScale('.scale("C:klingon")').mode, 'major');
});

test('recognises degree-based code', () => {
  assert.equal(isDegreeBased('n("0 2 4").scale("C:minor")'), true);
  assert.equal(isDegreeBased('note("c3 e3").s("sine")'), false);
  assert.equal(isDegreeBased('n("0 2 4")'), false, 'n() without a scale is not diatonic');
});

test('degreesToSemitones walks the scale and wraps octaves', () => {
  assert.equal(degreesToSemitones(0, 'major'), 0);
  assert.equal(degreesToSemitones(2, 'major'), 4);
  assert.equal(degreesToSemitones(7, 'major'), 12);
  assert.equal(degreesToSemitones(2, 'minor'), 3);
});

test('bot 0 is never transposed', () => {
  assert.equal(harmonySuffix('diatonic', 0, 'n("0").scale("C:major")'), '');
  assert.equal(harmonySuffix('+7', 0, 'note("c3")'), '');
});

test('an explicit interval is chromatic and scales with cluster position', () => {
  assert.equal(harmonySuffix('+2', 1, 'note("c3")'), '.add(note(2))');
  assert.equal(harmonySuffix('+2', 3, 'note("c3")'), '.add(note(6))');
  assert.equal(harmonySuffix('-13', 1, 'note("c3")'), '.add(note(-13))');
});

test('diatonic on degree-based code adds scale degrees', () => {
  assert.equal(harmonySuffix('diatonic', 2, 'n("0 2 4").scale("C:minor")'), '.add(n(2))');
});

test('diatonic on note-based code converts degrees to semitones in that scale', () => {
  assert.equal(harmonySuffix('diatonic', 2, 'note("c3 eb3").scale("C:minor")'), '.add(note(3))');
  assert.equal(harmonySuffix('diatonic', 2, 'note("c3 e3")'), '.add(note(4))');
});

test('random harmony is deterministic per seed and bot', () => {
  const a = harmonySuffix('random', 2, 'note("c3")', 11);
  assert.equal(a, harmonySuffix('random', 2, 'note("c3")', 11));
  assert.match(a, /^\.add\(note\(-?\d+\)\)$/);
});

test('unset harmony adds nothing', () => {
  assert.equal(harmonySuffix(null, 3, 'note("c3")'), '');
});

// --- Colour -----------------------------------------------------------------

test('cluster member 0 keeps the human hue', () => {
  assert.equal(hueForScheme('triadic', 0), 0);
  assert.equal(hueForScheme('complementary', 0), 0);
});

test('complementary puts the second member opposite', () => {
  assert.equal(hueForScheme('complementary', 1), 0.5);
});

test('triadic spreads three ways and wraps', () => {
  assert.equal(hueForScheme('triadic', 1), 0.333);
  assert.equal(hueForScheme('triadic', 2), 0.667);
  assert.equal(hueForScheme('triadic', 3), 0, 'wraps back to the author hue');
});

test('random hue is deterministic per seed and in range', () => {
  const h = hueForScheme('random', 2, 5);
  assert.equal(h, hueForScheme('random', 2, 5));
  assert.ok(h >= 0 && h <= 1);
});

test('an unset scheme yields no hue and no postlude', () => {
  assert.equal(hueForScheme(null, 1), null);
  assert.equal(colorHydraPostlude(null, 1, 4), '');
});

test('the hydra postlude reads o0 and writes back to it', () => {
  const out = colorHydraPostlude('triadic', 1, 3);
  assert.equal(out, 'src(o0).hue(0.333).out(o0)');
});

test('monochromatic separates members by brightness, not hue', () => {
  const a = colorHydraPostlude('monochromatic', 0, 4);
  const b = colorHydraPostlude('monochromatic', 2, 4);
  assert.match(a, /brightness/);
  assert.notEqual(a, b, 'members must stay distinguishable');
  assert.ok(!a.includes('hue'), 'monochromatic must not rotate hue');
});

test('text colour is a hex literal the pattern can carry', () => {
  const color = colorForText('complementary', 1);
  assert.match(color, /^#[0-9a-f]{6}$/);
  assert.equal(colorForText(null, 1), null);
});

test('hslToHex round-trips the primaries', () => {
  assert.equal(hslToHex(0, 1, 0.5), '#ff0000');
  assert.equal(hslToHex(1 / 3, 1, 0.5), '#00ff00');
  assert.equal(hslToHex(2 / 3, 1, 0.5), '#0000ff');
});
