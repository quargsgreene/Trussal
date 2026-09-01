// Browser side of the impulse-response measurement.
//
// measure.mjs bundles this to an IIFE (globalName `TrussalIR`) with esbuild, so
// createRoomNode / createEchoNode / createCrushNode / createNoiseNode below are
// the REAL src/audio-net/av-effects/ builders — the same WebAudio graphs the
// aggregator assembles for the mix the room hears — not copies that could drift.
//
// What it does, per effect:
//   1. builds the effect node in an OfflineAudioContext at 48 kHz,
//   2. feeds a unit sample impulse through node.input -> node.output,
//   3. renders, then draws two labelled PNGs on a <canvas>:
//        <effect>.impulse-response.png   time domain
//        <effect>.frequency-response.png magnitude spectrum (FFT, or Welch PSD
//                                        for the noise bed)
//      crush also gets <effect>.quantiser-transfer.png — an impulse only
//      excites crush's sample-rate-reduction lowpass, so the defining
//      bit-depth nonlinearity is shown as its transfer curve instead.
//
// All parameters are handed in from measure.mjs, which derived them from the
// real *Params functions with WCL pinned at 100 ms; nothing is recomputed here.

import { createRoomNode } from '../../src/audio-net/av-effects/Room.js';
import { createEchoNode } from '../../src/audio-net/av-effects/Echo.js';
import { createCrushNode, makeCrushCurve } from '../../src/audio-net/av-effects/Crush.js';
import { createNoiseNode } from '../../src/audio-net/av-effects/Noise.js';

const BUILDERS = { room: createRoomNode, echo: createEchoNode, crush: createCrushNode, noise: createNoiseNode };

// ---------------------------------------------------------------------------
// Offline render
// ---------------------------------------------------------------------------

async function renderIR(name, params, seconds, sampleRate) {
  const AC = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  if (!AC) throw new Error('no OfflineAudioContext in this page');
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = new AC(1, length, sampleRate);
  const node = BUILDERS[name](ctx, params);

  const impulse = ctx.createBuffer(1, 128, sampleRate);
  impulse.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = impulse;
  src.connect(node.input);
  node.output.connect(ctx.destination);
  src.start(0);

  const buf = await ctx.startRendering();
  return buf.getChannelData(0); // Float32Array
}

// ---------------------------------------------------------------------------
// FFT (iterative radix-2) + spectra
// ---------------------------------------------------------------------------

function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = a + (len >> 1);
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// Single-shot magnitude spectrum of an impulse response: largest power of two
// that fits, DC removed, normalised so the peak bin is 0 dB.
//
// window 'hann' suits a response whose energy is spread through the record (a
// reverb tail, a train of echo taps) — it also suppresses the flat-spectrum
// dry impulse at t=0, leaving the wet path's colouration. window 'none'
// (rectangular) is for a SHORT impulsive response like crush's few-sample
// biquad ring: Hann's w[0] = 0 would delete the one sample that carries it.
function spectrumFFT(ir, sampleRate, window = 'hann') {
  let N = 1;
  while (N * 2 <= Math.min(ir.length, 32768)) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += ir[i];
  mean /= N;
  const w = window === 'none' ? null : hann(N);
  for (let i = 0; i < N; i++) re[i] = (ir[i] - mean) * (w ? w[i] : 1);
  fftRadix2(re, im);
  const half = N >> 1;
  const freq = new Float64Array(half), mag = new Float64Array(half);
  let peak = 1e-30;
  for (let k = 1; k < half; k++) {
    const m = Math.hypot(re[k], im[k]);
    freq[k] = (k * sampleRate) / N;
    mag[k] = m;
    if (m > peak) peak = m;
  }
  const db = new Float64Array(half);
  for (let k = 1; k < half; k++) db[k] = 20 * Math.log10(mag[k] / peak);
  return { freq: freq.subarray(1), db: db.subarray(1) };
}

