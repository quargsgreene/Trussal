import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  roomParams, rt60CombFeedback, createRoomNode,
  COMB_BASES_S, ALLPASS_BASES_S, CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, MAX_COMB_FEEDBACK
} from '../src/audio-net/av-effects/Room.js';
import { echoParams, echoFeedback, FEEDBACK_CEILING } from '../src/audio-net/av-effects/Echo.js';
import { crushParams, makeCrushCurve } from '../src/audio-net/av-effects/Crush.js';
import {
  noiseParams, fillNoise, normalizeRms, noiseGainForDb, noiseMix,
  NOISE_BASE_DB, NOISE_MAX_DB, NOISE_BASE_GAIN, NOISE_RMS
} from '../src/audio-net/av-effects/Noise.js';
import { distanceMatrix, gridView, shadeForDistance } from '../src/audio-net/av-effects/Grid.js';
import { computeChainParams, visualStateFor, EffectsChainManager } from '../src/audio-net/av-effects/index.js';
import { parseMetaprogram, resolveEffectParams } from '../src/audio-net/MetaprogrammerParser.js';

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

// Resolve `# noise …` the way the aggregator does, so these exercise the
// written syntax rather than a hand-built parameter object.
function noiseFor(line, metrics, cycle = 0) {
  const { ast, errors } = parseMetaprogram(`$ participants <0>\n${line}\n`);
  assert.deepEqual(errors, [], `${line} should parse`);
  return noiseParams(metrics, resolveEffectParams(ast.chain[0], { cycle }));
}

test('noise: a bare directive is the unmodulated floor — brown at the base dB', () => {
  const p = noiseFor('# noise', { wcl: 500, wcrtt: 60, wcpl: 0.9 });
  assert.equal(p.tilt, 0);
  assert.equal(p.gainDb, NOISE_BASE_DB);
  assert.equal(p.gain, NOISE_BASE_GAIN, 'the level the fixed-gain implementation ran at');
  assert.equal(p.type, 'brown');
  assert.deepEqual(p.mix, { brown: 1, pink: 0, white: 0 });
});

test('noise: the spectrum factor sweeps brown → pink → white', () => {
  // wcl 500 ms = 0.5 s, so factor 1 lands exactly halfway along the axis.
  const pink = noiseFor('# noise wcl 1', { wcl: 500 });
  assert.equal(pink.tilt, 0.5);
  assert.equal(pink.type, 'pink');
  assert.deepEqual(pink.mix, { brown: 0, pink: 1, white: 0 });

  const brownish = noiseFor('# noise wcl 0.4', { wcl: 500 });
  assert.equal(brownish.tilt, 0.2);
  assert.equal(brownish.type, 'brown', 'nearest colour is the label; the mix is a blend');
  assert.ok(brownish.mix.brown > brownish.mix.pink && brownish.mix.pink > 0);
  // Equal-power: uncorrelated generators sum in POWER, so the bed keeps its
  // level across the sweep instead of dipping in the middle.
  const power = Object.values(brownish.mix).reduce((a, g) => a + g * g, 0);
  assert.ok(Math.abs(power - 1) < 1e-12);

  const white = noiseFor('# noise wcl 20', { wcl: 500 });
  assert.equal(white.tilt, 1, 'clamped at the top of the axis');
  assert.deepEqual(white.mix, { brown: 0, pink: 0, white: 1 });
});

test('noise: the volume factor rides its own metric from the base dB to the clamp', () => {
  // wcrtt 60 ms = 0.06 s × 10 = 0.6 of the way from 25 dB to 75 dB.
  const p = noiseFor('# noise wcl 1 wcrtt 10', { wcl: 500, wcrtt: 60 });
  assert.equal(p.gainDb, 55);
  assert.ok(Math.abs(p.gain - NOISE_BASE_GAIN * Math.pow(10, 30 / 20)) < 1e-12);

  const loud = noiseFor('# noise wcl 1 wcrtt 1000', { wcl: 500, wcrtt: 60 });
  assert.equal(loud.gainDb, NOISE_MAX_DB, 'clamped at 75 dB');
  assert.ok(Math.abs(loud.gain - NOISE_BASE_GAIN * Math.pow(10, 50 / 20)) < 1e-12);
  assert.equal(noiseGainForDb(1e6), noiseGainForDb(NOISE_MAX_DB), 'the clamp is the ceiling');
});

