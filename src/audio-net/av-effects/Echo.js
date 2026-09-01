// echo — a feedback delay whose LENGTH, FEEDBACK and GAIN are each driven by
// a network metric the user picks, one metric per parameter:
//
//   # echo <metric> <length> <metric> <feedback> <metric> <gain>
//          [<bound 1> [<bound 2> [<bound 3>]]]
//
// Every parameter is its scale factor times its metric NORMALIZED against an
// upper bound, so the scale is the value that parameter reaches when its
// metric sits at the bound, and a network that keeps degrading cannot push it
// any further:
//
//   value_i = scale_i × min(metric_i / bound_i, 1)
//
// `# echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200` is therefore a 2-cycle echo at
// 1500 ms of worst-case latency, 0.3 feedback at 20 % worst-case loss, and
// gain 3 at 1200 ms — all three shrinking together as the room gets healthier.
//
// Bounds are written in the unit their metric is read in: milliseconds for
// wcl/wcrtt, PERCENT for wcpl (`20` means 20 % loss, while metrics.wcpl
// itself is the fraction 0.2). An omitted bound falls back to
// ECHO_METRIC_BOUNDS — deliberately set near the worst a real algorave room
// reaches rather than at the metric's theoretical ceiling, so the effect
// audibly moves without anyone having to induce degradation first.
//
// LENGTH IS IN CYCLES, not seconds: the delay rides the room's cycle grid, so
// it re-times itself whenever the metrics move the cycle length, and a
// rational length (1/2, 3/4, …) stays in rhythm with the rotation. Cycle
// length arrives per call — the chain is re-derived, not rebuilt, when it
// changes.
//
// Scales and bounds may both be PATTERNS (`<2 3>`, `[1 4]`), sampled from the
// cycle position by ValuePattern.js — the one reader every `#` effect argument
// goes through. Since that sampling and the metrics are identical on every
// client, so is the resulting audio.
//
// Like every other audio effect, the node runs on the AGGREGATOR's master
// path (the mix every client hears), not in each browser: bots/src/bot/
// page-scripts.js pageMasterPlayer inlines this graph, because the
// page-script contract forbids imports. createEchoNode below is therefore the
// reference copy rather than the audible one; browsers keep only the Hydra
// counterpart, visualBrightness.
//
// Pure math (echoParams) is separated from node construction (createEchoNode)
// for node:test.

import { evaluateValuePattern, isValuePattern } from '../ValuePattern.js';

// Metrics an echo parameter may be driven by. wcrtt is included even though
// `# cycles` has no use for it: an echo tracking the round trip rather than
// mouth-to-ear latency is a different, legible musical choice.
export const ECHO_METRICS = ['wcl', 'wcrtt', 'wcpl'];

// Default upper bound per metric, in that metric's written unit (ms; percent
// for wcpl). Used for any bound the user leaves off.
export const ECHO_METRIC_BOUNDS = Object.freeze({
  wcl: 500,
  wcrtt: 500,
  wcpl: 20
});

// The three parameters, in the order their metric/scale pairs are written.
export const ECHO_SLOTS = ['length', 'feedback', 'gain'];

// A bare `# echo`: wcl drives all three, at a half-cycle delay, half feedback
// and unity gain — the values reached at wcl's bound, not fixed outputs, so
// even the default echo follows the network.
export const ECHO_DEFAULT_SCALES = Object.freeze({ length: 0.5, feedback: 0.5, gain: 1 });

// Feedback stays strictly below unity or the delay line self-oscillates and
// the room never gets quiet again — the one place a user's scale factor is
// overruled rather than trusted.
export const FEEDBACK_CEILING = 0.95;

// DelayNode allocates maxDelayTime × sampleRate of buffer at construction, so
// the ceiling is a real memory decision, not just a clamp: 20 s covers a
// 2-cycle echo on a 10 s cycle.
export const ECHO_MAX_DELAY_S = 20;

// One render quantum at 48 kHz — the shortest delay WebAudio can actually
// produce. Anything below it is a comb filter, not an echo (see wetGain).
export const MIN_DELAY_S = 128 / 48000;

// The echo's gain is the user's to set and is deliberately NOT clamped — and
// on the aggregator's master path nothing downstream catches a large one: the
// mix's gain staging is applied Node-side to the assembled buffer, upstream of
// this graph. The node therefore brings its own limiter, the same way every
// per-peer chain does: gain stays expressive, full scale stays a wall.
export const LIMITER_THRESHOLD_DB = -1.0;

// Slot defaults as echoParams sees them when no `#` line resolved them.
export const ECHO_DEFAULT_SLOTS = Object.freeze(ECHO_SLOTS.map(param => Object.freeze({
  param,
  metric: 'wcl',
  scale: ECHO_DEFAULT_SCALES[param],
  bound: null
})));

