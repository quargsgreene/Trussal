import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  roomParams, rt60CombFeedback, COMB_BASES_S, CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, MAX_COMB_FEEDBACK
} from '../src/audio-net/av-effects/Room.js';
import { echoParams, echoFeedback, FEEDBACK_CEILING } from '../src/audio-net/av-effects/Echo.js';
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
    '$ participants <0 1>\n# room wcl 2\n# echo 1 0.1\n# crush 1\n# noise\n# grid true\n# ply 2\n'
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
// detectable by its absence.
function fakeAudioCtx() {
  const calls = { createDelay: 0 };
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 }, frequency: { value: 0 } });
  return {
    sampleRate: 48000,
    calls,
    createGain: node,
    createWaveShaper: node,
    createBiquadFilter: () => ({ ...node(), type: '' }),
    createDelay: () => { calls.createDelay++; return node(); }
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
