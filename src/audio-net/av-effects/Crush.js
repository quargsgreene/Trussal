// crush — bit-depth and sample-rate reduction for audio and pixels, driven
// by worst-case packet loss.
//
//   reduction = reductionFactor × 2^(wcpl / 0.25)   ("a factor of 2 per
//               25 % packet loss", scaled by the user's factor)
//   bitDepth  = clamp(16 / reduction, 1, 16)
//   srDivisor = clamp(round(reduction), 1, 64)      (sample-and-hold period)
//
// The same decimation applies to pixels: visualPixelate is the pixel-block
// edge for the Hydra counterpart.

export function crushParams(metrics, { reductionFactor = 1 } = {}) {
  const wcpl = Math.min(1, Math.max(0, (metrics && metrics.wcpl) || 0));
  const reduction = Math.max(1, reductionFactor * Math.pow(2, wcpl / 0.25));
  const bitDepth = Math.min(16, Math.max(1, 16 / reduction));
  const srDivisor = Math.min(64, Math.max(1, Math.round(reduction)));
  return { reduction, bitDepth, srDivisor, visualPixelate: srDivisor };
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

  return {
    input,
    output,
    update(next) {
      shaper.curve = makeCrushCurve(next.bitDepth);
      lp.frequency.value = audioCtx.sampleRate / 2 / next.srDivisor;
    },
    dispose() {
      [input, output, shaper, lp].forEach(n => { try { n.disconnect(); } catch (e) {} });
    }
  };
}
