// jamulus-relay-player.js — AudioWorklet processor for the Jamulus relay.
//
// Receives binary frames of interleaved Int16 stereo PCM (48 kHz) from the
// relay WebSocket via port.postMessage, buffers them in a pair of Float32 ring
// buffers, and drains them in process() on the audio thread.
//
// Playback is held until the ring buffer reaches MIN_FILL_SECONDS to absorb
// network jitter before the first sample is emitted. If the ring drains
// completely it re-enters the buffering state rather than clicking.

class JamulusRelayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    const CAP     = sampleRate * 8;   // 8-second ring buffer per channel
    this._cap     = CAP;
    this._L       = new Float32Array(CAP);
    this._R       = new Float32Array(CAP);
    this._write   = 0;
    this._read    = 0;
    this._filled  = 0;

    // Hold playback until we have 120 ms of data to absorb jitter.
    this._minFill   = Math.floor(sampleRate * 0.12);
    this._buffering = true;

    this.port.onmessage = ({ data }) => {
      // data is an ArrayBuffer containing Int16 interleaved stereo PCM.
      const pcm = new Int16Array(data);
      const n   = pcm.length >> 1;           // sample frames
      const cap = this._cap;

      // Drop if ring is full (shouldn't happen with an 8-second buffer).
      const space = cap - this._filled;
      const toCopy = Math.min(n, space);

      for (let i = 0; i < toCopy; i++) {
        this._L[(this._write + i) % cap] = pcm[i * 2]     / 32768;
        this._R[(this._write + i) % cap] = pcm[i * 2 + 1] / 32768;
      }

      this._write  = (this._write + toCopy) % cap;
      this._filled = Math.min(this._filled + toCopy, cap);

      if (this._buffering && this._filled >= this._minFill) {
        this._buffering = false;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    const ch1 = out[1];
    const n   = ch0 ? ch0.length : 128;

    if (this._buffering || this._filled < n) {
      // Re-enter buffering on underrun to avoid a click resumption.
      if (this._filled < Math.floor(n / 4)) this._buffering = true;
      if (ch0) ch0.fill(0);
      if (ch1) ch1.fill(0);
      return true;
    }

    const cap = this._cap;
    for (let i = 0; i < n; i++) {
      if (ch0) ch0[i] = this._L[(this._read + i) % cap];
      if (ch1) ch1[i] = this._R[(this._read + i) % cap];
    }
    this._read   = (this._read + n) % cap;
    this._filled -= n;
    return true;
  }
}

registerProcessor('jamulus-relay-processor', JamulusRelayProcessor);
