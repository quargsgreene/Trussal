// room — Schroeder reverb whose DECAY TIME follows a worst-case network
// metric, with a cascaded lowpass whose cutoff closes as that decay grows —
// a longer tail is a darker one, the way a real room's high frequencies die
// away first.
//
//   decay (RT60, s) = scale × metric_s   metric_s = fixed ?? metric / its units
//   comb feedback_i = 0.001^(base_i / decay)   (clamped below unity)
//   cutoff          = CUTOFF_MAX_HZ / (1 + decay × LOWPASS_PER_SECOND)
//
// `# room <metric> [<scale>] [<fixed metric amount>]` — with the optional third
// token the metric is pinned (0.4 = 400 ms) and live metrics no longer move it.
// Any of the three may be a mini-notation pattern instead of a constant, read
// at the caller's position on the cycle grid, exactly as `# crush`'s are; a
// rest in one leaves that argument at its default for as long as it is in
// force. The audio node runs on the AGGREGATOR's master path (the mix every
// client hears), not in each browser. The same cutoff (normalized) is
// exported so the image blurs as the audio darkens — applied on the
// aggregator's COMPOSITED FRAME (av-effects/VideoState.js) and on the styled
// spans Text Cycles paints (av-effects/TextState.js), where the decay also
// pushes the letters apart. Pure math is separated from node construction for
// node:test.

import { evaluateValuePattern } from '../ValuePattern.js';

// Classic Schroeder comb/allpass tunings (seconds).
export const COMB_BASES_S = [0.0297, 0.0371, 0.0411, 0.0437];
export const ALLPASS_BASES_S = [0.005, 0.0017];

export const CUTOFF_MIN_HZ = 40;
export const CUTOFF_MAX_HZ = 18000;

// How hard the cascaded lowpass closes per second of decay: at a 1 s tail the
// cutoff is CUTOFF_MAX_HZ / 13 ≈ 1.4 kHz, so a typical algorave reverb is
// audibly (and visibly) dark without a runaway metric.
export const LOWPASS_PER_SECOND = 12;

// Feedback ceiling: RT60 → gain solves g = 0.001^(delay/decay), which walks
// toward 1 as decay grows; at 1 the combs self-oscillate forever.
export const MAX_COMB_FEEDBACK = 0.98;

// Wet/dry balance once there is a tail at all.
export const WET_GAIN = 0.5;

// Comb feedback gain for a target RT60: after decayS seconds the comb's
// recirculated signal has fallen 60 dB (×0.001). No decay → no tail.
export function rt60CombFeedback(delayS, decayS) {
  if (!(decayS > 0)) return 0;
  return Math.min(MAX_COMB_FEEDBACK, Math.pow(0.001, delayS / decayS));
}

// Units of each metric to one second of decay. The durations are broadcast in
// ms; wcpl is a loss FRACTION and is taken as it stands, so `# room wcpl 2` is
// a 200 ms tail at 10 % loss. A pinned amount is already quoted in seconds /
// fraction (0.4 = 400 ms), matching `# crush`'s and `# noise`'s third token.
//
// A divisor rather than a seconds-per-unit multiplier because 43 / 1000 is
// exact where 43 * 0.001 is not, and the decay feeds an exponent — every
// client solving the same comb gains from the same metrics should land on the
// same float, not one an ulp apart.
export const METRIC_PER_SECOND = { wcl: 1000, wcrtt: 1000, wcpl: 1 };

export const DEFAULT_METRIC = 'wcl';

// The decay's driving metric in seconds. A pinned amount wins over the live
// reading; either way the result is floored at 0, since a negative decay is
// not a shorter tail but an unsolvable feedback gain.
export function roomMetricSeconds(metric, metrics, fixed = null) {
  if (Number.isFinite(fixed) && fixed >= 0) return fixed;
  const live = (metrics || {})[metric];
  return Math.max(0, Number.isFinite(live) ? live : 0) / METRIC_PER_SECOND[metric];
}

