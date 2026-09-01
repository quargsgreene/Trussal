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

test('room: decay = scale × metric (RT60) sets per-comb feedback; cutoff closes as the tail grows', () => {
  const p = roomParams({ wcl: 500 }, { scale: 2 });
  assert.equal(p.decayS, 1); // 2 × 500 ms
  // After decayS the recirculated signal is down 60 dB: g = 0.001^(delay/decay).
  p.combFeedbacks.forEach((g, i) => {
    assert.ok(Math.abs(g - Math.pow(0.001, COMB_BASES_S[i] / 1)) < 1e-12);
  });
  assert.deepEqual(p.combDelaysS, COMB_BASES_S, 'comb tunings no longer stretch');
  // A 1 s tail closes the cascaded lowpass to CUTOFF_MAX_HZ / (1 + 1 × 12).
  assert.ok(Math.abs(p.cutoffHz - CUTOFF_MAX_HZ / 13) < 1e-9, `cutoffHz ${p.cutoffHz}`);
  assert.ok(Math.abs(p.visualLowpass - p.cutoffHz / CUTOFF_MAX_HZ) < 1e-12);

  // No decay → the lowpass is wide open, so nothing is blurred.
  const dry = roomParams({ wcl: 0 }, { scale: 2 });
  assert.equal(dry.cutoffHz, CUTOFF_MAX_HZ);
  assert.equal(dry.visualLowpass, 1);
});

test('room: fixedMetric pins the metric — live wcl is ignored', () => {
  const pinned = roomParams({ wcl: 9999 }, { scale: 2, fixedMetric: 0.4 });
  assert.equal(pinned.decayS, 0.8); // 2 × 0.4 s, regardless of metrics.wcl
  const live = roomParams({ wcl: 400 }, { scale: 2 });
  assert.deepEqual(pinned.combFeedbacks, live.combFeedbacks, '400 ms pinned ≡ 400 ms measured');
});

test('room: feedback clamps — no decay silences the tail, huge decay stays below unity', () => {
  assert.equal(rt60CombFeedback(0.03, 0), 0);
  const dry = roomParams({ wcl: 0 });
  dry.combFeedbacks.forEach(g => assert.equal(g, 0));
  assert.equal(dry.wetGain, 0, 'no tail -> no wet path, not a bare slapback');
  const huge = roomParams({ wcl: 1e9 }, { scale: 100 });
  huge.combFeedbacks.forEach(g => assert.equal(g, MAX_COMB_FEEDBACK));
  assert.ok(huge.wetGain > 0);
});

test('room: cutoff clamps — no tail opens fully, an enormous tail floors at the minimum', () => {
  assert.equal(roomParams({ wcl: 0 }).cutoffHz, CUTOFF_MAX_HZ);
  assert.equal(roomParams({ wcl: 1e6 }, { scale: 100 }).cutoffHz, CUTOFF_MIN_HZ); // decay → ∞, cutoff → floor
});

test('room: wcrtt is a valid decay metric too, on the same ms-to-seconds scale as wcl', () => {
  const viaRtt = roomParams({ wcrtt: 500 }, { metric: 'wcrtt', scale: 2 });
  const viaWcl = roomParams({ wcl: 500 }, { scale: 2 });
  assert.equal(viaRtt.decayS, viaWcl.decayS);
  assert.deepEqual(viaRtt.combFeedbacks, viaWcl.combFeedbacks);
});

// Minimal recording stand-in for an AudioContext: enough surface for
// createRoomNode, and every connect() is logged so the built graph can be
// asserted on. Schroeder's shape (parallel combs → SERIES allpasses) is a
// wiring property, invisible to the roomParams math tests above.
function recordingCtx() {
  const edges = [];
  let id = 0;
  const mk = (kind) => {
    const node = {
      id: `${kind}#${id++}`,
      gain: { value: 0 },
      delayTime: { value: 0 },
      frequency: { value: 0 },
      threshold: { value: 0 },
      connect(target) { edges.push([node.id, target.id]); },
      disconnect() {}
    };
    return node;
  };
  return {
    edges,
    currentTime: 0,
    createGain: () => mk('gain'),
    createDelay: () => mk('delay'),
    createBiquadFilter: () => Object.assign(mk('biquad'), { type: '' }),
    createDynamicsCompressor: () => mk('compressor')
  };
}

