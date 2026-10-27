import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  roomParams, rt60CombFeedback, createRoomNode,
  COMB_BASES_S, ALLPASS_BASES_S, CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, MAX_COMB_FEEDBACK
} from '../src/audio-net/av-effects/Room.js';
import {
  echoParams, createEchoNode, normalizedMetric, echoIsPatterned,
  FEEDBACK_CEILING, ECHO_MAX_DELAY_S, ECHO_METRIC_BOUNDS, MIN_DELAY_S, LIMITER_THRESHOLD_DB
} from '../src/audio-net/av-effects/Echo.js';
import { evaluateValuePattern } from '../src/audio-net/ValuePattern.js';
import {
  crushParams, makeCrushCurve, crushMetricAmount,
  BASE_BIT_DEPTH, MAX_BIT_DEPTH, HALVING_AMOUNTS
} from '../src/audio-net/av-effects/Crush.js';
import {
  noiseParams, fillNoise, normalizeRms, noiseGainForDb, noiseMix,
  NOISE_BASE_DB, NOISE_MAX_DB, NOISE_BASE_GAIN, NOISE_RMS
} from '../src/audio-net/av-effects/Noise.js';
import { distanceMatrix, gridView, shadeForDistance } from '../src/audio-net/av-effects/Grid.js';
import { computeChainParams, visualStateFor, EffectsChainManager } from '../src/audio-net/av-effects/index.js';
import { parseMetaprogram, resolveEffectParams } from './helpers/metaprogram.js';

// --- room ---------------------------------------------------------------------
test('room: cutoff clamps — no tail opens fully, an enormous tail floors at the minimum', () => {
  assert.equal(roomParams({ wcl: 0 }).cutoffHz, CUTOFF_MAX_HZ);
  assert.equal(roomParams({ wcl: 1e6 }, { scale: 100 }).cutoffHz, CUTOFF_MIN_HZ); // decay → ∞, cutoff → floor
});

// --- crush --------------------------------------------------------------------

test('crush: 8-bit resting depth, halved per 100 ms of wcl', () => {
  const at = (wcl, user) => crushParams({ wcl }, user).bitDepth;
  assert.equal(at(0), BASE_BIT_DEPTH);   // quiet network → the resting depth
  assert.equal(at(100), 4);
  assert.equal(at(200), 2);
  assert.equal(at(300), 1);
  assert.equal(at(1000), 1, 'clamped at 1 bit, never below');

  const p = crushParams({ wcl: 200 });
  assert.equal(p.metric, 'wcl', 'the driving metric travels with the params');
  assert.equal(p.reduction, 4);
  assert.equal(p.srDivisor, 4);
  assert.equal(p.visualPixelate, 4); // same decimation on pixels
});

test('crush: the scale factor multiplies the resting depth (higher = less crush)', () => {
  assert.equal(crushParams({ wcl: 0 }, { scale: 2 }).bitDepth, MAX_BIT_DEPTH);
  assert.equal(crushParams({ wcl: 100 }, { scale: 2 }).bitDepth, 8);
  assert.equal(crushParams({ wcl: 200 }, { scale: 2 }).bitDepth, 4);
  // Below 1 it crushes harder than the default.
  assert.equal(crushParams({ wcl: 0 }, { scale: 0.5 }).bitDepth, 4);
  // Scale sets the bit ceiling only: sample-rate decimation follows the
  // metric, so a quiet room stays undecimated whatever base was asked for.
  assert.equal(crushParams({ wcl: 0 }, { scale: 0.5 }).srDivisor, 1);
});

