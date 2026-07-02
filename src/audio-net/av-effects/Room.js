// room — Schroeder reverb whose size breathes with the room's worst-case
// latency, with a cascaded lowpass whose cutoff tracks worst-case RTT.
//
//   comb delay_i = base_i × (1 + wclFactor × wcl/1000)   (wcl in ms)
//   cutoff      = wcrtt × wcrttFactor × 100 Hz            (wcrtt in ms)
//
// The same cutoff (normalized) is exported for the Hydra signal so the
// visuals blur as the audio darkens. Pure math is separated from node
// construction for node:test.

// Classic Schroeder comb/allpass tunings (seconds).
export const COMB_BASES_S = [0.0297, 0.0371, 0.0411, 0.0437];
export const ALLPASS_BASES_S = [0.005, 0.0017];

export const CUTOFF_MIN_HZ = 40;
export const CUTOFF_MAX_HZ = 18000;

export function roomParams(metrics, { wclFactor = 1, wcrttFactor = 1 } = {}) {
  const wcl = Math.max(0, (metrics && metrics.wcl) || 0);
  const wcrtt = Math.max(0, (metrics && metrics.wcrtt) || 0);
  const stretch = 1 + wclFactor * (wcl / 1000);
  const combDelaysS = COMB_BASES_S.map(b => b * stretch);
  const rawCutoff = wcrtt * wcrttFactor * 100;
  const cutoffHz = Math.min(CUTOFF_MAX_HZ, Math.max(CUTOFF_MIN_HZ, rawCutoff || CUTOFF_MAX_HZ));
  return {
    combDelaysS,
    allpassDelaysS: ALLPASS_BASES_S.slice(),
    combFeedback: 0.84,
    cutoffHz,
    // Hydra counterpart: 1 = no blur, 0 = fully lowpassed image.
    visualLowpass: cutoffHz / CUTOFF_MAX_HZ
  };
}

export function createRoomNode(audioCtx, params) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const wet = audioCtx.createGain();
  wet.gain.value = 0.5;
  input.connect(output); // dry path

  const combs = params.combDelaysS.map((d) => {
    const delay = audioCtx.createDelay(Math.max(1, d * 2));
    delay.delayTime.value = d;
    const fb = audioCtx.createGain();
    fb.gain.value = params.combFeedback;
    input.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    return delay;
  });
  const combSum = audioCtx.createGain();
  combSum.gain.value = 1 / combs.length;
  combs.forEach(c => c.connect(combSum));

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
    return delay;
  });
  head = allpasses.length ? allpasses[allpasses.length - 1] : head;

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
      combs.forEach((c, i) => { c.delayTime.value = Math.min(next.combDelaysS[i], 1.99); });
      lp1.frequency.value = next.cutoffHz;
      lp2.frequency.value = next.cutoffHz;
    },
    dispose() {
      [input, output, wet, combSum, lp1, lp2, ...combs, ...allpasses]
        .forEach(n => { try { n.disconnect(); } catch (e) {} });
    }
  };
}
