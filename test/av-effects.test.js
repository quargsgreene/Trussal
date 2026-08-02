import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  roomParams, rt60CombFeedback, createRoomNode,
  COMB_BASES_S, ALLPASS_BASES_S, CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, MAX_COMB_FEEDBACK
} from '../src/audio-net/av-effects/Room.js';
import { echoParams, echoFeedback, FEEDBACK_CEILING } from '../src/audio-net/av-effects/Echo.js';
import {
  crushParams, makeCrushCurve, crushMetricAmount,
  BASE_BIT_DEPTH, MAX_BIT_DEPTH, HALVING_AMOUNTS
} from '../src/audio-net/av-effects/Crush.js';
import { noiseTypeForWcpl, noiseParams, fillNoise } from '../src/audio-net/av-effects/Noise.js';
import { distanceMatrix, gridView, shadeForDistance } from '../src/audio-net/av-effects/Grid.js';
import { computeChainParams, visualStateFor, EffectsChainManager } from '../src/audio-net/av-effects/index.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';

// --- room ---------------------------------------------------------------------

test('room: decay = scale × wcl (RT60) sets per-comb feedback; cutoff = wcrtt × factor × 100 Hz', () => {
  const p = roomParams({ wcl: 500, wcrtt: 60 }, { scale: 2 });
  assert.equal(p.decayS, 1); // 2 × 500 ms
  // After decayS the recirculated signal is down 60 dB: g = 0.001^(delay/decay).
  p.combFeedbacks.forEach((g, i) => {
    assert.ok(Math.abs(g - Math.pow(0.001, COMB_BASES_S[i] / 1)) < 1e-12);
  });
  assert.deepEqual(p.combDelaysS, COMB_BASES_S, 'comb tunings no longer stretch');
  assert.equal(p.cutoffHz, 6000); // 60 ms × 1 × 100
  assert.ok(Math.abs(p.visualLowpass - 6000 / CUTOFF_MAX_HZ) < 1e-12);
});

