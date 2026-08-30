import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMetaprogram } from './helpers/metaprogram.js';
import {
  textAndCssStateFor,
  textStateIsNeutral,
  cssStateIsNeutral,
  crushWord,
  noiseWord,
  mutateNumber,
  NOISE_GLYPHS,
  MAX_SPACING_PX,
  MAX_DROP
} from '../src/audio-net/av-effects/TextState.js';

function chainOf(directive) {
  const { ast, valid, errors } = parseMetaprogram(`$ participants <0>\n${directive}\n`);
  assert.equal(valid, true, `program should parse: ${errors.map(e => e.message).join('; ')}`);
  return ast.chain;
}

const CYCLE = { cycleSeconds: 2, cyclePos: 0 };
const METRICS = { wcl: 400, wcpl: 0.1 };

test('text: an empty chain leaves words and styling alone', () => {
  const { text, css } = textAndCssStateFor([], METRICS, CYCLE);
  assert.equal(textStateIsNeutral(text), true);
  assert.equal(cssStateIsNeutral(css), true);
});

test('text: room grows letter spacing and softens the glyphs', () => {
  const { text, css } = textAndCssStateFor(chainOf('# room wcl 2'), METRICS, CYCLE);
  assert.ok(text.spacingPx > 0 && text.spacingPx <= MAX_SPACING_PX);
  assert.ok(css.blurPx > 0);
});

test('text: crush drops letters and quantizes styling', () => {
  const { text, css } = textAndCssStateFor(chainOf('# crush wcl 2'), METRICS, CYCLE);
  assert.ok(text.dropChance > 0 && text.dropChance <= MAX_DROP);
  assert.ok(css.quantizeStep > 1 || css.colorLevels < 256);
});

test('text: noise injects glyphs and jitters styling', () => {
  const { text, css } = textAndCssStateFor(chainOf('# noise wcl 20 wcpl 10'), METRICS, CYCLE);
  assert.ok(text.noiseChars > 0);
  assert.ok(text.noiseBand >= 0 && text.noiseBand < NOISE_GLYPHS.length);
  assert.ok(css.jitter > 0);
});

test('text: echo repeats the last word and crossfades the styling', () => {
  const { text, css } = textAndCssStateFor(chainOf('# echo wcl 2 wcpl 0.3 wcl 3'), METRICS, CYCLE);
  assert.ok(text.repeats > 0);
  assert.ok(text.repeatAlpha > 0);
  assert.ok(css.fadeFromPrevious > 0);
});

// --- the medium argument ------------------------------------------------------

test('text: a medium set of ["text"] mutates words but not styling', () => {
  const { text, css } = textAndCssStateFor(chainOf('# room wcl 2 ["text"]'), METRICS, CYCLE);
  assert.ok(text.spacingPx > 0);
  assert.equal(cssStateIsNeutral(css), true);
});

test('text: a medium set of ["css"] styles but leaves the words alone', () => {
  const { text, css } = textAndCssStateFor(chainOf('# room wcl 2 ["css"]'), METRICS, CYCLE);
  assert.equal(textStateIsNeutral(text), true);
  assert.ok(css.blurPx > 0);
});

test('text: an audio-and-video set touches neither', () => {
  const { text, css } = textAndCssStateFor(chainOf('# crush wcl 2 ["audio" "video"]'), METRICS, CYCLE);
  assert.equal(textStateIsNeutral(text), true);
  assert.equal(cssStateIsNeutral(css), true);
});

// --- determinism --------------------------------------------------------------
//
// The property the whole design rests on: every browser paints its own chat
// panel from the shared program, so two clients mutating the same word in the
// same cycle must produce the same characters.

test('text: the same word in the same cycle crushes identically', () => {
  const a = crushWord('squirrels', 0.4, 12, 7, 3);
  const b = crushWord('squirrels', 0.4, 12, 7, 3);
  assert.equal(a, b);
});

test('text: a different cycle, peer or position crushes differently', () => {
  const base = crushWord('squirrels', 0.4, 12, 7, 3);
  const others = [
    crushWord('squirrels', 0.4, 13, 7, 3),
    crushWord('squirrels', 0.4, 12, 8, 3),
    crushWord('squirrels', 0.4, 12, 7, 4)
  ];
  assert.ok(others.some(o => o !== base), 'the seed must actually name the occurrence');
});

test('text: crush removes letters without reordering what survives', () => {
  const out = crushWord('abcdefghij', 0.5, 3, 1, 0);
  assert.ok(out.length < 'abcdefghij'.length, `expected letters dropped, got ${out}`);
  // Whatever survives must still be a subsequence of the original.
  let i = 0;
  for (const ch of out) {
    i = 'abcdefghij'.indexOf(ch, i) + 1;
    assert.ok(i > 0, `${out} is not a subsequence`);
  }
});

test('text: a zero drop chance is a no-op', () => {
  assert.equal(crushWord('squirrels', 0, 1, 1, 1), 'squirrels');
});

test('text: noise adds glyphs around and inside the word, deterministically', () => {
  const state = { noiseChars: 3, noiseBand: 2 };
  const a = noiseWord('squirrels', state, 5, 2, 1);
  const b = noiseWord('squirrels', state, 5, 2, 1);
  assert.equal(a, b);
  assert.ok(a.length > 'squirrels'.length, `expected glyphs added, got ${a}`);
  // Every original letter survives, in order — noise adds, it does not remove.
  let i = 0;
  for (const ch of 'squirrels') {
    i = a.indexOf(ch, i) + 1;
    assert.ok(i > 0, `${a} lost a letter of the original`);
  }
});

test('text: no noise budget is a no-op', () => {
  assert.equal(noiseWord('squirrels', { noiseChars: 0, noiseBand: 1 }, 1, 1, 1), 'squirrels');
});

test('text: styled numbers quantize to the crush step and jitter deterministically', () => {
  assert.equal(mutateNumber(23, { quantizeStep: 8, jitter: 0 }, 1, 1, 1), 24);
  const a = mutateNumber(23, { quantizeStep: 0, jitter: 0.5 }, 4, 2, 6);
  const b = mutateNumber(23, { quantizeStep: 0, jitter: 0.5 }, 4, 2, 6);
  assert.equal(a, b);
  assert.ok(a >= 23 * 0.5 && a <= 23 * 1.5, `jitter stayed in range: ${a}`);
});