test('room: allpass stages are chained in series, each feeding the next', () => {
  const ctx = recordingCtx();
  createRoomNode(ctx, roomParams({ wcl: 200 }, { scale: 2 }));

  // Delay nodes are created combs-first, so the allpasses are the last ones.
  const allpassIds = [...new Set(ctx.edges.flat())]
    .filter(n => n.startsWith('delay#'))
    .slice(COMB_BASES_S.length);
  assert.equal(allpassIds.length, ALLPASS_BASES_S.length);

  const feedersOf = (id) => ctx.edges.filter(([, to]) => to === id).map(([from]) => from);
  const sinksOf = (id) => ctx.edges.filter(([from]) => from === id).map(([, to]) => to);

  allpassIds.forEach((apId, i) => {
    // Every stage after the first is fed by its predecessor, not by combSum.
    if (i > 0) {
      assert.ok(feedersOf(apId).includes(allpassIds[i - 1]),
        `allpass ${i} must be fed by allpass ${i - 1} (series), not tapped off the comb sum`);
    }
    // No stage is a dead end: each reaches something besides its own feedback.
    const onward = sinksOf(apId).filter(to => !feedersOf(apId).includes(to));
    assert.ok(onward.length > 0, `allpass ${i} output goes nowhere — dead branch`);
  });

  // The last stage is the one that reaches the lowpass pair.
  const last = allpassIds[allpassIds.length - 1];
  assert.ok(sinksOf(last).some(to => to.startsWith('biquad#')),
    'the final allpass must feed the cascaded lowpass');
});

// --- echo ---------------------------------------------------------------------

// The spec example: `# echo "wcl" 2 "wcpl" 0.3 "wcl" 3 1500 20 1200`.
const SPEC_ECHO = {
  slots: [
    { param: 'length', metric: 'wcl', scale: 2, bound: 1500 },
    { param: 'feedback', metric: 'wcpl', scale: 0.3, bound: 20 },
    { param: 'gain', metric: 'wcl', scale: 3, bound: 1200 }
  ]
};

test('echo: each parameter is its scale at the metric bound, and scales down with the metric', () => {
  // Every metric pinned at its own upper bound → every parameter at its scale.
  const full = echoParams({ wcl: 1500, wcpl: 0.2 }, SPEC_ECHO, { cycleSeconds: 2 });
  assert.equal(full.lengthCycles, 2);
  assert.equal(full.feedback, 0.3);          // 20 % loss written as 20, wcpl broadcast as 0.2
  assert.equal(full.gain, 3);
  assert.equal(full.delayS, 4);              // 2 cycles × 2 s

  // Each slot normalizes against ITS OWN bound, so the same wcl gives length
  // half its scale (750/1500) and gain five eighths of its scale (750/1200).
  const half = echoParams({ wcl: 750, wcpl: 0.1 }, SPEC_ECHO, { cycleSeconds: 2 });
  assert.equal(half.lengthCycles, 1);
  assert.ok(Math.abs(half.feedback - 0.15) < 1e-12);
  assert.equal(half.delayS, 2);
  assert.ok(Math.abs(half.gain - 3 * 750 / 1200) < 1e-12);
});

test('echo: metrics past their bound clamp — the parameter never exceeds its scale', () => {
  const wild = echoParams({ wcl: 1e6, wcpl: 1 }, SPEC_ECHO, { cycleSeconds: 1 });
  assert.equal(wild.lengthCycles, 2, 'normalization is clamped at 1, not open-ended');
  assert.equal(wild.feedback, 0.3);
  assert.equal(wild.gain, 3);
  assert.equal(normalizedMetric('wcl', { wcl: 1e6 }, 1500), 1);
  assert.equal(normalizedMetric('wcpl', { wcpl: 0.1 }, 20), 0.5, 'wcpl bound is a percentage');
  assert.equal(normalizedMetric('wcl', { wcl: 250 }, 0), 0.5, 'unusable bound falls back to the default');
});

test('echo: bare # echo defaults to "wcl" at 0.5 cycles / 0.5 feedback / unity gain', () => {
  const atBound = echoParams({ wcl: ECHO_METRIC_BOUNDS.wcl }, null, { cycleSeconds: 4 });
  assert.equal(atBound.lengthCycles, 0.5);
  assert.equal(atBound.feedback, 0.5);
  assert.equal(atBound.gain, 1);
  assert.equal(atBound.delayS, 2);   // half of a 4 s cycle

  // Metrics still drive it: a healthy room gets a proportionally smaller echo.
  const quiet = echoParams({ wcl: ECHO_METRIC_BOUNDS.wcl / 10 }, null, { cycleSeconds: 4 });
  assert.ok(Math.abs(quiet.lengthCycles - 0.05) < 1e-12);
  assert.ok(Math.abs(quiet.gain - 0.1) < 1e-12);
});

test('echo: feedback clamps below unity; a dead metric mutes the wet path', () => {
  const runaway = echoParams({ wcl: 500 }, {
    slots: [
      { param: 'length', metric: 'wcl', scale: 1, bound: 500 },
      { param: 'feedback', metric: 'wcl', scale: 4, bound: 500 },  // asks for 4× unity
      { param: 'gain', metric: 'wcl', scale: 1, bound: 500 }
    ]
  }, { cycleSeconds: 1 });
  assert.equal(runaway.feedback, FEEDBACK_CEILING, 'a self-oscillating delay line is never scheduled');
  assert.equal(runaway.visualBrightness, 1 - FEEDBACK_CEILING);

  const dead = echoParams({ wcl: 0, wcpl: 0 }, SPEC_ECHO, { cycleSeconds: 2 });
  assert.equal(dead.delayS, 0);
  assert.equal(dead.wetGain, 0, 'no delay → no wet path, not a one-quantum slapback');
  assert.equal(dead.visualBrightness, 1, 'an echo doing nothing leaves the image untouched');
});

