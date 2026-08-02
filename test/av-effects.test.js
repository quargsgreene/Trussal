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
import { sampleNumberPattern } from '../src/audio-net/NumberPattern.js';
import { crushParams, makeCrushCurve } from '../src/audio-net/av-effects/Crush.js';
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

// The spec example: `# echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200`.
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

test('echo: bare # echo defaults to wcl at 0.5 cycles / 0.5 feedback / unity gain', () => {
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
  // feedback: wcj is flat while wcl is high. Below the quantum the DelayNode
  // would ring as a fixed ~375 Hz comb at near-unity feedback.
  const sliver = echoParams({ wcj: 0.001, wcl: 500 }, {
    slots: [
      { param: 'length', metric: 'wcj', scale: 0.000001, bound: 50 },
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
      { param: 'length', metric: 'wcl', scale: { type: 'numseq', mode: 'alternate', values: [2, 3, 0.5] }, bound: 1000 },
      { param: 'feedback', metric: 'wcl', scale: 0.5, bound: 1000 },
      { param: 'gain', metric: 'wcl', scale: { type: 'numseq', mode: 'subdivide', values: [1, 4] }, bound: 1000 }
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

test('number patterns nest: <> alternates per outer cycle, [] subdivides its own span', () => {
  const nested = { type: 'numseq', mode: 'subdivide', values: [1, { type: 'numseq', mode: 'subdivide', values: [2, 3] }] };
  assert.equal(sampleNumberPattern(nested, 0.25), 1);
  assert.equal(sampleNumberPattern(nested, 0.6), 2);   // second half, first of its two steps
  assert.equal(sampleNumberPattern(nested, 0.9), 3);

  const alt = { type: 'numseq', mode: 'subdivide', values: [1, { type: 'numseq', mode: 'alternate', values: [2, 3] }] };
  assert.equal(sampleNumberPattern(alt, 4.75), 2, 'even outer cycle');
  assert.equal(sampleNumberPattern(alt, 5.75), 3, 'odd outer cycle');

  assert.equal(sampleNumberPattern(7, 3.2), 7, 'plain numbers pass through');
});

// --- crush --------------------------------------------------------------------

test('crush: ×2 reduction per 25 % loss, scaled by reduction_factor', () => {
  assert.equal(crushParams({ wcpl: 0 }).reduction, 1);
  assert.equal(crushParams({ wcpl: 0.25 }).reduction, 2);
  assert.equal(crushParams({ wcpl: 0.5 }).reduction, 4);
  assert.equal(crushParams({ wcpl: 0.5 }, { reductionFactor: 2 }).reduction, 8);
  const p = crushParams({ wcpl: 0.5 });
  assert.equal(p.bitDepth, 4);      // 16 / 4
  assert.equal(p.srDivisor, 4);
  assert.equal(p.visualPixelate, 4); // same decimation on pixels
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
    '$ participants <0 1>\n# room wcl 2\n# echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200\n# crush 1\n# noise\n# grid true\n# ply 2\n'
  );
  assert.deepEqual(errors, []);
  const metrics = { wcl: 750, wcj: 5, wcrtt: 60, wcpl: 0.5 };
  const chain = computeChainParams(ast.chain, metrics, { cycleSeconds: 2, cyclePos: 0 });
  assert.deepEqual(chain.map(c => c.fn), ['room', 'echo', 'crush', 'noise', 'grid'], 'ply is scheduling, not a bus node');
  assert.equal(chain[0].params.decayS, 1.5);     // 2 × 750 ms
  assert.equal(chain[0].params.cutoffHz, 6000);  // 60 ms × 100; wcrtt_factor is no longer settable
  assert.equal(chain[1].params.lengthCycles, 1); // 2 × 750/1500
  assert.equal(chain[1].params.delayS, 2);       // 1 cycle × 2 s
  assert.equal(chain[1].params.feedback, 0.3);   // 50 % loss is past the 20 % bound → clamped
  assert.equal(chain[3].params.type, 'pink');
  assert.equal(chain[4].params.landmarks, true);

  const vis = visualStateFor(chain);
  assert.equal(vis.brightness, 0.7);   // 1 − echo feedback
  assert.equal(vis.pixelate, 4);       // crush divisor
  assert.equal(vis.noise, 0.35);       // pink
  assert.equal(vis.lowpass, 6000 / CUTOFF_MAX_HZ, 'room still drives the Hydra blur');
});

// Minimal WebAudio stand-in: enough surface for the crush and echo nodes, and
// a call counter so a room node (whose four comb lines are the only reason a
// local chain would build several delays) is detectable by its absence.
function fakeAudioCtx() {
  const calls = { createDelay: 0 };
  const delays = [];
  const param = (v) => ({
    value: v,
    cancelScheduledValues() {},
    setValueAtTime() {},
    // Ramps are what the echo uses for gain changes; record the destination so
    // a test can read the value the parameter is heading for.
    linearRampToValueAtTime(target) { this.value = target; }
  });
  const node = () => ({
    connect() {}, disconnect() {},
    gain: param(1), frequency: param(0), delayTime: param(0), threshold: param(0)
  });
  return {
    sampleRate: 48000,
    currentTime: 0,
    calls,
    delays,
    createGain: node,
    createWaveShaper: node,
    createBiquadFilter: () => ({ ...node(), type: '' }),
    createDynamicsCompressor: node,
    createDelay: () => { calls.createDelay++; const d = node(); delays.push(d); return d; }
  };
}

test('room builds no node in the local browser chain — the aggregator master owns it', () => {
  const { ast, errors } = parseMetaprogram('$ participants <0>\n# room wcl 2\n# crush 1\n');
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

test('a room-only chain inserts nothing locally but still publishes the visual', () => {
  const { ast } = parseMetaprogram('$ participants <0>\n# room wcl 2\n');
  const ctx = fakeAudioCtx();
  const inserted = [];
  const mgr = new EffectsChainManager({ audioCtx: ctx, insert: (e) => inserted.push(e), remove: () => {} });
  mgr.setChain(ast.chain, { wcl: 500, wcrtt: 60 });
  assert.deepEqual(inserted, [], 'nothing spliced into the local master bus');
});

test('echo: the wet path is limited, because this chain runs after the per-peer limiters', () => {
  // gain is the user's parameter and is deliberately not clamped — a large one
  // must be loud, not unbounded: insertMasterChain splices this chain between
  // realDestination and the context destination, downstream of every per-peer
  // limiter, so nothing else stands between it and the speakers.
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

test('echo does build a local node, and follows the cycle grid as well as the metrics', () => {
  const { ast, errors } = parseMetaprogram('$ participants <0>\n# echo wcl <1 2> wcl 0.5 wcl 1 1000\n');
  assert.deepEqual(errors, []);
  const ctx = fakeAudioCtx();
  const cycle = { cycleSeconds: 2, cyclePos: 0 };
  const mgr = new EffectsChainManager({
    audioCtx: ctx, insert: () => {}, remove: () => {}, getCycleContext: () => cycle
  });

  mgr.setChain(ast.chain, { wcl: 1000 });
  assert.equal(ctx.calls.createDelay, 1, 'echo runs in the local browser chain, unlike room');
  assert.equal(ctx.delays[0].delayTime.value, 2, '1 cycle × 2 s at cycle 0');

  // Same metrics, next cycle: the pattern alone moves the delay.
  cycle.cyclePos = 1;
  mgr.updateMetrics({ wcl: 1000 });
  assert.equal(ctx.delays[0].delayTime.value, 4, '2 cycles × 2 s at cycle 1');
  assert.equal(ctx.calls.createDelay, 1, 'parameters re-derive; the graph is not rebuilt');

  // Same cycle, worse metrics: normalization is already at its ceiling, so a
  // longer cycle is what stretches the delay.
  cycle.cycleSeconds = 3;
  mgr.updateMetrics({ wcl: 9999 });
  assert.equal(ctx.delays[0].delayTime.value, 6);

  mgr.dispose();
});
