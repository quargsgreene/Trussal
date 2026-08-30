// crush — bit-depth and sample-rate reduction for audio and pixels, driven by
// a worst-case network metric.
//
//   base      = 8 bits × scale          (`# crush wcl 2` → a 16-bit base)
//   reduction = 2^(amount / halving)    amount = the metric, live or pinned
//   bitDepth  = clamp(base / reduction, 1, 16)
//   srDivisor = clamp(round(reduction), 1, 64)   (sample-and-hold period)
//
// 8 bits is the resting depth and the metric eats into it: at the default
// scale, wcl of 0 ms is 8 bits, 100 ms is 4, 200 ms is 2. The scale factor
// multiplies that resting depth, so raising it crushes LESS. Sample-rate
// reduction follows the metric alone, not the scale, so a clean room
// decimates nothing whatever base the performer asked for.
//
// WHERE THE METRICS ACTUALLY SIT — the resting depth is a ceiling, not a
// typical value, and for wcl it is not reachable at all. wcl is mouth-to-ear
// (worstCaseOneWayLatency: both network legs + the de-jitter buffer + the
// rig's own capture/encode/playout pipeline, which falls back to
// PIPELINE_ALLOWANCE_MS = 40 ms for a rig that has not measured itself), so
// even a healthy LAN room reads roughly 90-150 ms. `# crush wcl 1` therefore
// rests near 4 bits, and `# crush wcl 2` — the studio toggle's line — near 8.
// This follows from one halving amount per metric; move HALVING_AMOUNTS if a
// room wants a different resting point, and note that a scale below 1 crushes
// harder rather than less.
//
// `# crush <metric> <scale> [<fixed metric amount>]` — with the optional third
// token the metric is pinned (seconds for wcl, a loss fraction for
// wcpl) and live metrics no longer move it, exactly as `# room`'s third token
// pins wcl. Any of the three may be a mini-notation pattern instead of a
// constant, read at the caller's position on the cycle grid.
//
// Like every other audio effect, the node runs on the AGGREGATOR's master
// path (the mix every client hears), not in each browser: bots/src/bot/
// page-scripts.js pageMasterPlayer inlines this graph, because the
// page-script contract forbids imports. createCrushNode below is therefore
// the reference copy rather than the audible one — bot.test.js compares the
// two curves so they cannot drift apart.
//
// The same decimation applies to pixels: visualPixelate is the pixel-block
// edge for the Hydra counterpart, which browsers DO still compute locally.
// Pure math is separated from node construction for node:test.

import { evaluateValuePattern } from '../ValuePattern.js';

export const BASE_BIT_DEPTH = 8;
export const MIN_BIT_DEPTH = 1;
export const MAX_BIT_DEPTH = 16;
export const MAX_SR_DIVISOR = 64;

// How much of a metric halves the bit depth. One constant per metric because
// the metrics are not on one scale: mouth-to-ear latency runs to hundreds of
// ms, loss is a fraction. Each is set so the metric's real operating range
// spends the bit budget rather than sitting at either rail — the wcpl figure
// keeps the "a factor of 2 per 25 % packet loss" this effect has always had.
export const HALVING_AMOUNTS = { wcl: 100, wcpl: 0.25 };

export const DEFAULT_METRIC = 'wcl';

// The metric's current amount in its own units — ms for the durations, a
// fraction for loss. A pinned amount is quoted in SECONDS for the durations
// (0.4 = 400 ms), matching `# room wcl 2 0.4` and `# cycles`.
//
// Loss is clamped to [0, 1] whichever way it arrives. computeWorstCaseMetrics
// clamps what it measures and IncreasePacketLoss clamps what a performer
// induces, but a PINNED `# crush wcpl 1 5` reaches here having passed only
// the parser's "positive real" check — 500 % loss is not a network state, and
// unclamped it reports a reduction of 2^20 to anything reading these params.
export function crushMetricAmount(metric, metrics, fixed = null) {
  const clamp = (v) => (metric === 'wcpl' ? Math.min(1, Math.max(0, v)) : Math.max(0, v));
  if (Number.isFinite(fixed) && fixed >= 0) {
    return clamp(metric === 'wcpl' ? fixed : fixed * 1000);
  }
  const m = metrics || {};
  const live = metric === 'wcpl' ? m.wcpl : m[metric];
  return clamp(Number.isFinite(live) ? live : 0);
}

export function crushParams(metrics, user = {}, cyclePos = 0) {
  const metricRaw = evaluateValuePattern(user.metric ?? DEFAULT_METRIC, cyclePos);
  // hasOwn, not truthiness: HALVING_AMOUNTS is a plain object, so a leaf of
  // 'constructor' or 'toString' would inherit a truthy value off the
  // prototype, pass as a metric, and make every number below NaN.
  const metric = Object.hasOwn(HALVING_AMOUNTS, metricRaw) ? metricRaw : DEFAULT_METRIC;
  const scaleRaw = evaluateValuePattern(user.scale ?? 1, cyclePos);
  const scale = (Number.isFinite(scaleRaw) && scaleRaw > 0) ? scaleRaw : 1;
  const fixed = evaluateValuePattern(user.fixedMetric ?? null, cyclePos);

  const amount = crushMetricAmount(metric, metrics, Number.isFinite(fixed) ? fixed : null);
  const reduction = Math.pow(2, amount / HALVING_AMOUNTS[metric]);
  const bitDepth = Math.min(MAX_BIT_DEPTH, Math.max(MIN_BIT_DEPTH, (BASE_BIT_DEPTH * scale) / reduction));
  const srDivisor = Math.min(MAX_SR_DIVISOR, Math.max(1, Math.round(reduction)));
  // metric/amount travel with the params so a readout can say which one is
  // driving without re-resolving the pattern at a different cycle position.
  // visualPixelate is the sample-rate divisor read as a PIXEL BLOCK: the same
  // decimation, applied to the image by av-effects/VideoState.js on the
  // aggregator's composited frame.
  return { metric, amount, scale, reduction, bitDepth, srDivisor, visualPixelate: srDivisor };
}

// Quantization curve for a WaveShaperNode: 2^bits steps across [-1, 1].
export function makeCrushCurve(bitDepth, length = 2048) {
  const steps = Math.max(2, Math.round(Math.pow(2, bitDepth)));
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const x = (i * 2) / (length - 1) - 1;
    curve[i] = Math.round((x + 1) / 2 * (steps - 1)) / (steps - 1) * 2 - 1;
  }
  return curve;
}

export function createCrushNode(audioCtx, params) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeCrushCurve(params.bitDepth);

  // Sample-rate reduction as a brutal lowpass at the decimated Nyquist —
  // graph-only approximation that avoids a ScriptProcessor on the hot path;
  // aliasing grit comes from the quantizer above it.
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = audioCtx.sampleRate / 2 / params.srDivisor;

  input.connect(shaper);
  shaper.connect(lp);
  lp.connect(output);

  let curveBits = params.bitDepth;

  return {
    input,
    output,
    update(next) {
      // Rebuilding the curve allocates a 2048-float array; with patterned
      // arguments this runs on every pattern tick, not just on a metrics
      // change, so skip the rebuild when the depth has not actually moved.
      if (next.bitDepth !== curveBits) {
        shaper.curve = makeCrushCurve(next.bitDepth);
        curveBits = next.bitDepth;
      }
      lp.frequency.value = audioCtx.sampleRate / 2 / next.srDivisor;
    },
    dispose() {
      [input, output, shaper, lp].forEach(n => { try { n.disconnect(); } catch (e) {} });
    }
  };
}
