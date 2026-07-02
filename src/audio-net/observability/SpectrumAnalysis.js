// Frequency response over time for the Network Metrics service.
//
// One AnalyserNode taps the master bus (everything latency-instrument.js
// routes to realDestination flows through it), producing a rolling window of
// downsampled FFT frames. The studio renders the newest frame as a mini
// spectrum; the research log consumes the same frames.
//
// `downsampleBins` is pure so the band math runs under node:test.

export const DEFAULT_BANDS = 32;
export const DEFAULT_FRAME_INTERVAL_MS = 250;
export const DEFAULT_HISTORY = 240; // 60 s of frames at 4 Hz

// Reduce an FFT magnitude array (Uint8Array or number[]) to `bands` values by
// averaging each contiguous bin group. Trailing bins that don't fill a whole
// group still form the final band.
export function downsampleBins(bins, bands) {
  const n = bins ? bins.length : 0;
  if (!n || !Number.isInteger(bands) || bands < 1) return [];
  if (bands >= n) return Array.from(bins);
  const out = new Array(bands);
  const per = n / bands;
  for (let b = 0; b < bands; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(n, Math.max(start + 1, Math.floor((b + 1) * per)));
    let sum = 0;
    for (let i = start; i < end; i++) sum += bins[i];
    out[b] = sum / (end - start);
  }
  return out;
}

export function createSpectrumAnalysis(audioCtx, sourceNode, {
  bands = DEFAULT_BANDS,
  intervalMs = DEFAULT_FRAME_INTERVAL_MS,
  history = DEFAULT_HISTORY,
  fftSize = 2048
} = {}) {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0.6;
  // Parallel tap: the source keeps its existing connections; the analyser is
  // a dead end (no output wired), so it never colors the audio path.
  sourceNode.connect(analyser);

  const binBuf = new Uint8Array(analyser.frequencyBinCount);
  const frames = []; // [{ t, bands: number[] }]
  const subscribers = new Set();
  let timer = null;

  function captureFrame() {
    analyser.getByteFrequencyData(binBuf);
    const frame = { t: audioCtx.currentTime, bands: downsampleBins(binBuf, bands) };
    frames.push(frame);
    if (frames.length > history) frames.shift();
    subscribers.forEach(fn => {
      try { fn(frame); } catch (e) { console.warn('[spectrum] subscriber threw', e); }
    });
  }

  return {
    analyser,
    start() {
      if (timer) return;
      timer = setInterval(captureFrame, intervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    getFrames() { return frames.slice(); },
    getLatestFrame() { return frames.length ? frames[frames.length - 1] : null; },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    dispose() {
      this.stop();
      try { sourceNode.disconnect(analyser); } catch (e) {}
      subscribers.clear();
    }
  };
}