// A metric in the unit its bound is written in. wcpl is broadcast as a
// fraction in [0, 1] but written as a percentage, because that is how a
// performer says it — "20 % loss", not "0.2 loss".
export function metricInBoundUnits(metric, metrics) {
  const m = metrics || {};
  const raw = Math.max(0, m[metric] || 0);
  return metric === 'wcpl' ? raw * 100 : raw;
}

// metric / bound, clamped to [0, 1]. A non-positive or missing bound falls
// back to the metric's default rather than dividing by zero.
export function normalizedMetric(metric, metrics, bound) {
  const limit = bound > 0 && isFinite(bound)
    ? bound
    : (ECHO_METRIC_BOUNDS[metric] ?? ECHO_METRIC_BOUNDS.wcl);
  return Math.min(1, metricInBoundUnits(metric, metrics) / limit);
}

// Whether this echo's arguments include a pattern — i.e. whether its
// parameters move with the cycle grid as well as with the metrics.
export function echoIsPatterned(user) {
  const slots = (user && user.slots) || [];
  return slots.some(s => isValuePattern(s.scale) || isValuePattern(s.bound));
}

export function echoParams(metrics, user, { cycleSeconds = 1, cyclePos = 0 } = {}) {
  const slots = (user && user.slots && user.slots.length) ? user.slots : ECHO_DEFAULT_SLOTS;
  const value = new Map();
  for (const slot of slots) {
    const scale = evaluateValuePattern(slot.scale, cyclePos);
    const bound = evaluateValuePattern(slot.bound, cyclePos);
    value.set(slot.param, Math.max(0, scale || 0) * normalizedMetric(slot.metric, metrics, bound));
  }

  const lengthCycles = value.get('length') || 0;
  const feedback = Math.min(FEEDBACK_CEILING, value.get('feedback') || 0);
  const gain = value.get('gain') || 0;
  const delayS = Math.min(ECHO_MAX_DELAY_S, Math.max(0, lengthCycles * Math.max(0, cycleSeconds)));

  return {
    lengthCycles,
    delayS,
    feedback,
    gain,
    // Below one render quantum there is no echo to hear, only a comb: the
    // DelayNode floors delayTime at the quantum anyway, so a length that
    // rounds to nothing would ring as a fixed ~375 Hz resonance — at up to
    // FEEDBACK_CEILING, since each slot reads its own metric and a dead length
    // does not imply dead feedback. Mute the wet path instead.
    wetGain: delayS >= MIN_DELAY_S ? gain : 0,
    // Hydra counterpart: 1 = untouched, and the image darkens as the repeats
    // thicken. Anchored at unity so a chain doing nothing audible does nothing
    // visible — which the old brightness = feedback could not do: its feedback
    // ROSE as packet loss fell (it divided by wcpl), so a healthy room sat near
    // full brightness and a lossy one went dark, with no value meaning "off".
    visualBrightness: 1 - feedback
  };
}

// Gain ramp for a parameter change, in seconds. Patterned arguments step at
// cycle boundaries rather than drifting with the metrics, so an instant jump
// on the wet or feedback gain is an audible click on every step; a ramp this
// short is inaudible as a glide but removes the discontinuity. delayTime is
// left to jump — ramping it sweeps the read pointer, which is a pitch bend,
// not a crossfade, and the point of a re-timed echo is that it re-times.
const GAIN_RAMP_S = 0.02;

export function createEchoNode(audioCtx, params) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const delay = audioCtx.createDelay(ECHO_MAX_DELAY_S);
  delay.delayTime.value = params.delayS;
  const fb = audioCtx.createGain();
  fb.gain.value = params.feedback;
  const wet = audioCtx.createGain();
  wet.gain.value = params.wetGain;

  // Wet-path limiter: see LIMITER_THRESHOLD_DB. Only the echo passes through
  // it — the dry signal reaches the output untouched.
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER_THRESHOLD_DB;

  input.connect(output);        // dry
  input.connect(delay);
  delay.connect(fb);
  fb.connect(delay);            // feedback loop
  delay.connect(wet);
  wet.connect(limiter);
  limiter.connect(output);      // wet, at the echo's own gain

  // The pattern tick re-derives parameters 20×/s, so most updates carry the
  // value already in force: write only real changes, and never schedule a ramp
  // to where the parameter already sits.
  const rampTo = (param, target) => {
    if (param.value === target) return;
    const now = audioCtx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + GAIN_RAMP_S);
  };

  return {
    input,
    output,
    update(next) {
      if (delay.delayTime.value !== next.delayS) delay.delayTime.value = next.delayS;
      rampTo(fb.gain, next.feedback);
      rampTo(wet.gain, next.wetGain);
    },
    dispose() {
      [input, output, delay, fb, wet, limiter].forEach(n => { try { n.disconnect(); } catch (e) {} });
    }
  };
}