test('crush: a fixed third argument pins the metric, in the metric\'s own unit', () => {
  // Durations are pinned in SECONDS (as `# room "wcl" 2 0.4` pins wcl).
  assert.equal(crushMetricAmount('wcl', { wcl: 9999 }, 0.2), 200);
  assert.equal(crushParams({ wcl: 9999 }, { fixedMetric: 0.2 }).bitDepth, 2);
  // Loss is pinned as a fraction.
  assert.equal(crushMetricAmount('wcpl', { wcpl: 0.9 }, 0.25), 0.25);
  assert.equal(crushParams({ wcpl: 0.9 }, { metric: 'wcpl', fixedMetric: 0.25 }).bitDepth, 4);
  // Unpinned still tracks the live metric.
  assert.equal(crushParams({ wcl: 200 }, { fixedMetric: null }).bitDepth, 2);
});

test('crush: loss is a fraction whether measured or pinned', () => {
  // The parser only checks "positive real", so a pinned 5 reaches here as
  // 500 % loss; clamping keeps the reported reduction meaningful.
  assert.equal(crushMetricAmount('wcpl', {}, 5), 1);
  assert.equal(crushParams({}, { metric: 'wcpl', fixedMetric: 5 }).reduction,
    crushParams({}, { metric: 'wcpl', fixedMetric: 1 }).reduction);
  assert.equal(crushMetricAmount('wcpl', { wcpl: -0.5 }), 0);
});

test('crush: a bogus metric falls back rather than poisoning the numbers', () => {
  // A prototype key must not pass for a metric — `amount / <function>` is NaN,
  // and a NaN curve reaches the WaveShaper.
  for (const bogus of ['constructor', 'toString', 'nope', 42, null]) {
    const p = crushParams({ wcl: 100 }, { metric: bogus });
    assert.equal(p.metric, 'wcl', String(bogus));
    assert.ok(Number.isFinite(p.bitDepth) && Number.isFinite(p.srDivisor), String(bogus));
  }
  // A non-numeric pin is ignored, not coerced.
  assert.equal(crushParams({ wcl: 100 }, { fixedMetric: '0.4' }).bitDepth, 4);
  assert.equal(crushParams({ wcl: 100 }, { scale: '2' }).bitDepth, 4);
});


// Resolve `# noise …` the way the aggregator does, so these exercise the
// written syntax rather than a hand-built parameter object.
function noiseFor(line, metrics, cycle = 0) {
  const { ast, errors } = parseMetaprogram(`$ participants <0>\n${line}\n`);
  assert.deepEqual(errors, [], `${line} should parse`);
  return noiseParams(metrics, resolveEffectParams(ast.chain[0], { cycle }));
}

test('noise: each axis modulates only when its own factor is written', () => {
  // Spectrum named, volume not: the bed brightens but stays at the floor.
  const p = noiseFor('# noise "wcl" 1', { wcl: 500 });
  assert.equal(p.tilt, 0.5);
  assert.equal(p.gainDb, NOISE_BASE_DB);
  // A metric keyword alone implies factor 1, as `# room wcl` does.
  assert.equal(noiseFor('# noise "wcl"', { wcl: 500 }).tilt, 0.5);
  // Bare numbers take the default metric, wcl, for both axes.
  const both = noiseFor('# noise 1 1', { wcl: 500 });
  assert.equal(both.tilt, 0.5);
  assert.equal(both.gainDb, 50); // 25 + 0.5 × 50, from wcl
});

test('noise: the 5th and 6th arguments pin the metrics in written order', () => {
  const pinned = noiseFor('# noise "wcl" 1 "wcpl" 10 0.5 0.06', { wcl: 9999, wcpl: 9999 });
  const live = noiseFor('# noise "wcl" 1 "wcpl" 10', { wcl: 500, wcpl: 0.06 });
  assert.equal(pinned.tilt, live.tilt, '0.5 s pinned ≡ 500 ms measured');
  assert.equal(pinned.gainDb, live.gainDb, '0.06 pinned ≡ 0.06 measured');
  // The amounts are positional, so pinning the spectrum metric means writing
  // a volume factor first — as `# cycles "wcl" 10 0.3` needs its scale first.
  // wcpl is a fraction, not seconds, and pins on its own scale.
  assert.equal(noiseFor('# noise "wcpl" 2 1 0.25', { wcpl: 0, wcl: 0 }).tilt, 0.5);
});