test('noise: each axis modulates only when its own factor is written', () => {
  // Spectrum named, volume not: the bed brightens but stays at the floor.
  const p = noiseFor('# noise wcl 1', { wcl: 500, wcrtt: 60 });
  assert.equal(p.tilt, 0.5);
  assert.equal(p.gainDb, NOISE_BASE_DB);
  // A metric keyword alone implies factor 1, as `# room wcl` does.
  assert.equal(noiseFor('# noise wcl', { wcl: 500 }).tilt, 0.5);
  // Bare numbers take the default metric, wcl, for both axes.
  const both = noiseFor('# noise 1 1', { wcl: 500, wcrtt: 60 });
  assert.equal(both.tilt, 0.5);
  assert.equal(both.gainDb, 50); // 25 + 0.5 × 50, from wcl again — not wcrtt
});

test('noise: the 5th and 6th arguments pin the metrics in written order', () => {
  const pinned = noiseFor('# noise wcl 1 wcrtt 10 0.5 0.06', { wcl: 9999, wcrtt: 9999 });
  const live = noiseFor('# noise wcl 1 wcrtt 10', { wcl: 500, wcrtt: 60 });
  assert.equal(pinned.tilt, live.tilt, '0.5 s pinned ≡ 500 ms measured');
  assert.equal(pinned.gainDb, live.gainDb, '0.06 s pinned ≡ 60 ms measured');
  // The amounts are positional, so pinning the spectrum metric means writing
  // a volume factor first — as `# cycles wcl 10 0.3` needs its scale first.
  // wcpl is a fraction, not seconds, and pins on its own scale.
  assert.equal(noiseFor('# noise wcpl 2 1 0.25', { wcpl: 0, wcl: 0 }).tilt, 0.5);
});

test('noise: patterned arguments advance one element per cycle', () => {
  const metrics = { wcl: 500 };
  const tiltAt = (c) => noiseFor('# noise wcl <1 0.5 20>', metrics, c).tilt;
  assert.deepEqual([0, 1, 2, 3].map(tiltAt), [0.5, 0.25, 1, 0.5]);
  // The metric keyword itself may alternate.
  const metricAt = (c) => noiseFor('# noise <wcl wcpl> 1', { wcl: 500, wcpl: 0.25 }, c).tilt;
  assert.deepEqual([0, 1].map(metricAt), [0.5, 0.25]);
  // Nested groups advance once per visit of the parent.
  const nested = (c) => noiseFor('# noise wcl <1 <0.5 20>>', metrics, c).tilt;
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
    '$ participants <0 1>\n# room wcl 2\n# echo 1 0.1\n# crush 1\n# noise wcl 1 wcrtt 10\n# grid true\n# ply 2\n'
  );
  assert.deepEqual(errors, []);
  const metrics = { wcl: 500, wcj: 5, wcrtt: 60, wcpl: 0.5 };
  const chain = computeChainParams(ast.chain, metrics, 48000);
  assert.deepEqual(chain.map(c => c.fn), ['room', 'echo', 'crush', 'noise', 'grid'], 'ply is scheduling, not a bus node');
  assert.equal(chain[0].params.decayS, 1);       // 2 × 500 ms
  assert.equal(chain[0].params.cutoffHz, 6000);  // 60 ms × 100; wcrtt_factor is no longer settable
  assert.equal(chain[1].params.feedback, 0.2);
  assert.equal(chain[3].params.type, 'pink');    // wcl 0.5 s × 1 → halfway along the colour axis
  assert.equal(chain[3].params.gainDb, 55);      // wcrtt 0.06 s × 10 → 0.6 of 25…75 dB
  assert.equal(chain[4].params.landmarks, true);

  const vis = visualStateFor(chain);
  assert.equal(vis.brightness, 0.2);   // echo feedback
  assert.equal(vis.pixelate, 4);       // crush divisor
  assert.ok(Math.abs(vis.noise - 0.35 * (55 / NOISE_MAX_DB)) < 1e-12, 'pink grain, scaled by level');
  assert.equal(vis.lowpass, 6000 / CUTOFF_MAX_HZ, 'room still drives the Hydra blur');
});

