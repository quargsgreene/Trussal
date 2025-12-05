// latency-worklet.js

class LatencyProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'glitchIntensity',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        // 0 = none, 1 = white, 2 = brown, 3 = pink
        name: 'noiseType',
        defaultValue: 0,
        minValue: 0,
        maxValue: 3,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor() {
    super();

    // state for brown noise
    this._brownLast = 0.0;

    // state for pink noise
    this._b0 = 0.0;
    this._b1 = 0.0;
    this._b2 = 0.0;
    this._b3 = 0.0;
    this._b4 = 0.0;
    this._b5 = 0.0;
    this._b6 = 0.0;
  }

  _white() {
    // simple white noise in [-1, 1]
    return Math.random() * 2 - 1;
  }

  _brown(white) {
    this._brownLast = (this._brownLast + 0.02 * white) / 1.02;
    return this._brownLast * 0.35; // roughly compensate gain
  }

  _pink(white) {
    // classic 7-tap pink noise filter
    this._b0 = 0.99886 * this._b0 + white * 0.0555179;
    this._b1 = 0.99332 * this._b1 + white * 0.0750759;
    this._b2 = 0.96900 * this._b2 + white * 0.1538520;
    this._b3 = 0.86650 * this._b3 + white * 0.3104856;
    this._b4 = 0.55000 * this._b4 + white * 0.5329522;
    this._b5 = -0.7616 * this._b5 - white * 0.0168980;
    const out =
      this._b0 +
      this._b1 +
      this._b2 +
      this._b3 +
      this._b4 +
      this._b5 +
      this._b6 +
      white * 0.5362;
    this._b6 = white * 0.115926;
    return out * 0.11; // roughly compensate gain
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] || [];
    const output = outputs[0];

    if (!output) {
      return true;
    }

    const glitchArray = parameters.glitchIntensity;
    const noiseArray = parameters.noiseType;

    for (let ch = 0; ch < output.length; ch++) {
      const inChan = input[ch] || new Float32Array(output[ch].length);
      const outChan = output[ch];

      for (let i = 0; i < outChan.length; i++) {
        const x = inChan[i] || 0;

        const intensity =
          glitchArray.length > 1 ? glitchArray[i] : glitchArray[0];
        const noiseType =
          noiseArray.length > 1 ? noiseArray[i] : noiseArray[0];

        // 1) Glitch: quantize to N steps depending on intensity
        const clampedIntensity = Math.max(0, Math.min(1, intensity));
        const steps = 3 + (1 - clampedIntensity) * 100;
        let y = Math.round(x * steps) / steps;
        y = Math.max(-1, Math.min(1, y));

        // 2) Noise
        let noise = 0;
        if (noiseType >= 1) {
          const w = this._white();
          if (noiseType < 1.5) {
            // white
            noise = w * 0.1;
          } else if (noiseType < 2.5) {
            // brown
            noise = this._brown(w);
          } else {
            // pink
            noise = this._pink(w);
          }
        }

        const sample = Math.max(-1, Math.min(1, y + noise));
        outChan[i] = sample;
      }
    }

    return true;
  }
}

registerProcessor('latency-processor', LatencyProcessor);
