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
      this._debugCount = 0;  
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
      if (glitchArray > 0.01 && this._debugCount < 5) {
      this.port.postMessage({ type: 'distortion-debug', intensity: glitchArray });
      this._debugCount++;
    }
      for (let ch = 0; ch < output.length; ch++) {
        const inChan = input[ch] || new Float32Array(output[ch].length);
        const outChan = output[ch];
  
        for (let i = 0; i < outChan.length; i++) {
          const x = inChan[i] || 0;

          const intensity =
            glitchArray.length > 1 ? glitchArray[i] : glitchArray[0];
          const noiseType =
            noiseArray.length > 1 ? noiseArray[i] : noiseArray[0];
// latency-worklet.js (inside process(), replacing your distortion block)

          let y = x;

          if (intensity > 0.001) {
            const clamped = Math.max(0, Math.min(1, intensity));

            // Drive: 1..41 (pretty extreme at 1.0)
            const drive = 1 + clamped * 40;

            // Pre-gain
            let z = x * drive;

            // Hard clip to [-1, 1]
            if (z > 1)  z = 1;
            if (z < -1) z = -1;

            // Optional "glitch": add a bit of foldback at high intensities
            if (clamped > 0.5) {
              const foldAmount = (clamped - 0.5) * 2; // 0..1
              const folded = 1 - Math.abs((z % 2) - 1); // 0..1 triangle-ish
              z = z * (1 - foldAmount) + (folded * Math.sign(z)) * foldAmount;
            }

            // Soft clip / tame high harmonics
            y = Math.tanh(z * 2);
          }


          // 2) Noise (only if noiseType > 0)
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

registerProcessor('latency-processor-v2', LatencyProcessor);