test('echo: a length below one render quantum mutes the wet path, however high the feedback', () => {
  // Each slot reads its own metric, so a dead length does not imply dead
  // feedback: wcpl is flat while wcl is high. Below the quantum the DelayNode
  // would ring as a fixed ~375 Hz comb at near-unity feedback.
  const sliver = echoParams({ wcpl: 0.00001, wcl: 500 }, {
    slots: [
      { param: 'length', metric: 'wcpl', scale: 0.000001, bound: 50 },
      { param: 'feedback', metric: 'wcl', scale: 4, bound: 500 },
      { param: 'gain', metric: 'wcl', scale: 1, bound: 500 }
    ]
  }, { cycleSeconds: 2 });
  assert.ok(sliver.delayS > 0 && sliver.delayS < MIN_DELAY_S, 'nonzero but unrenderable');
  assert.equal(sliver.feedback, FEEDBACK_CEILING);
  assert.equal(sliver.wetGain, 0, 'a comb is not an echo — mute it rather than ring');
});

test('echo: delay length is in cycles, so it re-times when the cycle length moves', () => {
  const slots = { slots: [
    { param: 'length', metric: 'wcl', scale: 1, bound: 100 },
    { param: 'feedback', metric: 'wcl', scale: 0.5, bound: 100 },
    { param: 'gain', metric: 'wcl', scale: 1, bound: 100 }
  ] };
  assert.equal(echoParams({ wcl: 100 }, slots, { cycleSeconds: 0.5 }).delayS, 0.5);
  assert.equal(echoParams({ wcl: 100 }, slots, { cycleSeconds: 3 }).delayS, 3);
  // The DelayNode's buffer is allocated once, so the delay is capped there.
  assert.equal(echoParams({ wcl: 100 }, slots, { cycleSeconds: 1e6 }).delayS, ECHO_MAX_DELAY_S);
});

test('echo: patterned arguments alternate per cycle and subdivide within one', () => {
  const patterned = {
    slots: [
      { param: 'length', metric: 'wcl', scale: { type: 'valueSeq', mode: 'alternate', terms: [2, 3, 0.5] }, bound: 1000 },
      { param: 'feedback', metric: 'wcl', scale: 0.5, bound: 1000 },
      { param: 'gain', metric: 'wcl', scale: { type: 'valueSeq', mode: 'subdivide', terms: [1, 4] }, bound: 1000 }
    ]
  };
  assert.ok(echoIsPatterned(patterned));
  assert.ok(!echoIsPatterned(SPEC_ECHO));

  const at = (cyclePos) => echoParams({ wcl: 1000 }, patterned, { cycleSeconds: 1, cyclePos });
  assert.equal(at(0).lengthCycles, 2);
  assert.equal(at(1).lengthCycles, 3);
  assert.equal(at(2).lengthCycles, 0.5);
  assert.equal(at(3).lengthCycles, 2, 'alternation wraps');
  // Cycle-start arrives a lookahead early, so the position dips just below the
  // boundary — that must still read as the PREVIOUS cycle, not index off the end.
  assert.equal(at(-0.1).lengthCycles, 0.5);

  assert.equal(at(0.25).gain, 1, 'first half of the cycle');
  assert.equal(at(0.75).gain, 4, 'second half');
});

