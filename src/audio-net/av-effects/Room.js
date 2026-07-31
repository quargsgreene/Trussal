// room — Schroeder reverb whose DECAY TIME follows the room's worst-case
// latency, with a cascaded lowpass whose cutoff tracks worst-case RTT.
//
//   decay (RT60, s) = scale × wcl_s     wcl_s = fixedWclS ?? wcl/1000 (wcl in ms)
//   comb feedback_i = 0.001^(base_i / decay)   (clamped below unity)
//   cutoff          = wcrtt × wcrttFactor × 100 Hz   (wcrtt in ms)
//
// `# room wcl <scale> [<fixed wcl seconds>]` — with the optional third token
// the metric is pinned (0.4 = 400 ms) and live metrics no longer move it.
// The audio node runs on the AGGREGATOR's master path (the mix every client
// hears), not in each browser; browsers keep only the Hydra visual
// counterpart. The same cutoff (normalized) is exported for that visual so
// the image blurs as the audio darkens. Pure math is separated from node
// construction for node:test.

// Classic Schroeder comb/allpass tunings (seconds).
export const COMB_BASES_S = [0.0297, 0.0371, 0.0411, 0.0437];
export const ALLPASS_BASES_S = [0.005, 0.0017];

export const CUTOFF_MIN_HZ = 40;
export const CUTOFF_MAX_HZ = 18000;

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

export function roomParams(metrics, { scale = 1, fixedWclS = null, wcrttFactor = 1 } = {}) {
  const wclS = fixedWclS != null ? Math.max(0, fixedWclS) : Math.max(0, (metrics && metrics.wcl) || 0) / 1000;
  const wcrtt = Math.max(0, (metrics && metrics.wcrtt) || 0);
  const decayS = Math.max(0, scale) * wclS;
  const rawCutoff = wcrtt * wcrttFactor * 100;
  const cutoffHz = Math.min(CUTOFF_MAX_HZ, Math.max(CUTOFF_MIN_HZ, rawCutoff || CUTOFF_MAX_HZ));
  return {
    decayS,
    combDelaysS: COMB_BASES_S.slice(),
    allpassDelaysS: ALLPASS_BASES_S.slice(),
    combFeedbacks: COMB_BASES_S.map(d => rt60CombFeedback(d, decayS)),
    // No decay (no metrics yet, or an empty roster) means no tail to hear:
    // mute the wet path rather than leaving a bare comb slapback on the mix.
    wetGain: decayS > 0 ? WET_GAIN : 0,
    cutoffHz,
    // Hydra counterpart: 1 = no blur, 0 = fully lowpassed image.
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