// Minimal WebAudio stand-in: enough surface for the crush node, and call
// counters so a room node (the only effect built from createDelay) and a
// noise node (the only one built from createBufferSource) are each detectable
// by their absence.
function fakeAudioCtx() {
  const calls = { createDelay: 0, createBufferSource: 0 };
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 }, frequency: { value: 0 } });
  return {
    sampleRate: 48000,
    calls,
    createGain: node,
    createWaveShaper: node,
    createBiquadFilter: () => ({ ...node(), type: '' }),
    createDelay: () => { calls.createDelay++; return node(); },
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => { calls.createBufferSource++; return { ...node(), buffer: null, loop: false, start() {}, stop() {} }; }
  };
}

test('room and noise build no node in the local browser chain — the aggregator master owns them', () => {
  const { ast, errors } = parseMetaprogram('$ participants <0>\n# room wcl 2\n# noise wcl 1\n# crush 1\n');
  assert.deepEqual(errors, []);
  const ctx = fakeAudioCtx();
  const inserted = [];
  const mgr = new EffectsChainManager({ audioCtx: ctx, insert: (e) => inserted.push(e), remove: () => {} });

  mgr.setChain(ast.chain, { wcl: 500, wcrtt: 60, wcpl: 0.5 });
  assert.equal(ctx.calls.createDelay, 0, 'no local Schroeder comb lines');
  assert.equal(ctx.calls.createBufferSource, 0, 'no local noise generators');
  assert.equal(inserted.length, 1, 'crush alone still gets a local master insert');

  // A metrics update must not fall out of step now that both are skipped:
  // crush is nodes[0] even though room and noise precede it in the chain.
  mgr.updateMetrics({ wcl: 900, wcrtt: 60, wcpl: 0.25 });
  assert.equal(ctx.calls.createDelay, 0);
  assert.equal(ctx.calls.createBufferSource, 0);
});

// The manager's only observable output for a master-bus effect is the visual
// state it publishes on `window`, so these stub one to read it back.
function withStubWindow(fn) {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    return fn(() => globalThis.window._ncVisual);
  } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
}

test('a master-bus-only chain inserts nothing locally but still publishes the visual', () => {
  const { ast } = parseMetaprogram('$ participants <0>\n# room wcl 2\n# noise wcl 1\n');
  const ctx = fakeAudioCtx();
  const inserted = [];
  withStubWindow((visual) => {
    const mgr = new EffectsChainManager({ audioCtx: ctx, insert: (e) => inserted.push(e), remove: () => {} });
    mgr.setChain(ast.chain, { wcl: 500, wcrtt: 60 });
    assert.deepEqual(inserted, [], 'nothing spliced into the local master bus');
    assert.ok(visual().noise > 0, 'the bed still reaches the visual state');
    assert.ok(visual().lowpass < 1, 'so does the reverb');
  });
});

test('patterned noise arguments follow the cycle the manager is given', () => {
  const { ast } = parseMetaprogram('$ participants <0>\n# noise wcl <1 20>\n');
  const ctx = fakeAudioCtx();
  let cycle = 0;
  withStubWindow((visual) => {
    const mgr = new EffectsChainManager({
      audioCtx: ctx, insert: () => {}, remove: () => {}, getCycle: () => cycle
    });
    // Read the grain the manager published — with getCycle unwired this stays
    // on the first element for ever.
    mgr.setChain(ast.chain, { wcl: 500 });
    const pinkGrain = visual().noise;
    cycle = 1;
    mgr.updateMetrics({ wcl: 500 });
    const whiteGrain = visual().noise;
    assert.ok(whiteGrain > pinkGrain,
      'the second element (factor 20 → white) takes over on the next cycle');
    // Anchored against the pure math so the assertion above cannot pass on a
    // coincidence: element 0 is tilt 0.5 (pink), element 1 is tilt 1 (white).
    assert.equal(pinkGrain, computeChainParams(ast.chain, { wcl: 500 }, 48000, 0)[0].params.visualNoise);
    assert.equal(whiteGrain, computeChainParams(ast.chain, { wcl: 500 }, 48000, 1)[0].params.visualNoise);
  });
});