test('value patterns nest: <> alternates per outer cycle, [] subdivides its own span', () => {
  const seq = (mode, ...terms) => ({ type: 'valueSeq', mode, terms });
  const nested = seq('subdivide', 1, seq('subdivide', 2, 3));
  assert.equal(evaluateValuePattern(nested, 0.25), 1);
  assert.equal(evaluateValuePattern(nested, 0.6), 2);   // second half, first of its two steps
  assert.equal(evaluateValuePattern(nested, 0.9), 3);

  const alt = seq('subdivide', 1, seq('alternate', 2, 3));
  assert.equal(evaluateValuePattern(alt, 4.75), 2, 'even outer cycle');
  assert.equal(evaluateValuePattern(alt, 5.75), 3, 'odd outer cycle');

  assert.equal(evaluateValuePattern(7, 3.2), 7, 'plain numbers pass through');
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

test('crush: every worst-case metric can drive it, each on its own scale', () => {
  assert.deepEqual(Object.keys(HALVING_AMOUNTS).sort(), ['wcl', 'wcpl', 'wcrtt']);
  const metrics = { wcl: 100, wcrtt: 100, wcpl: 0.25 };
  // One halving of the 8-bit base for each metric at its own halving amount.
  for (const metric of Object.keys(HALVING_AMOUNTS)) {
    assert.equal(crushParams(metrics, { metric }).bitDepth, 4, metric);
  }
  // A metric the room has not measured yet reads as 0 — no crush, not NaN.
  assert.equal(crushParams({}, { metric: 'wcrtt' }).bitDepth, BASE_BIT_DEPTH);
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

test('crush: mini-notation arguments are read off the cycle grid', () => {
  const metrics = { wcl: 100, wcpl: 0 };
  const alt = { type: 'valueSeq', mode: 'alternate', terms: [1, 2] };
  // <1 2> on the scale: cycle 0 → 8-bit base, cycle 1 → 16-bit base.
  assert.equal(crushParams(metrics, { scale: alt }, 0).bitDepth, 4);
  assert.equal(crushParams(metrics, { scale: alt }, 1).bitDepth, 8);
  assert.equal(crushParams(metrics, { scale: alt }, 2).bitDepth, 4);
  // Mid-cycle reads the same value as the boundary did — <> is per cycle.
  assert.equal(crushParams(metrics, { scale: alt }, 1.75).bitDepth, 8);

  // A patterned METRIC switches what is driving the crush.
  const metricPat = { type: 'valueSeq', mode: 'alternate', terms: ['wcl', 'wcpl'] };
  assert.equal(crushParams(metrics, { metric: metricPat }, 0).metric, 'wcl');
  assert.equal(crushParams(metrics, { metric: metricPat }, 1).metric, 'wcpl');

  // [] subdivides the cycle instead of alternating across cycles.
  const sub = { type: 'valueSeq', mode: 'subdivide', terms: [1, 2] };
  assert.equal(crushParams(metrics, { scale: sub }, 0).bitDepth, 4);
  assert.equal(crushParams(metrics, { scale: sub }, 0.5).bitDepth, 8);
  assert.equal(crushParams(metrics, { scale: sub }, 1.25).bitDepth, 4);
});

test('crush: quantization curve has exactly 2^bits levels', () => {
  const curve = makeCrushCurve(2); // 4 levels
  const levels = new Set(Array.from(curve).map(v => v.toFixed(6)));
  assert.equal(levels.size, 4);
  assert.equal(curve[0], -1);
  assert.equal(curve[curve.length - 1], 1);
});

// --- noise --------------------------------------------------------------------

// Resolve `# noise …` the way the aggregator does, so these exercise the
// written syntax rather than a hand-built parameter object.
function noiseFor(line, metrics, cycle = 0) {
  const { ast, errors } = parseMetaprogram(`$ participants <0>\n${line}\n`);
  assert.deepEqual(errors, [], `${line} should parse`);
  return noiseParams(metrics, resolveEffectParams(ast.chain[0], { cycle }));
}

test('noise: a bare directive is the unmodulated floor — brown at the base dB', () => {
  const p = noiseFor('# noise', { wcl: 500, wcpl: 0.9 });
  assert.equal(p.tilt, 0);
  assert.equal(p.gainDb, NOISE_BASE_DB);
  assert.equal(p.gain, NOISE_BASE_GAIN, 'the level the fixed-gain implementation ran at');
  assert.equal(p.type, 'brown');
  assert.deepEqual(p.mix, { brown: 1, pink: 0, white: 0 });
});

test('noise: the spectrum factor sweeps brown → pink → white', () => {
  // wcl 500 ms = 0.5 s, so factor 1 lands exactly halfway along the axis.
  const pink = noiseFor('# noise "wcl" 1', { wcl: 500 });
  assert.equal(pink.tilt, 0.5);
  assert.equal(pink.type, 'pink');
  assert.deepEqual(pink.mix, { brown: 0, pink: 1, white: 0 });

  const brownish = noiseFor('# noise "wcl" 0.4', { wcl: 500 });
  assert.equal(brownish.tilt, 0.2);
  assert.equal(brownish.type, 'brown', 'nearest colour is the label; the mix is a blend');
  assert.ok(brownish.mix.brown > brownish.mix.pink && brownish.mix.pink > 0);
  // Equal-power: uncorrelated generators sum in POWER, so the bed keeps its
  // level across the sweep instead of dipping in the middle.
  const power = Object.values(brownish.mix).reduce((a, g) => a + g * g, 0);
  assert.ok(Math.abs(power - 1) < 1e-12);

  const white = noiseFor('# noise "wcl" 20', { wcl: 500 });
  assert.equal(white.tilt, 1, 'clamped at the top of the axis');
  assert.deepEqual(white.mix, { brown: 0, pink: 0, white: 1 });
});

test('noise: the volume factor rides its own metric from the base dB to the clamp', () => {
  // wcrtt 60 ms = 0.06 s × 10 = 0.6 of the way from 25 dB to 75 dB.
  const p = noiseFor('# noise "wcl" 1 "wcrtt" 10', { wcl: 500, wcrtt: 60 });
  assert.equal(p.gainDb, 55);
  assert.ok(Math.abs(p.gain - NOISE_BASE_GAIN * Math.pow(10, 30 / 20)) < 1e-12);

  const loud = noiseFor('# noise "wcl" 1 "wcrtt" 1000', { wcl: 500, wcrtt: 60 });
  assert.equal(loud.gainDb, NOISE_MAX_DB, 'clamped at 75 dB');
  assert.ok(Math.abs(loud.gain - NOISE_BASE_GAIN * Math.pow(10, 50 / 20)) < 1e-12);
  assert.equal(noiseGainForDb(1e6), noiseGainForDb(NOISE_MAX_DB), 'the clamp is the ceiling');
});

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

test('noise: patterned arguments advance one element per cycle', () => {
  const metrics = { wcl: 500 };
  const tiltAt = (c) => noiseFor('# noise "wcl" <1 0.5 20>', metrics, c).tilt;
  assert.deepEqual([0, 1, 2, 3].map(tiltAt), [0.5, 0.25, 1, 0.5]);
  // The metric keyword itself may alternate.
  const metricAt = (c) => noiseFor('# noise <"wcl" "wcpl"> 1', { wcl: 500, wcpl: 0.25 }, c).tilt;
  assert.deepEqual([0, 1].map(metricAt), [0.5, 0.25]);
  // Nested groups advance once per visit of the parent.
  const nested = (c) => noiseFor('# noise "wcl" <1 <0.5 20>>', metrics, c).tilt;
  assert.deepEqual([0, 1, 2, 3].map(nested), [0.5, 0.25, 0.5, 1]);
});

test('noise buffers stay in range and have the right character', () => {
  const white = fillNoise(new Float32Array(48000), 'white');
  const brown = fillNoise(new Float32Array(48000), 'brown');
  for (const buf of [white, brown]) {
    for (let i = 0; i < buf.length; i += 997) assert.ok(Math.abs(buf[i]) <= 4);
  }
  // Brown noise is low-frequency dominated: successive-sample deltas are far
  // smaller relative to amplitude than white's.
  const meanAbsDelta = (b) => {
    let s = 0; for (let i = 1; i < b.length; i++) s += Math.abs(b[i] - b[i - 1]);
    return s / (b.length - 1);
  };
  const rms = (b) => Math.sqrt(b.reduce((a, v) => a + v * v, 0) / b.length);
  assert.ok(meanAbsDelta(brown) / rms(brown) < meanAbsDelta(white) / rms(white) / 5);
});

test('noise: generators are level-matched, so a crossfade changes colour only', () => {
  const rms = (b) => Math.sqrt(b.reduce((a, v) => a + v * v, 0) / b.length);
  const levels = ['brown', 'pink', 'white'].map((color) => {
    const buf = normalizeRms(fillNoise(new Float32Array(48000), color));
    return rms(buf);
  });
  levels.forEach((r) => assert.ok(Math.abs(r - NOISE_RMS) < 1e-6));
  // Un-normalized the generators span ~9 dB (white ≈ 2.9 × brown), which
  // would make a colour sweep an unintended volume ramp.
  assert.ok(rms(fillNoise(new Float32Array(48000), 'white')) /
            rms(fillNoise(new Float32Array(48000), 'brown')) > 2);
  // Mixed at any tilt the summed power is unity, so the bed's level is the
  // gain alone.
  for (const tilt of [0, 0.17, 0.5, 0.83, 1]) {
    const power = Object.values(noiseMix(tilt)).reduce((a, g) => a + g * g, 0);
    assert.ok(Math.abs(power - 1) < 1e-12, `tilt ${tilt}`);
  }
});

// --- grid ---------------------------------------------------------------------

test('grid: distance matrix is symmetric with a zero diagonal', () => {
  const peers = [
    { jitsiId: 'a', rtt: 40 },
    { jitsiId: 'b', rtcRtt: 100 },
    { jitsiId: 'c', rtt: 10 }
  ];
  const { matrix } = distanceMatrix(peers);
  for (let i = 0; i < 3; i++) {
    assert.equal(matrix[i][i], 0);
    for (let j = 0; j < 3; j++) assert.equal(matrix[i][j], matrix[j][i]);
  }
  // (40/2 + 100/2) × 100 km = 7000 km between a and b.
  assert.equal(matrix[0][1], 7000);
});

test('grid: self is white, farthest peer is black, perspective is local', () => {
  const peers = [
    { jitsiId: 'me', rtt: 0 },
    { jitsiId: 'near', rtt: 20 },
    { jitsiId: 'far', rtt: 200 }
  ];
  const view = gridView(peers, 'me');
  const byId = Object.fromEntries(view.shades.map(s => [s.jitsiId, s]));
  assert.equal(byId.me.shade, 1);
  assert.equal(byId.far.shade, 0);
  assert.ok(byId.near.shade > 0 && byId.near.shade < 1);
  assert.equal(shadeForDistance(5, 0), 1, 'degenerate max → white');
});

// --- chain resolution ------------------------------------------------------------

test('parsed # chain resolves to full parameter sets and a merged visual state', () => {
  const { ast, errors } = parseMetaprogram(
    '$ participants <0 1>\n# room "wcl" 2\n# echo "wcl" 2 "wcpl" 0.3 "wcl" 3 1500 20 1200\n# crush "wcpl" 1\n# noise "wcl" 1 "wcpl" 10 0.5\n# grid true\n# ply 2\n'
  );
  assert.deepEqual(errors, []);
  const metrics = { wcl: 750, wcpl: 0.5 };
  const chain = computeChainParams(ast.chain, metrics, { cycleSeconds: 2, cyclePos: 0 });
  assert.deepEqual(chain.map(c => c.fn), ['room', 'echo', 'crush', 'noise', 'grid'], 'ply is scheduling, not a bus node');
  assert.equal(chain[0].params.decayS, 1.5);          // 2 × 750 ms
  assert.ok(Math.abs(chain[0].params.cutoffHz - CUTOFF_MAX_HZ / 19) < 1e-9); // 1.5 s tail → MAX / (1 + 1.5 × 12)
  assert.equal(chain[1].params.lengthCycles, 1);      // 2 × 750/1500
  assert.equal(chain[1].params.delayS, 2);            // 1 cycle × 2 s
  assert.equal(chain[1].params.feedback, 0.3);        // 50 % loss is past the 20 % bound → clamped
  assert.equal(chain[3].params.type, 'pink');         // wcl pinned at 0.5 s × 1 → halfway along the colour axis
  assert.equal(chain[3].params.gainDb, NOISE_MAX_DB); // wcpl 0.5 × 10 → clamped at the ceiling
  assert.equal(chain[4].params.landmarks, true);

  // The Hydra tint is the ONE channel anything reads, so it is the only one
  // published. The image counterparts of the same params (the crush divisor,
  // room's normalized cutoff, noise's grain) are asserted in
  // test/video-state.test.js, against the aggregator's compositor where they
  // are actually applied.
  const vis = visualStateFor(chain);
  assert.deepEqual(Object.keys(vis), ['brightness'], 'no channel is published that nothing reads');
  assert.equal(vis.brightness, 0.7);   // 1 − echo feedback
  // The params those image effects are computed FROM are still produced here.
  assert.equal(chain[2].params.visualPixelate, 4);
  assert.ok(Math.abs(chain[0].params.visualLowpass - 1 / 19) < 1e-12, 'a 1.5 s tail closes the lowpass to 1/19 open');
  assert.ok(Math.abs(chain[3].params.visualNoise - 0.35) < 1e-12,
    'pink grain, at full level (gain clamped at the ceiling)');
});

// Minimal WebAudio stand-in: enough surface for the crush and echo nodes, and
// call counters so a room node (whose four comb lines are the only reason a
// local chain would build several delays) and a noise node (the only one built
// from createBufferSource) are each detectable by their absence.
// `onNode` sees every node as it is created, for tests that need to read a
// node's live settings back.
function fakeAudioCtx({ onNode = () => {} } = {}) {
  const calls = { createDelay: 0, createBufferSource: 0 };
  const delays = [];
  const param = (v) => ({
    value: v,
    cancelScheduledValues() {},
    setValueAtTime() {},
    // Ramps are what the echo uses for gain changes; record the destination so
    // a test can read the value the parameter is heading for.
    linearRampToValueAtTime(target) { this.value = target; }
  });
  const make = (kind, extra = {}) => {
    const n = {
      kind, connect() {}, disconnect() {},
      gain: param(1), frequency: param(0), delayTime: param(0), threshold: param(0),
      curve: null,
      ...extra
    };
    onNode(n);
    return n;
  };
  return {
    sampleRate: 48000,
    currentTime: 0,
    calls,
    delays,
    createGain: () => make('gain'),
    createWaveShaper: () => make('waveshaper'),
    createBiquadFilter: () => make('biquad', { type: '' }),
    createDynamicsCompressor: () => make('compressor'),
    createDelay: () => { calls.createDelay++; const d = make('delay'); delays.push(d); return d; },
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => {
      calls.createBufferSource++;
      return make('buffersource', { buffer: null, loop: false, start() {}, stop() {} });
    }
  };
}

test('no audio effect builds a node in the local browser chain — the aggregator master owns all four', () => {
  const { ast, errors } = parseMetaprogram(
    '$ participants <0>\n# room "wcl" 2\n# noise "wcl" 1\n# crush "wcl" 1\n# echo\n');
  assert.deepEqual(errors, []);
  const ctx = fakeAudioCtx();
  const inserted = [];
  const mgr = new EffectsChainManager({ audioCtx: ctx, insert: (e) => inserted.push(e), remove: () => {} });
  try {
    mgr.setChain(ast.chain, { wcl: 500, wcpl: 0.5 });
    assert.equal(ctx.calls.createDelay, 0, 'no local Schroeder combs and no local echo line');
    assert.equal(ctx.calls.createBufferSource, 0, 'no local noise generators');
    // A second copy of any of these on the local bus is the bug this guards:
    // the room would hear the aggregator's mix reverbed, crushed or echoed
    // twice, once per client.
    assert.deepEqual(inserted, [], 'nothing spliced into the local master bus');

    // Re-deriving must not fall out of step now that every entry is skipped.
    mgr.updateMetrics({ wcl: 900, wcpl: 0.25 });
    assert.equal(ctx.calls.createDelay, 0);
    assert.equal(ctx.calls.createBufferSource, 0);
  } finally {
    mgr.dispose();
  }
});

test('patterned arguments re-derive as the cycle advances; constants do not tick', (t) => {
  // Every audio node having moved to the aggregator, this manager's observable
  // output is the state it publishes — so the pattern is read back through
  // crush's TEXT counterpart, the share of letters it drops, which follows the
  // same `reduction` the old pixelate channel did. A patterned METRIC rather
  // than a patterned scale, because reduction is driven by the metric and
  // deliberately not by the scale.
  const { ast, errors } = parseMetaprogram('$ participants <0>\n# crush <"wcl" "wcpl"> 1\n');
  assert.deepEqual(errors, []);
  let cyclePos = 0;
  withStubWindow((visual, text) => {
    const drop = () => text().text.dropChance;
    const mgr = new EffectsChainManager({
      audioCtx: fakeAudioCtx(), insert: () => {}, remove: () => {},
      getCycleContext: () => ({ cycleSeconds: 1, cyclePos })
    });
    // setChain arms a real 50 ms interval; without this an assertion failure
    // below would leave it running and `node --test` would never exit.
    t.after(() => mgr.dispose());

    mgr.setChain(ast.chain, { wcl: 300, wcpl: 0 });
    assert.equal(mgr.patternTicking(), true, 'a patterned chain arms the tick');
    assert.ok(drop() > 0, 'cycle 0 reads wcl — 300 ms is three halvings, so letters go');

    cyclePos = 1;
    mgr.refresh();
    assert.equal(drop(), 0, 'cycle 1 takes the second element, wcpl, which is clean');
    cyclePos = 2;
    mgr.refresh();
    assert.ok(drop() > 0, 'and wraps');

    // Metrics still move it within a cycle.
    mgr.updateMetrics({ wcl: 0, wcpl: 0 });
    assert.equal(drop(), 0, 'a clean wcl decimates nothing either');

    mgr.dispose();
    assert.equal(mgr.patternTicking(), false, 'dispose disarms the tick');

    // A constant-argument chain never arms it.
    const plain = parseMetaprogram('$ participants <0>\n# crush "wcl" 1\n').ast;
    mgr.setChain(plain.chain, { wcl: 100 });
    assert.equal(mgr.patternTicking(), false);
  });
});

// The manager's observable output for a master-bus effect is what it publishes
// on `window`: the Hydra tint (_jpVisual) and the text/css mutations the Text
// Cycles renderer applies (_jpText). Both readers are handed to the test.
function withStubWindow(fn) {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    return fn(() => globalThis.window._jpVisual, () => globalThis.window._jpText);
  } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
}

test('a master-bus-only chain inserts nothing locally but still publishes the visual', () => {
  const { ast } = parseMetaprogram('$ participants <0>\n# room "wcl" 2\n# noise "wcl" 1\n');
  const ctx = fakeAudioCtx();
  const inserted = [];
  withStubWindow((visual, text) => {
    const mgr = new EffectsChainManager({ audioCtx: ctx, insert: (e) => inserted.push(e), remove: () => {} });
    mgr.setChain(ast.chain, { wcl: 500 });
    assert.deepEqual(inserted, [], 'nothing spliced into the local master bus');
    // Read through the state this manager actually publishes: noise's bed
    // reaches the words as injected glyphs, room's decay as letter-spacing.
    assert.ok(text().text.noiseChars > 0, 'the bed still reaches the published state');
    assert.ok(text().text.spacingPx > 0, 'so does the reverb');
    assert.equal(visual().brightness, 1, 'no echo in this chain, so the tint is unity');
  });
});

test('patterned noise arguments follow the cycle the manager is given', () => {
  const { ast } = parseMetaprogram('$ participants <0>\n# noise "wcl" <1 20>\n');
  const ctx = fakeAudioCtx();
  let cycle = 0;
  withStubWindow((visual, text) => {
    const mgr = new EffectsChainManager({
      audioCtx: ctx, insert: () => {}, remove: () => {}, getCycleContext: () => ({ cycleSeconds: 1, cyclePos: cycle })
    });
    // setChain arms a real 50 ms interval now that noise's arguments are
    // patterned like any other effect's; without this the suite never exits.
    try {
    // Read the bed through the css jitter it drives — a continuous channel,
    // where the injected-glyph count is whole glyphs and would not separate
    // two nearby levels. With the cycle context unwired this stays on the
    // first element for ever.
    mgr.setChain(ast.chain, { wcl: 500 });
    const pinkBed = text().css.jitter;
    cycle = 1;
    mgr.updateMetrics({ wcl: 500 });
    const whiteBed = text().css.jitter;
    assert.ok(whiteBed > pinkBed,
      'the second element (factor 20 → white) takes over on the next cycle');
    // Anchored against the pure math so the assertion above cannot pass on a
    // coincidence: element 0 is tilt 0.5 (pink), element 1 is tilt 1 (white).
    const grainAt = (pos) => computeChainParams(ast.chain, { wcl: 500 }, { cyclePos: pos })[0].params.visualNoise;
    assert.ok(grainAt(1) > grainAt(0), 'the params the published state is derived from move the same way');
    } finally { mgr.dispose(); }
  });
});

// createEchoNode is the REFERENCE copy — the audible graph is inlined
// page-side in the aggregator (bots page-scripts.js buildEcho, asserted in
// bots/test/bot.test.js) — so what this checks is the shape both copies have
// to keep.
test('echo: the limiter sits on the wet path only, so an unclamped gain is loud rather than unbounded', () => {
  // gain is the user's parameter and is deliberately not clamped — a large one
  // must be loud, not unbounded. On the aggregator's master path the mix's own
  // gain staging is applied Node-side to the assembled buffer, upstream of
  // this graph, so nothing downstream of the delay would catch a large one.
  const loud = echoParams({ wcl: 500 }, {
    slots: [
      { param: 'length', metric: 'wcl', scale: 1, bound: 500 },
      { param: 'feedback', metric: 'wcl', scale: 0.5, bound: 500 },
      { param: 'gain', metric: 'wcl', scale: 5000, bound: 500 }
    ]
  }, { cycleSeconds: 1 });
  assert.equal(loud.gain, 5000, 'the parameter itself is the user\'s to set');

  const ctx = recordingCtx();
  const node = createEchoNode(ctx, loud);
  const compressors = [...new Set(ctx.edges.flat())].filter(n => n.startsWith('compressor#'));
  assert.equal(compressors.length, 1, 'the echo brings its own limiter');

  // It must sit on the WET path only: the dry signal reaches the output
  // untouched, and the limiter is what feeds the output.
  const sinksOf = (id) => ctx.edges.filter(([from]) => from === id).map(([, to]) => to);
  const outputId = [...new Set(ctx.edges.flat())].find(n => n.startsWith('gain#') && !sinksOf(n).length);
  assert.ok(sinksOf(compressors[0]).includes(outputId), 'the limiter feeds the output');
  assert.ok(sinksOf('gain#0').includes(outputId), 'the dry path bypasses it');
  node.dispose();
});

test('echo builds no local node, and its delay follows the cycle grid as well as the metrics', () => {
  const { ast, errors } = parseMetaprogram('$ participants <0>\n# echo "wcl" <1 2> "wcl" 0.5 "wcl" 1 1000\n');
  assert.deepEqual(errors, []);
  const ctx = fakeAudioCtx();
  const cycle = { cycleSeconds: 2, cyclePos: 0 };
  const mgr = new EffectsChainManager({
    audioCtx: ctx, insert: () => {}, remove: () => {}, getCycleContext: () => cycle
  });
  try {
    // The delay line lives on the aggregator's master bus; this manager owns
    // the derivation and the visual, so the grid has to move those and build
    // nothing.
    mgr.setChain(ast.chain, { wcl: 1000 });
    assert.equal(ctx.calls.createDelay, 0, 'a local delay line would echo the mix twice');

    const delayS = (metrics) =>
      computeChainParams(ast.chain, metrics, cycle).find(c => c.fn === 'echo').params.delayS;
    assert.equal(delayS({ wcl: 1000 }), 2, '1 cycle × 2 s at cycle 0');

    // Same metrics, next cycle: the pattern alone moves the delay.
    cycle.cyclePos = 1;
    assert.equal(delayS({ wcl: 1000 }), 4, '2 cycles × 2 s at cycle 1');

    // Same cycle, worse metrics: normalization is already at its ceiling, so a
    // longer cycle is what stretches the delay — the point of writing the
    // length in cycles rather than seconds.
    cycle.cycleSeconds = 3;
    assert.equal(delayS({ wcl: 9999 }), 6);
  } finally {
    mgr.dispose();
  }
});
