// echo — delay by a number of samples derived from worst-case jitter, with
// feedback mediated by worst-case packet loss.
//
//   n_samples = nSamplesFactor × wcj × 100        (wcj in ms)
//   feedback  = min(factor / max(wcpl, ε), 0.95)  (clamped below unity —
//               the spec's max(f/wcpl, 1) guarantees runaway feedback and
//               divides by zero at wcpl = 0, treated as an erratum)
//
// The clamped feedback value also modulates the synthesized video
// brightness (exported as visualBrightness).

export const FEEDBACK_EPSILON = 1e-3;
export const FEEDBACK_CEILING = 0.95;

export function echoFeedback(wcpl, magnitudeFeedbackFactor = 0.1) {
  const loss = Math.max(FEEDBACK_EPSILON, Math.max(0, wcpl || 0));
  return Math.min(magnitudeFeedbackFactor / loss, FEEDBACK_CEILING);
}

export function echoParams(metrics, { nSamplesFactor = 1, magnitudeFeedbackFactor = 0.1 } = {}, sampleRate = 48000) {
  const wcj = Math.max(0, (metrics && metrics.wcj) || 0);
  const nSamples = Math.max(1, Math.round(nSamplesFactor * wcj * 100));
  const feedback = echoFeedback(metrics && metrics.wcpl, magnitudeFeedbackFactor);
  return {
    nSamples,
    delayS: nSamples / sampleRate,
    feedback,
    visualBrightness: feedback
  };
}

export function createEchoNode(audioCtx, params) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const delay = audioCtx.createDelay(10);
  delay.delayTime.value = Math.min(params.delayS, 9.99);
  const fb = audioCtx.createGain();
  fb.gain.value = params.feedback;

  input.connect(output);        // dry
  input.connect(delay);
  delay.connect(fb);
  fb.connect(delay);            // feedback loop
  delay.connect(output);        // wet

  return {
    input,
    output,
    update(next) {
      delay.delayTime.value = Math.min(next.delayS, 9.99);
      fb.gain.value = next.feedback;
    },
    dispose() {
      [input, output, delay, fb].forEach(n => { try { n.disconnect(); } catch (e) {} });
    }
  };
}
