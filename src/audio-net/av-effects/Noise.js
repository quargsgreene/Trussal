// noise — audiovisual noise colored by worst-case packet loss:
//   wcpl > 0.6   → white
//   0.3 – 0.6    → pink
//   0.1 – 0.3    → brown
//   below 0.1    → none
// (The spec's ranges leave (0.59, 0.6] unnamed; pink covers up to and
// including 0.6, white strictly above.)

export function noiseTypeForWcpl(wcpl) {
  const v = Math.min(1, Math.max(0, wcpl || 0));
  if (v > 0.6) return 'white';
  if (v >= 0.3) return 'pink';
  if (v >= 0.1) return 'brown';
  return 'none';
}

export function noiseParams(metrics) {
  const type = noiseTypeForWcpl(metrics && metrics.wcpl);
  return {
    type,
    gain: type === 'none' ? 0 : 0.12,
    // Hydra counterpart: normalized grain amount.
    visualNoise: type === 'none' ? 0 : type === 'brown' ? 0.15 : type === 'pink' ? 0.35 : 0.6
  };
}

// Generate a noise buffer of the requested color (2 s loop).
export function fillNoise(channel, type) {
  if (type === 'white') {
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
    return channel;
  }
  if (type === 'pink') {
    // Voss-McCartney-ish via IIR (Paul Kellet's economy pink filter).
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < channel.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      channel[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    return channel;
  }
  // brown: integrated white, leaky.
  let last = 0;
  for (let i = 0; i < channel.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    channel[i] = last * 3.5;
  }
  return channel;
}

export function createNoiseNode(audioCtx, params) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  input.connect(output); // noise is additive; signal passes through

  const gain = audioCtx.createGain();
  gain.gain.value = params.gain;
  gain.connect(output);

  let src = null;
  let currentType = 'none';
  const setType = (type) => {
    if (type === currentType) return;
    currentType = type;
    if (src) { try { src.stop(); src.disconnect(); } catch (e) {} src = null; }
    if (type === 'none') return;
    const len = Math.floor(audioCtx.sampleRate * 2);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    fillNoise(buf.getChannelData(0), type);
    src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start();
  };
  setType(params.type);

  return {
    input,
    output,
    update(next) {
      setType(next.type);
      gain.gain.value = next.gain;
    },
    dispose() {
      if (src) { try { src.stop(); } catch (e) {} }
      [input, output, gain, src].forEach(n => { if (n) { try { n.disconnect(); } catch (e) {} } });
    }
  };
}
