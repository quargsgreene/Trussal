/**
 * AudioWorklet processors for the aggregator's audio path: the per-participant
 * capture tap (pageAggregatorCapture) and the master player
 * (pageMasterPlayer). page-scripts.js reads this file as TEXT
 * (PAGE_AUDIO_WORKLET_SOURCE) and pageInstallAudioWorklet loads it into the
 * page's shared AudioContext from a blob: URL — page functions are serialized
 * into the page, so they cannot import it.
 *
 * Why worklets: both ends used to be ScriptProcessors, whose callbacks run on
 * the page's MAIN thread. Whenever one is serviced late — the aggregator's
 * main thread also composites the mosaic and answers every CDP call — Chrome
 * plays that block as silence (playback) or overwrites it before it is read
 * (capture). Measured on the bot image, that alone left about one gap a second
 * in the master with a full queue behind it. A worklet runs on the audio
 * rendering thread; the main thread only ships chunks through a MessagePort,
 * and a busy main thread now delays those messages instead of losing audio.
 *
 * Importable under Node too (the unit tests drive the processors directly):
 * outside a worklet scope there is no AudioWorkletProcessor, sampleRate or
 * registerProcessor, so each is guarded.
 */

const Processor = typeof AudioWorkletProcessor === 'function' ? AudioWorkletProcessor : class {};
const RATE = typeof sampleRate === 'number' ? sampleRate : 48000;

// Frames per capture message: 2048 (~43 ms at 48 kHz), the block size the
// ScriptProcessor tap used.
const CAPTURE_FRAMES = 2048;
// How often the player reports its position to the main thread, in render
// quanta (128 frames each): 8 is ~21 ms.
const REPORT_EVERY_BLOCKS = 8;

/**
 * One participant's capture tap. Interleaves the input to stereo (L,R per
 * frame — the layout the whole pipeline carries) and posts it to the main
 * thread CAPTURE_FRAMES at a time. The node is created with channelCount 2 /
 * 'explicit', so a mono source arrives already up-mixed to dual-mono; the
 * one-channel branch below is a backstop, not the normal path. Posting 'stop'
 * lets the processor be collected after its node is torn down.
 */
export class TrussalCaptureProcessor extends Processor {
  constructor() {
    super();
    this.frame = new Float32Array(CAPTURE_FRAMES * 2);
    this.filled = 0;
    this.stopped = false;
    if (this.port) this.port.onmessage = (ev) => { if (ev.data === 'stop') this.stopped = true; };
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || !input.length) return true; // nothing connected this quantum
    const left = input[0];
    const right = input.length > 1 ? input[1] : left;
    for (let i = 0; i < left.length; i++) {
      this.frame[this.filled++] = left[i];
      this.frame[this.filled++] = right[i];
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(CAPTURE_FRAMES * 2);
        this.filled = 0;
      }
    }
    return true;
  }
}

/**
 * The master player: plays interleaved stereo chunks posted from the main
 * thread, behind a safety buffer. Output stays silent until primeMs of audio
 * is queued, and if the queue runs dry mid-stream it re-primes rather than
 * playing each late chunk the moment it lands — so one late delivery costs one
 * gap, not a run of them. Reports { consumed, underruns, priming } every
 * REPORT_EVERY_BLOCKS quanta; the main thread derives its queue depth from
 * `consumed` (see pageMasterPlayer's state()).
 */
export class TrussalMasterPlayerProcessor extends Processor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // Whole frames, so a primed queue always starts on an L sample.
    this.primeSamples = Math.max(0, Math.round(((opts.primeMs ?? 400) / 1000) * RATE)) * 2;
    this.maxChunks = opts.maxChunks ?? 256;
    this.chunks = [];       // Float32Array chunks waiting to be played
    this.readOffset = 0;    // interleaved-sample offset consumed from chunks[0]
    this.queued = 0;        // interleaved samples queued and not yet played
    this.priming = true;
    this.underruns = 0;     // times the queue ran dry mid-stream
    this.consumed = 0;      // interleaved samples played or dropped, ever
    this.blocks = 0;
    if (this.port) this.port.onmessage = (ev) => this.enqueue(ev.data);
  }

  enqueue(chunk) {
    if (!chunk || !chunk.length) return;
    // Overflow: drop the oldest (currently-playing) chunk. Only bites when the
    // main thread has run far ahead of real-time playback.
    if (this.chunks.length >= this.maxChunks) {
      const dropped = this.chunks.shift().length - this.readOffset;
      this.readOffset = 0;
      this.queued -= dropped;
      this.consumed += dropped;
    }
    this.chunks.push(chunk);
    this.queued += chunk.length;
  }

  // One block of output, de-interleaved into the two channels.
  render(outL, outR) {
    if (this.priming && this.chunks.length && this.queued >= this.primeSamples) this.priming = false;
    for (let i = 0; i < outL.length; i++) {
      if (this.priming || !this.chunks.length) { outL[i] = 0; outR[i] = 0; continue; }
      const head = this.chunks[0];
      outL[i] = head[this.readOffset];
      // A malformed odd-length chunk has no R for its last frame: write 0, not
      // the undefined an out-of-range read gives (NaN on the bus).
      outR[i] = this.readOffset + 1 < head.length ? head[this.readOffset + 1] : 0;
      const step = Math.min(2, head.length - this.readOffset);
      this.readOffset += step;
      this.queued -= step;
      this.consumed += step;
      if (this.readOffset >= head.length) {
        this.chunks.shift();
        this.readOffset = 0;
        if (!this.chunks.length) { this.priming = true; this.underruns++; }
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (out && out.length) this.render(out[0], out.length > 1 ? out[1] : new Float32Array(out[0].length));
    if (++this.blocks % REPORT_EVERY_BLOCKS === 0 && this.port) {
      this.port.postMessage({ consumed: this.consumed, underruns: this.underruns, priming: this.priming });
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('trussal-capture', TrussalCaptureProcessor);
  registerProcessor('trussal-master-player', TrussalMasterPlayerProcessor);
}