// Welch PSD — for the noise bed, whose "spectrum" is a stochastic average, not
// the transform of one impulse. seg 8192, 50 % overlap, Hann.
function spectrumWelch(sig, sampleRate, seg = 8192) {
  const hop = seg >> 1;
  const w = hann(seg);
  const half = seg >> 1;
  const acc = new Float64Array(half);
  let frames = 0;
  const re = new Float64Array(seg), im = new Float64Array(seg);
  for (let start = 0; start + seg <= sig.length; start += hop) {
    for (let i = 0; i < seg; i++) { re[i] = sig[start + i] * w[i]; im[i] = 0; }
    fftRadix2(re, im);
    for (let k = 1; k < half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const freq = new Float64Array(half - 1), db = new Float64Array(half - 1);
  let peak = 1e-30;
  for (let k = 1; k < half; k++) if (acc[k] > peak) peak = acc[k];
  for (let k = 1; k < half; k++) {
    freq[k - 1] = (k * sampleRate) / seg;
    db[k - 1] = 10 * Math.log10((acc[k] / Math.max(1, frames)) / (peak / Math.max(1, frames)));
  }
  return { freq, db };
}

// ---------------------------------------------------------------------------
// Measured descriptors
// ---------------------------------------------------------------------------

function rms(ir) {
  let s = 0;
  for (let i = 0; i < ir.length; i++) s += ir[i] * ir[i];
  const r = Math.sqrt(s / ir.length);
  return { lin: r, db: r > 0 ? 20 * Math.log10(r) : -Infinity };
}

// Schroeder backward energy integral -> RT60 / EDT. `skipMs` drops the leading
// dry impulse and the truncated tail. T20: least-squares fit of the Schroeder
// energy-decay curve (dB) over the −5 dB … −25 dB span, slope extrapolated to
// 60 dB. The −5 dB start skips the direct impulse and the reverb build-up; the
// −25 dB end stays clear of the render's truncation floor — this is the ISO
// 3382 estimator, and it is stable where a raw −60 dB crossing is not.
function decayTimes(ir, sampleRate) {
  // Start the energy integral at the reverb onset — the first sample past 1 ms
  // above 20 % of the tail peak. Otherwise the direct impulse (amplitude 1,
  // ~20x the whole wet tail's energy) sits at edc[0] and the decay curve falls
  // off a cliff at sample 0 with no gradient left to fit.
  const oneMs = Math.floor(0.001 * sampleRate);
  let peak = 0;
  for (let i = oneMs; i < ir.length; i++) { const a = Math.abs(ir[i]); if (a > peak) peak = a; }
  let onset = oneMs;
  for (let i = oneMs; i < ir.length; i++) { if (Math.abs(ir[i]) >= 0.2 * peak) { onset = i; break; } }
  const tail = ir.subarray ? ir.subarray(onset) : ir.slice(onset);
  const edc = new Float64Array(tail.length);
  let e = 0;
  for (let i = tail.length - 1; i >= 0; i--) { e += tail[i] * tail[i]; edc[i] = e; }
  if (!(edc[0] > 0)) return { rt60Ms: null, earlyRt60Ms: null };
  const ref = edc[0];
  // Slope (dB/s) of a least-squares line through the EDC over a dB span.
  const rt = (loDb, hiDb) => {
    let n = 0, st = 0, sd = 0, stt = 0, std = 0;
    for (let i = 0; i < tail.length; i++) {
      const d = 10 * Math.log10(edc[i] / ref);
      if (d > hiDb || d < loDb) continue;
      const tt = i / sampleRate;
      n++; st += tt; sd += d; stt += tt * tt; std += tt * d;
    }
    if (n < 8) return null;
    const slope = (n * std - st * sd) / (n * stt - st * st);
    return slope < 0 ? (-60 / slope) * 1000 : null;
  };
  // T20 (ISO 3382, −5…−25 dB) covers the whole decay incl. the allpass tail;
  // the −1…−11 dB early slope tracks the comb decay that `decayS` sets.
  return { rt60Ms: rt(-25, -5), earlyRt60Ms: rt(-11, -1) };
}

// Local maxima of |ir| above a threshold, debounced — the echo taps.
function pickTaps(ir, sampleRate, startMs, thresh) {
  const start = Math.ceil((startMs / 1000) * sampleRate);
  const debounce = Math.ceil(0.02 * sampleRate);
  const taps = [];
  for (let i = start + 1; i < ir.length - 1; i++) {
    const a = Math.abs(ir[i]);
    if (a > thresh && a >= Math.abs(ir[i - 1]) && a > Math.abs(ir[i + 1])) {
      taps.push({ ms: +((i / sampleRate) * 1000).toFixed(2), amp: +ir[i].toFixed(5) });
      i += debounce;
    }
    if (taps.length >= 12) break;
  }
  return taps;
}

// Least-squares slope of dB vs log2(frequency) across a band — dB/octave.
function spectralSlope(freq, db, f0, f1) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < freq.length; i++) {
    const f = freq[i];
    if (f < f0 || f > f1 || !isFinite(db[i])) continue;
    const x = Math.log2(f);
    n++; sx += x; sy += db[i]; sxx += x * x; sxy += x * db[i];
  }
  if (n < 2) return null;
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

// First frequency past the passband where the level drops 3 dB under the
// passband plateau AND stays there — the plateau is the median over 100–1000 Hz,
// and a lone noisy bin 3 dB down doesn't count (the level must still be down
// ~1 kHz further on), so a ripply single-FFT magnitude doesn't trip it early.
function minus3dB(freq, db) {
  const lows = [];
  for (let i = 0; i < freq.length; i++) if (freq[i] >= 100 && freq[i] <= 1000) lows.push(db[i]);
  if (!lows.length) return null;
  lows.sort((a, b) => a - b);
  const ref = lows[lows.length >> 1];
  const levelAt = (f) => {
    for (let i = 0; i < freq.length; i++) if (freq[i] >= f) return db[i];
    return db[db.length - 1];
  };
  for (let i = 0; i < freq.length; i++) {
    const f = freq[i];
    if (f > 1000 && db[i] <= ref - 3 && levelAt(f * 2) <= ref - 3) return Math.round(f);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decimation for the JSON previews (the PNGs use the full arrays)
// ---------------------------------------------------------------------------

function decimate(xs, ys, target) {
  const n = xs.length;
  if (n <= target) return { x: Array.from(xs, (v) => +v), y: Array.from(ys, (v) => +v) };
  const x = [], y = [];
  const bin = n / target;
  for (let b = 0; b < target; b++) {
    const s = Math.floor(b * bin), e = Math.min(n, Math.floor((b + 1) * bin));
    let mi = s, ma = s;
    for (let i = s; i < e; i++) { if (ys[i] < ys[mi]) mi = i; if (ys[i] > ys[ma]) ma = i; }
    const lo = Math.min(mi, ma), hi = Math.max(mi, ma);
    x.push(+xs[lo]); y.push(+ys[lo]);
    if (hi !== lo) { x.push(+xs[hi]); y.push(+ys[hi]); }
  }
  return { x, y };
}

function logDecimate(freq, db, target, fmin = 20) {
  const fmax = freq[freq.length - 1] || 24000;
  const x = [], y = [];
  let j = 0;
  for (let b = 0; b < target; b++) {
    const f = fmin * Math.pow(fmax / fmin, b / (target - 1));
    while (j < freq.length - 1 && freq[j] < f) j++;
    x.push(+freq[j]); y.push(+db[j]);
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// Canvas plotter
// ---------------------------------------------------------------------------

function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range || 1));
  const f = (range || 1) / Math.pow(10, exp);
  let nf;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function niceTicks(min, max, n = 6) {
  if (!(max > min)) return [min];
  const range = niceNum(max - min, false);
  const step = niceNum(range / Math.max(1, n - 1), true);
  const lo = Math.floor(min / step) * step;
  const out = [];
  for (let v = lo; v <= max + step * 0.5; v += step) if (v >= min - step * 0.5) out.push(+v.toFixed(10));
  return out;
}

const LOG_TICKS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

function fmtNum(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toFixed(a % 1000 === 0 ? 0 : 1) + 'k';
  if (a >= 1) return String(+v.toFixed(2));
  if (a >= 0.01) return String(+v.toFixed(3));
  return v.toExponential(1);
}

// spec: { title, subtitle, xlabel, ylabel, xScale:'lin'|'log', xRange, yRange,
//         series:[{xs,ys,color,width,dash}], markers:[{x,label,color}], notes:[] }
function plot(spec) {
  const W = 960, H = 440, dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);

  const m = { l: 78, r: 26, t: 64, b: 58 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  g.fillStyle = '#111827';
  g.font = '600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  g.fillText(spec.title, m.l, 26);
  g.fillStyle = '#6b7280';
  g.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  g.fillText(spec.subtitle || '', m.l, 45);

  const [x0, x1] = spec.xRange, [y0, y1] = spec.yRange;
  const lx = spec.xScale === 'log';
  const lgx0 = lx ? Math.log10(x0) : 0, lgx1 = lx ? Math.log10(x1) : 0;
  const X = (v) => lx
    ? m.l + ((Math.log10(Math.max(v, x0)) - lgx0) / (lgx1 - lgx0)) * pw
    : m.l + ((v - x0) / (x1 - x0)) * pw;
  const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * ph;

  // Ticks are clamped to the axis range — a nice-number tick that lands just
  // outside would otherwise draw its gridline into the title band above the plot.
  const inRange = (v, a, b) => v >= Math.min(a, b) - 1e-9 && v <= Math.max(a, b) + 1e-9;
  const xTicks = (lx
    ? LOG_TICKS.map((v) => ({ v, label: fmtNum(v) }))
    : niceTicks(x0, x1, 8).map((v) => ({ v, label: fmtNum(v) }))
  ).filter((t) => inRange(t.v, x0, x1));
  const yTicks = niceTicks(y0, y1, 7).map((v) => ({ v, label: fmtNum(v) })).filter((t) => inRange(t.v, y0, y1));

  g.strokeStyle = '#ececf1';
  g.lineWidth = 1;
  g.fillStyle = '#6b7280';
  g.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  for (const t of xTicks) {
    const x = X(t.v);
    g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke();
    g.textAlign = 'center';
    g.fillText(t.label, x, m.t + ph + 16);
  }
  for (const t of yTicks) {
    const y = Y(t.v);
    g.beginPath(); g.moveTo(m.l, y); g.lineTo(m.l + pw, y); g.stroke();
    g.textAlign = 'right';
    g.fillText(t.label, m.l - 8, y + 3);
  }

  if (y0 < 0 && y1 > 0) {
    g.strokeStyle = '#c3c3cc';
    g.beginPath(); g.moveTo(m.l, Y(0)); g.lineTo(m.l + pw, Y(0)); g.stroke();
  }

  g.strokeStyle = '#9ca3af';
  g.lineWidth = 1;
  g.strokeRect(m.l, m.t, pw, ph);

  g.fillStyle = '#374151';
  g.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  g.textAlign = 'center';
  g.fillText(spec.xlabel, m.l + pw / 2, H - 16);
  g.save();
  g.translate(20, m.t + ph / 2);
  g.rotate(-Math.PI / 2);
  g.fillText(spec.ylabel, 0, 0);
  g.restore();

  g.save();
  g.beginPath();
  g.rect(m.l, m.t, pw, ph);
  g.clip();
  for (const s of spec.series || []) {
    g.strokeStyle = s.color || '#2563eb';
    g.lineWidth = s.width || 1.4;
    g.setLineDash(s.dash || []);
    g.beginPath();
    let started = false;
    for (let i = 0; i < s.xs.length; i++) {
      const xv = s.xs[i];
      if (xv < x0 || xv > x1) { started = false; continue; }
      let yv = s.ys[i];
      if (yv > y1) yv = y1; else if (yv < y0) yv = y0;
      const px = X(xv), py = Y(yv);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    g.stroke();
    g.setLineDash([]);
  }
  for (const mk of spec.markers || []) {
    if (mk.x < x0 || mk.x > x1) continue;
    const x = X(mk.x);
    g.strokeStyle = mk.color || '#dc2626';
    g.setLineDash([4, 3]);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke();
    g.setLineDash([]);
    g.fillStyle = mk.color || '#dc2626';
    g.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    g.textAlign = 'left';
    // Labels sit at the bottom of the plot — the top-right corner is the notes box.
    g.fillText(mk.label, x + 3, m.t + ph - 6 - (mk.row || 0) * 12);
  }
  g.restore();

  const notes = spec.notes || [];
  if (notes.length) {
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'left';
    let wb = 0;
    for (const ln of notes) wb = Math.max(wb, g.measureText(ln).width);
    wb += 16;
    const bh = notes.length * 14 + 10;
    const corner = spec.notesCorner || 'top-right';
    const bx = corner.endsWith('left') ? m.l + 6 : m.l + pw - wb - 6;
    const by = corner.startsWith('bottom') ? m.t + ph - bh - 6 : m.t + 6;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(bx, by, wb, bh);
    g.strokeStyle = '#e5e7eb';
    g.strokeRect(bx, by, wb, bh);
    g.fillStyle = '#374151';
    notes.forEach((ln, i) => g.fillText(ln, bx + 8, by + 17 + i * 14));
  }

  return cv.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Per-effect measurement
// ---------------------------------------------------------------------------

function round(v, d = 4) {
  if (v == null || !isFinite(v)) return v == null ? null : v;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

async function measureOne(name, cfg) {
  const spec = cfg.effects[name];
  const sr = cfg.sampleRate;
  const p = spec.params;
  const wcl = cfg.wclMs;
  const ir = await renderIR(name, p, spec.seconds, sr);

  // --- time domain ---------------------------------------------------------
  const winSamp = Math.min(ir.length, Math.ceil((spec.impulseWindowMs / 1000) * sr));
  const t = new Float64Array(winSamp), y = new Float64Array(winSamp);
  for (let i = 0; i < winSamp; i++) { t[i] = (i / sr) * 1000; y[i] = ir[i]; }

  let peakAll = 0;
  for (let i = 0; i < ir.length; i++) peakAll = Math.max(peakAll, Math.abs(ir[i]));
  const skip = (name === 'room' || name === 'echo') ? Math.ceil(0.002 * sr) : 0;
  let peakTail = 1e-6;
  for (let i = skip; i < ir.length; i++) peakTail = Math.max(peakTail, Math.abs(ir[i]));
  const yMax = (name === 'room' || name === 'echo') ? peakTail * 1.3 : Math.max(peakAll * 1.15, 1e-4);

  const r = rms(ir);
  const stats = {
    renderSeconds: spec.seconds,
    sampleRate: sr,
    peakAbs: round(peakAll, 5),
    rmsDb: round(r.db, 2),
  };

  const timeNotes = [`WCL = ${wcl} ms  (metric = wcl, pinned)`];
  const markers = [];

  if (name === 'room') {
    Object.assign(stats, {
      decayS: round(p.decayS, 4),
      cutoffHz: round(p.cutoffHz, 1),
      wetGain: round(p.wetGain, 4),
      combDelaysMs: p.combDelaysS.map((d) => round(d * 1000, 2)),
      combFeedbacks: p.combFeedbacks.map((v) => round(v, 4)),
      ...(() => { const d = decayTimes(ir, sr); return { measuredRt60Ms: round(d.rt60Ms, 1), measuredEarlyRt60Ms: round(d.earlyRt60Ms, 1) }; })(),
    });
    timeNotes.push(`RT60 target ${(p.decayS * 1000).toFixed(0)} ms   measured ${stats.measuredRt60Ms ?? 'n/a'} ms (T20), ${stats.measuredEarlyRt60Ms ?? 'n/a'} ms early`);
    timeNotes.push(`lowpass ${(p.cutoffHz / 1000).toFixed(2)} kHz   wet ${p.wetGain}`);
    if (peakAll > yMax) timeNotes.push(`dry impulse ${peakAll.toFixed(3)} clipped to show tail`);
  } else if (name === 'echo') {
    const taps = pickTaps(ir, sr, 5, Math.max(0.0015, peakTail * 0.02));
    Object.assign(stats, {
      delayS: round(p.delayS, 4),
      lengthCycles: round(p.lengthCycles, 4),
      feedback: round(p.feedback, 4),
      echoGain: round(p.gain, 4),
      wetGain: round(p.wetGain, 4),
      cycleSeconds: cfg.cycle.seconds,
      measuredTaps: taps,
    });
    for (let n = 1; n <= 8; n++) {
      const mx = n * p.delayS * 1000;
      if (mx <= spec.impulseWindowMs) markers.push({ x: mx, label: `${n}×delay`, row: n % 2 });
    }
    timeNotes.push(`delay ${(p.delayS * 1000).toFixed(0)} ms = ${p.lengthCycles} cyc × ${cfg.cycle.seconds}s`);
    timeNotes.push(`feedback ${p.feedback}   wet ${p.wetGain}`);
    timeNotes.push('wet path +~6 ms (compressor lookahead)');
    if (peakAll > yMax) timeNotes.push(`dry impulse ${peakAll.toFixed(3)} clipped to show taps`);
  } else if (name === 'crush') {
    Object.assign(stats, {
      bitDepth: round(p.bitDepth, 4),
      quantSteps: Math.round(Math.pow(2, p.bitDepth)),
      srDivisor: p.srDivisor,
      reduction: round(p.reduction, 4),
      srCornerHz: round(sr / 2 / p.srDivisor, 1),
      settlesTo: round(ir[ir.length - 1], 5),
    });
    markers.push({ x: 0, label: '' });
    timeNotes.push(`bitDepth ${p.bitDepth}  (${stats.quantSteps} steps, step ${round(2 / (stats.quantSteps - 1), 4)})`);
    timeNotes.push(`srDivisor ${p.srDivisor}  -> lowpass ${(stats.srCornerHz / 1000).toFixed(1)} kHz`);
    timeNotes.push(`response = 12 kHz biquad ring; settles to ${stats.settlesTo}`);
  } else if (name === 'noise') {
    Object.assign(stats, {
      tilt: round(p.tilt, 4),
      type: p.type,
      gainDb: round(p.gainDb, 2),
      gain: round(p.gain, 4),
      mix: { brown: round(p.mix.brown, 4), pink: round(p.mix.pink, 4), white: round(p.mix.white, 4) },
      bedRmsDb: round(r.db, 2),
    });
    timeNotes.push('noise is ADDITIVE: input passes through, bed is summed on');
    timeNotes.push(`tilt ${p.tilt} (${p.type})   ${p.gainDb.toFixed(1)} dB`);
    timeNotes.push(`mix  brown ${stats.mix.brown}  pink ${stats.mix.pink}  white ${stats.mix.white}`);
  }

  const timePlot = plot({
    title: `${name} — impulse response`,
    subtitle: `OfflineAudioContext ${sr} Hz · WCL 100 ms · window ${spec.impulseWindowMs} ms`,
    xlabel: 'time (ms)',
    ylabel: 'amplitude (linear)',
    xScale: 'lin',
    xRange: [0, spec.impulseWindowMs],
    yRange: [-yMax, yMax],
    series: [{ xs: t, ys: y, color: '#2563eb', width: 1.3 }],
    markers,
    notes: timeNotes,
  });

  // --- frequency domain --------------------------------------------------
  const sig = spec.spectrum === 'welch' ? spectrumWelch(ir, sr) : spectrumFFT(ir, sr, spec.fftWindow || 'hann');
  let dbMin = 6, dbMax = -120;
  for (let i = 0; i < sig.db.length; i++) {
    if (sig.freq[i] < 20) continue;
    if (isFinite(sig.db[i])) { dbMin = Math.min(dbMin, sig.db[i]); dbMax = Math.max(dbMax, sig.db[i]); }
  }
  dbMin = Math.max(dbMin, -78);
  dbMax = Math.min(Math.ceil((dbMax + 3) / 3) * 3, 6);

  const freqMarkers = [];
  const freqNotes = [`WCL = ${wcl} ms`];
  if (name === 'room') {
    freqMarkers.push({ x: p.cutoffHz, label: `lowpass ${(p.cutoffHz / 1000).toFixed(1)}k`, color: '#dc2626' });
    freqNotes.push('comb ripple + cascaded 2nd-order lowpass');
  } else if (name === 'echo') {
    freqNotes.push(`feedback comb, teeth every 1/${(p.delayS * 1000).toFixed(0)}ms = ${(1 / p.delayS).toFixed(1)} Hz`);
    freqNotes.push(`depth ~${(20 * Math.log10((1 - p.feedback) / (1 + p.feedback))).toFixed(1)} dB · continues to Nyquist`);
  } else if (name === 'crush') {
    const m3 = minus3dB(sig.freq, sig.db);
    freqMarkers.push({ x: sr / 2 / p.srDivisor, label: `Nyquist/${p.srDivisor}`, color: '#dc2626' });
    if (m3) { freqMarkers.push({ x: m3, label: `-3 dB ${fmtNum(m3)}`, color: '#059669', row: 1 }); stats.measuredMinus3dBHz = m3; }
    freqNotes.push('impulse excites only the SR-reduction lowpass');
    freqNotes.push('bit-depth crush -> see quantiser-transfer.png');
  } else if (name === 'noise') {
    const slope = spectralSlope(sig.freq, sig.db, 200, 8000);
    if (slope != null) { stats.measuredSlopeDbPerOct = round(slope, 2); freqNotes.push(`slope ${slope.toFixed(1)} dB/oct  (brown -6, pink -3, white 0)`); }
    freqNotes.push('Welch PSD of the noise bed, 8192-pt Hann');
  }

  const freqPlot = plot({
    title: `${name} — magnitude frequency response`,
    subtitle: spec.spectrum === 'welch'
      ? `Welch PSD of the rendered output · WCL 100 ms`
      : `FFT of the impulse response · WCL 100 ms`,
    xlabel: 'frequency (Hz)',
    ylabel: spec.spectrum === 'welch' ? 'power (dB, rel. peak)' : 'magnitude (dB, rel. peak)',
    xScale: 'log',
    xRange: [20, spec.freqXMax || sr / 2],
    yRange: [dbMin, dbMax],
    // crush's action is all in the top-right (passband + rolloff); keep the box clear of it.
    notesCorner: name === 'crush' ? 'bottom-left' : 'top-right',
    series: [{ xs: sig.freq, ys: sig.db, color: '#7c3aed', width: 1.2 }],
    markers: freqMarkers,
    notes: freqNotes,
  });

  const plots = { 'impulse-response': timePlot, 'frequency-response': freqPlot };
  const previews = {
    impulse: { xlabel: 'time (ms)', ylabel: 'amplitude', xScale: 'lin', ...decimate(t, y, 1600) },
    frequency: {
      xlabel: 'frequency (Hz)',
      ylabel: spec.spectrum === 'welch' ? 'power (dB)' : 'magnitude (dB)',
      xScale: 'log',
      ...logDecimate(sig.freq, sig.db, 1200),
    },
  };

  // --- crush: quantiser transfer curve ---------------------------------
  if (name === 'crush') {
    const curve = makeCrushCurve(p.bitDepth, 2048);
    const cx = new Float64Array(curve.length), cy = new Float64Array(curve.length);
    for (let i = 0; i < curve.length; i++) { cx[i] = (i * 2) / (curve.length - 1) - 1; cy[i] = curve[i]; }
    plots['quantiser-transfer'] = plot({
      title: 'crush — quantiser transfer curve',
      subtitle: `bit-depth ${round(p.bitDepth, 3)} -> ${Math.round(Math.pow(2, p.bitDepth))} steps · WCL 100 ms`,
      xlabel: 'input sample',
      ylabel: 'output sample',
      xScale: 'lin',
      xRange: [-1, 1],
      yRange: [-1, 1],
      notesCorner: 'top-left',
      series: [
        { xs: [-1, 1], ys: [-1, 1], color: '#c3c3cc', width: 1, dash: [5, 4] },
        { xs: cx, ys: cy, color: '#2563eb', width: 1.6 },
      ],
      notes: [
        `reduction 2^(100/100) = ${round(p.reduction, 3)}`,
        `base 8 bit / reduction = ${round(p.bitDepth, 3)} bit`,
        `curve straddles 0 (steps +-${round(cy[Math.ceil(curve.length / 2)], 3)});`,
        `WaveShaper interpolates -> 0 in, 0 out`,
      ],
    });
    previews.transfer = { xlabel: 'input', ylabel: 'output', xScale: 'lin', ...decimate(cx, cy, 800) };
  }

  return { label: name, params: p, seconds: spec.seconds, sampleRate: sr, stats, plots, previews };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function measureAll(cfg, only) {
  const names = only ? (Array.isArray(only) ? only : [only]) : Object.keys(cfg.effects);
  const out = {
    meta: {
      wclMs: cfg.wclMs,
      metric: 'wcl',
      sampleRate: cfg.sampleRate,
      cycle: cfg.cycle,
      generatedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      href: typeof location !== 'undefined' ? location.href : null,
    },
    effects: {},
  };
  for (const name of names) {
    try {
      out.effects[name] = await measureOne(name, cfg);
    } catch (e) {
      console.error(`[TrussalIR] ${name} failed`, e);
      out.effects[name] = { label: name, error: String(e && e.stack || e) };
    }
  }
  return out;
}

export { makeCrushCurve };
