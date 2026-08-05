import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';
import {
  videoStateFor,
  videoStateIsNeutral,
  neutralVideoState,
  MAX_BLUR_PX,
  MAX_PIXEL_BLOCK,
  MAX_GRAIN,
  MAX_CROSSFADE_S
} from '../src/audio-net/av-effects/VideoState.js';

// Chains are built by parsing real programs rather than hand-written ASTs, so
// these also pin that the medium argument survives the parser into the state.
function chainOf(directive) {
  const { ast, valid, errors } = parseMetaprogram(`$ participants <0>\n${directive}\n`);
  assert.equal(valid, true, `program should parse: ${errors.map(e => e.message).join('; ')}`);
  return ast.chain;
}

const CYCLE = { cycleSeconds: 2, cyclePos: 0 };
// A lossy, slow room: a low wcrtt is what closes room's cutoff (and so opens
// the blur), and wcl drives the decay.
const METRICS = { wcl: 400, wcj: 40, wcrtt: 1, wcpl: 0.1 };

test('video: an empty chain touches no pixel', () => {
  const state = videoStateFor([], METRICS, CYCLE);
  assert.deepEqual(state, neutralVideoState());
  assert.equal(videoStateIsNeutral(state), true);
});

test('video: room blurs, with radius from the cutoff and mix from the decay', () => {
  const state = videoStateFor(chainOf('# room wcl 2'), METRICS, CYCLE);
  // wcrtt of 1 ms closes the cutoff to 100 Hz of 18 kHz, so the radius is
  // nearly the ceiling; the decay is well past the half-strength point.
  assert.ok(state.blurPx > MAX_BLUR_PX * 0.9, `blurPx ${state.blurPx}`);
  assert.ok(state.blurWet > 0.4 && state.blurWet <= 1, `blurWet ${state.blurWet}`);
  assert.equal(videoStateIsNeutral(state), false);
});

test('video: a wide-open room leaves the image alone', () => {
  // No decay and no cutoff to speak of: nothing to blur, so nothing is drawn
  // twice. The state must be neutral rather than "blur of zero pixels".
  const state = videoStateFor(chainOf('# room wcl 2'), { wcl: 0, wcj: 0, wcrtt: 0, wcpl: 0 }, CYCLE);
  assert.equal(state.blurPx, 0);
  assert.equal(state.blurWet, 0);
  assert.equal(videoStateIsNeutral(state), true);
});

test('video: crush decimates pixels, bounded by the block ceiling', () => {
  const state = videoStateFor(chainOf('# crush wcl 2'), METRICS, CYCLE);
  assert.ok(state.pixelBlock > 1, `pixelBlock ${state.pixelBlock}`);
  assert.ok(state.pixelBlock <= MAX_PIXEL_BLOCK);
  assert.equal(Number.isInteger(state.pixelBlock), true, 'a block is whole pixels');
});

test('video: noise lays grain on, bounded by its ceiling', () => {
  const state = videoStateFor(chainOf('# noise wcl 20 wcrtt 10'), METRICS, CYCLE);
  assert.ok(state.grain > 0, `grain ${state.grain}`);
  assert.ok(state.grain <= MAX_GRAIN);
});

test('video: echo crossfades turns, capped so a fade always lands', () => {
  const state = videoStateFor(chainOf('# echo wcl 2 wcpl 0.3 wcl 3'), METRICS, CYCLE);
  assert.ok(state.crossfadeS > 0, `crossfadeS ${state.crossfadeS}`);
  assert.ok(state.crossfadeS <= MAX_CROSSFADE_S);
  assert.ok(state.crossfadeGain > 0 && state.crossfadeGain <= 1);
});

// --- the medium argument ------------------------------------------------------

test('video: a medium set without "video" leaves the frame untouched', () => {
  const state = videoStateFor(chainOf('# room wcl 2 ["audio"]'), METRICS, CYCLE);
  assert.equal(videoStateIsNeutral(state), true);
});

test('video: a medium set naming video still applies', () => {
  const state = videoStateFor(chainOf('# room wcl 2 ["audio" "video"]'), METRICS, CYCLE);
  assert.ok(state.blurPx > 0);
});

test('video: a patterned medium set switches the frame effect on and off by cycle', () => {
  // Cycle 0 selects ["audio"], cycle 1 selects ["video"].
  const chain = chainOf('# room wcl 2 <["audio"] ["video"]>');
  assert.equal(videoStateIsNeutral(videoStateFor(chain, METRICS, { ...CYCLE, cyclePos: 0 })), true);
  assert.equal(videoStateIsNeutral(videoStateFor(chain, METRICS, { ...CYCLE, cyclePos: 1 })), false);
});

test('video: chained directives compose, strongest of each kind winning', () => {
  const chain = [...chainOf('# crush wcl 1'), ...chainOf('# crush wcl 8')];
  const both = videoStateFor(chain, METRICS, CYCLE);
  const gentle = videoStateFor(chainOf('# crush wcl 1'), METRICS, CYCLE);
  // A later, gentler directive must not undo a fiercer earlier one: these
  // compose onto one image rather than replacing each other.
  assert.ok(both.pixelBlock >= gentle.pixelBlock);
});
