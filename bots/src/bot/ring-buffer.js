/**
 * RingBuffer — a fixed-capacity circular buffer of Float32 audio samples.
 *
 * Modeled on the AudioWorklet ring in docker-jitsi-meet/jitsi-web/
 * jamulus-relay-player.js: a single Float32Array with independent read/write
 * cursors and a `filled` count. The difference is the overflow policy — the
 * relay drops incoming audio when full; here a full buffer EVICTS the oldest
 * sample (advances the read cursor) so a participant whose buffer is never
 * drained can't grow without bound and can't wedge the writer. That is the
 * "evict oldest buffers if queue is full" behavior the AggregatorBot needs on
 * both of its buffer dimensions:
 *   - one RingBuffer per participant (each participant's concatenated audio)
 *   - one shared RingBuffer (all participants concatenated into the master mix)
 *
 * Sample interpretation (mono vs interleaved stereo) is left to the caller;
 * the buffer only moves Float32 samples. Audio streaming is implemented first,
 * so callers currently push mono PCM.
 */

const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT; // 4

export class RingBuffer {
  constructor(capacity = 1024) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this._buf = new Float32Array(this.capacity);
    this._write = 0;      // index of the next slot to write
    this._read = 0;       // index of the oldest unread sample
    this._filled = 0;     // samples available to read
    this.written = 0;     // total samples ever written (monotonic)
    this.evicted = 0;     // total samples overwritten before being read
  }

  /** Samples currently available to read. */
  get length() { return this._filled; }
  /** Bytes those samples occupy. */
  get bytes() { return this._filled * BYTES_PER_SAMPLE; }
  /** Free sample slots before the next write starts evicting. */
  get free() { return this.capacity - this._filled; }

  /**
   * Append `samples` (Array or Float32Array), evicting the oldest sample for
   * each write past capacity. Returns the number of samples written.
   */
  write(samples) {
    const n = samples.length;
    const cap = this.capacity;
    for (let i = 0; i < n; i++) {
      this._buf[this._write] = samples[i];
      this._write = (this._write + 1) % cap;
      if (this._filled < cap) {
        this._filled++;
      } else {
        // Buffer full: this write lands on the oldest unread sample, so the
        // read cursor moves forward with it — that sample is now evicted.
        this._read = (this._read + 1) % cap;
        this.evicted++;
      }
    }
    this.written += n;
    return n;
  }

  /**
   * Remove and return up to `n` of the oldest samples as a Float32Array
   * (shorter than `n` when fewer are available; empty on an empty buffer).
   */
  read(n) {
    const count = Math.min(n, this._filled);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this._buf[this._read];
      this._read = (this._read + 1) % this.capacity;
    }
    this._filled -= count;
    return out;
  }

  /** Copy up to `n` oldest samples without consuming them (default: all). */
  peek(n = this._filled) {
    const count = Math.min(n, this._filled);
    const out = new Float32Array(count);
    let r = this._read;
    for (let i = 0; i < count; i++) {
      out[i] = this._buf[r];
      r = (r + 1) % this.capacity;
    }
    return out;
  }

  clear() {
    this._write = 0;
    this._read = 0;
    this._filled = 0;
  }

  /**
   * A snapshot for logging/metrics. The property names match the columns the
   * AggregatorBot's logBuffersAndStats() emits.
   */
  stats() {
    return {
      bufferSize: this.capacity,
      bufferLength: this._filled,
      bufferBytes: this.bytes,
      bufferEvicted: this.evicted,
      bufferWritten: this.written,
      bufferMaxBuffers: this.capacity,
      bufferMaxBytes: this.capacity * BYTES_PER_SAMPLE,
    };
  }
}