export function roomParams(metrics, user = {}, cyclePos = 0) {
  // hasOwn, not truthiness: METRIC_PER_SECOND is a plain object, so a pattern
  // leaf of 'constructor' would inherit a truthy value off the prototype, pass
  // as a metric, and make every number below NaN (the same guard crushParams
  // carries over HALVING_AMOUNTS).
  const metricRaw = evaluateValuePattern(user.metric ?? DEFAULT_METRIC, cyclePos);
  const metric = Object.hasOwn(METRIC_PER_SECOND, metricRaw) ? metricRaw : DEFAULT_METRIC;
  // A rest — or any leaf that is not a usable number — reads as "no value
  // here", which for a scale is the unity default rather than a silent 0.
  const scaleRaw = evaluateValuePattern(user.scale ?? 1, cyclePos);
  const scale = (Number.isFinite(scaleRaw) && scaleRaw > 0) ? scaleRaw : 1;
  const fixedRaw = evaluateValuePattern(user.fixedMetric ?? null, cyclePos);

  const metricS = roomMetricSeconds(metric, metrics, Number.isFinite(fixedRaw) ? fixedRaw : null);
  const decayS = scale * metricS;
  // The cascaded lowpass closes as the tail lengthens: no decay leaves it wide
  // open (no tone shaping, no image blur), and a long reverb is a dark one.
  const rawCutoff = decayS > 0
    ? CUTOFF_MAX_HZ / (1 + decayS * LOWPASS_PER_SECOND)
    : CUTOFF_MAX_HZ;
  const cutoffHz = Math.min(CUTOFF_MAX_HZ, Math.max(CUTOFF_MIN_HZ, rawCutoff || CUTOFF_MAX_HZ));
  return {
    // Which metric is driving, so a readout (and the aggregator's push
    // dedup) can see it move without re-resolving the pattern themselves.
    metric,
    decayS,
    combDelaysS: COMB_BASES_S.slice(),
    allpassDelaysS: ALLPASS_BASES_S.slice(),
    combFeedbacks: COMB_BASES_S.map(d => rt60CombFeedback(d, decayS)),
    // No decay (no metrics yet, or an empty roster) means no tail to hear:
    // mute the wet path rather than leaving a bare comb slapback on the mix.
    wetGain: decayS > 0 ? WET_GAIN : 0,
    cutoffHz,
    // The image counterpart: 1 = no blur, 0 = fully lowpassed. Consumed by
    // av-effects/VideoState.js, which turns it into the blur RADIUS on the
    // aggregator's composited frame, and by TextState.js for the blur on a
    // styled span. Not published to window._jpVisual — that carries only the
    // one channel anything reads (the Hydra tint).
    visualLowpass: cutoffHz / CUTOFF_MAX_HZ
  };
}

export function createRoomNode(audioCtx, params) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const wet = audioCtx.createGain();
  wet.gain.value = params.wetGain;
  input.connect(output); // dry path

  const combs = params.combDelaysS.map((d, i) => {
    const delay = audioCtx.createDelay(Math.max(1, d * 2));
    delay.delayTime.value = d;
    const fb = audioCtx.createGain();
    fb.gain.value = params.combFeedbacks[i];
    input.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    return { delay, fb };
  });
  const combSum = audioCtx.createGain();
  combSum.gain.value = 1 / combs.length;
  combs.forEach(c => c.delay.connect(combSum));

  // Allpass stages run in SERIES: Schroeder diffuses the parallel comb sum by
  // passing it through each stage in turn. Advancing `head` per stage is what
  // makes the chain a chain — leave it pointing at combSum and every stage
  // taps the sum in parallel, only the last one reaching the lowpass while
  // the others recirculate into a dead end.
  let head = combSum;
  const allpasses = params.allpassDelaysS.map((d) => {
    // Feedback-comb approximation of the allpass stage.
    const delay = audioCtx.createDelay(1);
    delay.delayTime.value = d;
    const fb = audioCtx.createGain();
    fb.gain.value = 0.5;
    head.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    head = delay;
    return delay;
  });

  // Cascaded lowpass at the end of the filter chain.
  const lp1 = audioCtx.createBiquadFilter();
  const lp2 = audioCtx.createBiquadFilter();
  lp1.type = lp2.type = 'lowpass';
  lp1.frequency.value = lp2.frequency.value = params.cutoffHz;
  head.connect(lp1);
  lp1.connect(lp2);
  lp2.connect(wet);
  wet.connect(output);

  return {
    input,
    output,
    update(next) {
      combs.forEach((c, i) => {
        c.delay.delayTime.value = Math.min(next.combDelaysS[i], 1.99);
        c.fb.gain.value = next.combFeedbacks[i];
      });
      wet.gain.value = next.wetGain;
      lp1.frequency.value = next.cutoffHz;
      lp2.frequency.value = next.cutoffHz;
    },
    dispose() {
      [input, output, wet, combSum, lp1, lp2, ...combs.map(c => c.delay), ...combs.map(c => c.fb), ...allpasses]
        .forEach(n => { try { n.disconnect(); } catch (e) {} });
    }
  };
}