test('room: fixedWclS pins the metric — live wcl is ignored', () => {
  const pinned = roomParams({ wcl: 9999, wcrtt: 60 }, { scale: 2, fixedWclS: 0.4 });
  assert.equal(pinned.decayS, 0.8); // 2 × 0.4 s, regardless of metrics.wcl
  const live = roomParams({ wcl: 400, wcrtt: 60 }, { scale: 2 });
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

test('room: cutoff clamps — zero RTT opens fully, huge RTT caps at max', () => {
  assert.equal(roomParams({ wcl: 0, wcrtt: 0 }).cutoffHz, CUTOFF_MAX_HZ);
  assert.equal(roomParams({ wcrtt: 1e6 }).cutoffHz, CUTOFF_MAX_HZ);
  assert.equal(roomParams({ wcrtt: 0.1 }).cutoffHz, CUTOFF_MIN_HZ); // 10 Hz → floor
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
      connect(target) { edges.push([node.id, target.id]); },
      disconnect() {}
    };
    return node;
  };
  return {
    edges,
    createGain: () => mk('gain'),
    createDelay: () => mk('delay'),
    createBiquadFilter: () => Object.assign(mk('biquad'), { type: '' })
  };
}

test('room: allpass stages are chained in series, each feeding the next', () => {
  const ctx = recordingCtx();
  createRoomNode(ctx, roomParams({ wcl: 200, wcrtt: 60 }, { scale: 2 }));

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

test('echo: n_samples = factor × wcj × 100; delay converts by sample rate', () => {
  const p = echoParams({ wcj: 5, wcpl: 0.5 }, { nSamplesFactor: 2 }, 48000);
  assert.equal(p.nSamples, 1000); // 2 × 5 × 100
  assert.ok(Math.abs(p.delayS - 1000 / 48000) < 1e-12);
});

test('echo: feedback clamps below unity and survives wcpl = 0 (spec erratum)', () => {
  assert.equal(echoFeedback(0, 0.1), FEEDBACK_CEILING);      // 0.1/ε would explode → ceiling
  assert.equal(echoFeedback(0.5, 0.1), 0.2);                 // 0.1/0.5
  assert.equal(echoFeedback(1, 0.1), 0.1);
  assert.ok(echoFeedback(0.001, 5) <= FEEDBACK_CEILING);
  const p = echoParams({ wcj: 1, wcpl: 0.5 }, { magnitudeFeedbackFactor: 0.1 });
  assert.equal(p.visualBrightness, p.feedback, 'video brightness uses the clamped value');
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
  assert.deepEqual(Object.keys(HALVING_AMOUNTS).sort(), ['wcj', 'wcl', 'wcpl', 'wcrtt']);
  const metrics = { wcl: 100, wcj: 20, wcrtt: 100, wcpl: 0.25 };
  // One halving of the 8-bit base for each metric at its own halving amount.
  for (const metric of Object.keys(HALVING_AMOUNTS)) {
    assert.equal(crushParams(metrics, { metric }).bitDepth, 4, metric);
  }
  // A metric the room has not measured yet reads as 0 — no crush, not NaN.
  assert.equal(crushParams({}, { metric: 'wcrtt' }).bitDepth, BASE_BIT_DEPTH);
});

test('crush: a fixed third argument pins the metric, in the metric\'s own unit', () => {
  // Durations are pinned in SECONDS (as `# room wcl 2 0.4` pins wcl).
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
  const metrics = { wcl: 100, wcj: 20 };
  const alt = { type: 'valueSeq', mode: 'alternate', terms: [1, 2] };
  // <1 2> on the scale: cycle 0 → 8-bit base, cycle 1 → 16-bit base.
  assert.equal(crushParams(metrics, { scale: alt }, 0).bitDepth, 4);
  assert.equal(crushParams(metrics, { scale: alt }, 1).bitDepth, 8);
  assert.equal(crushParams(metrics, { scale: alt }, 2).bitDepth, 4);
  // Mid-cycle reads the same value as the boundary did — <> is per cycle.
  assert.equal(crushParams(metrics, { scale: alt }, 1.75).bitDepth, 8);

  // A patterned METRIC switches what is driving the crush.
  const metricPat = { type: 'valueSeq', mode: 'alternate', terms: ['wcl', 'wcj'] };
  assert.equal(crushParams(metrics, { metric: metricPat }, 0).metric, 'wcl');
  assert.equal(crushParams(metrics, { metric: metricPat }, 1).metric, 'wcj');

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

test('noise thresholds incl. every boundary value from the plan', () => {
  assert.equal(noiseTypeForWcpl(0), 'none');
  assert.equal(noiseTypeForWcpl(0.09), 'none');
  assert.equal(noiseTypeForWcpl(0.1), 'brown');
  assert.equal(noiseTypeForWcpl(0.29), 'brown');
  assert.equal(noiseTypeForWcpl(0.3), 'pink');
  assert.equal(noiseTypeForWcpl(0.59), 'pink');
  assert.equal(noiseTypeForWcpl(0.6), 'pink');   // "greater than 0.6" is white
  assert.equal(noiseTypeForWcpl(0.61), 'white');
  assert.equal(noiseParams({ wcpl: 0.05 }).gain, 0);
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
    '$ participants <0 1>\n# room wcl 2\n# echo 1 0.1\n# crush wcpl 1\n# noise\n# grid true\n# ply 2\n'
  );
  assert.deepEqual(errors, []);
  const metrics = { wcl: 500, wcj: 5, wcrtt: 60, wcpl: 0.5 };
  const chain = computeChainParams(ast.chain, metrics, 48000);
  assert.deepEqual(chain.map(c => c.fn), ['room', 'echo', 'crush', 'noise', 'grid'], 'ply is scheduling, not a bus node');
  assert.equal(chain[0].params.decayS, 1);       // 2 × 500 ms
  assert.equal(chain[0].params.cutoffHz, 6000);  // 60 ms × 100; wcrtt_factor is no longer settable
  assert.equal(chain[1].params.feedback, 0.2);
  assert.equal(chain[3].params.type, 'pink');
  assert.equal(chain[4].params.landmarks, true);

  const vis = visualStateFor(chain);
  assert.equal(vis.brightness, 0.2);   // echo feedback
  assert.equal(vis.pixelate, 4);       // crush divisor
  assert.equal(vis.noise, 0.35);       // pink
  assert.equal(vis.lowpass, 6000 / CUTOFF_MAX_HZ, 'room still drives the Hydra blur');
});

// Minimal WebAudio stand-in: enough surface for the crush node, and a call
// counter so a room node (the only effect built from createDelay) is
// detectable by its absence. `onNode` sees every node as it is created, for
// tests that need to read a node's live settings back.
function fakeAudioCtx({ onNode = () => {} } = {}) {
  const calls = { createDelay: 0 };
  const make = (kind, extra = {}) => {
    const n = {
      kind, connect() {}, disconnect() {},
      gain: { value: 1 }, frequency: { value: 0 }, delayTime: { value: 0 }, curve: null,
      ...extra
    };
    onNode(n);
    return n;
  };
  return {
    sampleRate: 48000,
    calls,
    createGain: () => make('gain'),
    createWaveShaper: () => make('waveshaper'),
    createBiquadFilter: () => make('biquad', { type: '' }),
    createDelay: () => { calls.createDelay++; return make('delay'); }
  };
}

test('room builds no node in the local browser chain — the aggregator master owns it', () => {
  const { ast, errors } = parseMetaprogram('$ participants <0>\n# room wcl 2\n# crush wcl 1\n');
  assert.deepEqual(errors, []);
  const ctx = fakeAudioCtx();
  const inserted = [];
  const mgr = new EffectsChainManager({ audioCtx: ctx, insert: (e) => inserted.push(e), remove: () => {} });

  mgr.setChain(ast.chain, { wcl: 500, wcrtt: 60, wcpl: 0.5 });
  assert.equal(ctx.calls.createDelay, 0, 'no local Schroeder comb lines');
  assert.equal(inserted.length, 1, 'crush alone still gets a local master insert');

  // A metrics update must not fall out of step now that room is skipped:
  // crush is nodes[0] even though room precedes it in the chain.
  mgr.updateMetrics({ wcl: 900, wcrtt: 60, wcpl: 0.25 });
  assert.equal(ctx.calls.createDelay, 0);
});

test('patterned arguments re-derive as the cycle advances; constants do not tick', (t) => {
  const shapers = [];
  const ctx = fakeAudioCtx({ onNode: (n) => { if (n.kind === 'waveshaper') shapers.push(n); } });

  let cyclePos = 0;
  const { ast } = parseMetaprogram('$ participants <0>\n# crush wcl <1 2>\n');
  const mgr = new EffectsChainManager({
    audioCtx: ctx, insert: () => {}, remove: () => {}, getCyclePosition: () => cyclePos
  });
  // setChain arms a real 50 ms interval; without this an assertion failure
  // below would leave it running and `node --test` would never exit.
  t.after(() => mgr.dispose());

  // wcl 100 ms halves the base: scale 1 → 4 bits, scale 2 → 8 bits.
  mgr.setChain(ast.chain, { wcl: 100 });
  assert.equal(mgr.patternTicking(), true, 'a patterned chain arms the tick');
  const levels = () => new Set(Array.from(shapers[0].curve).map(v => v.toFixed(6))).size;
  assert.equal(levels(), 2 ** 4);

  cyclePos = 1;
  mgr.refresh();
  assert.equal(levels(), 2 ** 8, 'cycle 1 takes the second element of <1 2>');
  cyclePos = 2;
  mgr.refresh();
  assert.equal(levels(), 2 ** 4, 'and wraps');

  // Metrics still move it within a cycle.
  mgr.updateMetrics({ wcl: 0 });
  assert.equal(levels(), 2 ** 8, 'cycle 2 → scale 1 → the plain 8-bit resting depth');

  mgr.dispose();
  assert.equal(mgr.patternTicking(), false, 'dispose disarms the tick');

  // A constant-argument chain never arms it.
  const plain = parseMetaprogram('$ participants <0>\n# crush wcl 1\n').ast;
  mgr.setChain(plain.chain, { wcl: 100 });
  assert.equal(mgr.patternTicking(), false);
});

test('a room-only chain inserts nothing locally but still publishes the visual', () => {
  const { ast } = parseMetaprogram('$ participants <0>\n# room wcl 2\n');
  const ctx = fakeAudioCtx();
  const inserted = [];
  const mgr = new EffectsChainManager({ audioCtx: ctx, insert: (e) => inserted.push(e), remove: () => {} });
  mgr.setChain(ast.chain, { wcl: 500, wcrtt: 60 });
  assert.deepEqual(inserted, [], 'nothing spliced into the local master bus');
});
