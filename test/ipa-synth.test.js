import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeWav } from '../scripts/ipa-synth.mjs';
import { renderSound, soundList } from '../src/ipa-synth-core.js';
import { SAMPLE_RATE as SR, LOOP, SUSTAINED_LENGTH, SOUNDING, F0, planIpa, soundFile } from '../src/ipa-core.js';

const A = Math.round(LOOP.start * SR);
const B = Math.round(LOOP.end * SR);

// Windowed DFT magnitude at one frequency, over the loop's steady stretch.
function mag(buf, f) {
  let re = 0, im = 0;
  for (let i = A; i < B; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - A)) / (B - A));
    re += buf[i] * w * Math.cos((2 * Math.PI * f * i) / SR);
    im -= buf[i] * w * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return Math.hypot(re, im);
}

// Energy-weighted mean frequency of a noise spectrum.
function centroid(buf) {
  let n = 0, d = 0;
  for (let f = 200; f < 7900; f += 50) { const m = mag(buf, f) ** 2; n += f * m; d += m; }
  return n / d;
}

// Second formant of a vowel: the strongest harmonic between 600 and 2600 Hz
// once the F1 region is excluded.
function f2(buf) {
  let best = 0, at = 0;
  for (let h = 5; h * F0 < 2600; h++) { const m = mag(buf, h * F0); if (m > best) { best = m; at = h * F0; } }
  return at;
}

test('every file renders finite samples within full scale', () => {
  for (const [sym, v] of soundList()) {
    const buf = renderSound(sym, v);
    assert.ok(buf.length > 0, sym);
    for (const x of buf) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1, `${sym} ${v ?? ''}`);
  }
});

test('every sounding symbol gets a file', () => {
  const listed = new Set(soundList().map(([s]) => s));
  for (const { sym } of SOUNDING) assert.ok(listed.has(sym), sym);
});

test('every file a plan can ask for is rendered', () => {
  const have = new Set(soundList().map(([s, v]) => soundFile(s, v)));
  // Each sound bare, and under every diacritic that picks a variant or
  // trails a secondary articulation.
  const marks = ['', '\u0303', '\u0325', '\u0324', '\u0330', '\u032C', 'ʰ', 'ʷ', 'ʲ', 'ˠ', 'ˤ', '˞', 'ⁿ', 'ˡ'];
  for (const { sym } of SOUNDING) {
    for (const m of marks) {
      for (const p of planIpa(`/${sym}${m}/`)) assert.ok(have.has(p.file), `${sym}${m} → ${p.file}`);
    }
  }
});

test('sustained sounds loop seamlessly', () => {
  for (const sym of ['a', 'i', 'm', 'r', 's', 'x', 'l']) {
    const buf = renderSound(sym);
    assert.equal(buf.length, Math.round(SUSTAINED_LENGTH * SR));
    // The sample before the loop end must flow into the loop start the way
    // the sample before the loop start does.
    assert.ok(Math.abs(buf[B - 1] - buf[A - 1]) < 1e-3, sym);
  }
  const creak = renderSound('a', 'cr');
  assert.ok(Math.abs(creak[B - 1] - creak[A - 1]) < 1e-3, 'creaky voice');
});

test('vowel backness shows in F2: front [i] above central [ɨ] above back [u]', () => {
  const [i, ɨ, u] = ['i', 'ɨ', 'u'].map((s) => f2(renderSound(s)));
  assert.ok(i > ɨ && ɨ > u, `${i} ${ɨ} ${u}`);
});

test('rounding lowers F2: [y] below [i]', () => {
  assert.ok(f2(renderSound('y')) < f2(renderSound('i')));
});

test('vowel height shows in F1: open [a] has more energy near 800 Hz than close [i]', () => {
  const ratio = (s) => { const b = renderSound(s); return mag(b, 750) / mag(b, 250); };
  assert.ok(ratio('a') > ratio('i'));
});

test('fricative noise falls in frequency as the place moves back', () => {
  const order = ['s', 'ʃ', 'ʂ', 'x', 'χ'].map((s) => centroid(renderSound(s)));
  for (let k = 1; k < order.length; k++) assert.ok(order[k] < order[k - 1], order.map(Math.round).join(' '));
});

test('a voiced fricative carries voicing a voiceless one lacks', () => {
  const low = (s) => mag(renderSound(s), F0);
  assert.ok(low('z') > low('s') * 3);
});

test('a plosive is a closure then a burst', () => {
  const p = renderSound('p');
  const peakAt = p.reduce((best, x, i) => (Math.abs(x) > Math.abs(p[best]) ? i : best), 0);
  assert.ok(peakAt / SR > 0.05, 'burst comes after the closure');
  for (let i = 0; i < Math.round(0.05 * SR); i++) assert.ok(Math.abs(p[i]) < 1e-6, 'voiceless closure is silent');
});

test('rendering is deterministic', () => {
  assert.deepEqual(renderSound('ʃ'), renderSound('ʃ'));
});

test('files are 16-bit mono WAV at the shared sample rate', () => {
  const wav = encodeWav(renderSound('a'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), SR);
  assert.equal(wav.readUInt16LE(34), 16);
});

// --- sung rendering ------------------------------------------------------------

// Fundamental by autocorrelation over the steady part of a buffer. A periodic
// signal correlates as well at two periods as at one, so take the FIRST peak
// within 90% of the best rather than the best itself (the usual octave guard).
function fundamental(buf, from = 0.05, maxHz = 1600, minHz = 40) {
  const x = buf.subarray(Math.round(from * SR));
  const lo = Math.round(SR / maxHz), hi = Math.round(SR / minHz);
  const r = [];
  for (let L = 0; L <= hi + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < x.length; i++) s += x[i] * x[i + L];
    r[L] = s / (x.length - L);
  }
  const best = Math.max(...r.slice(lo, hi));
  for (let L = lo; L < hi; L++) {
    if (r[L] >= 0.9 * best && r[L] >= r[L - 1] && r[L] >= r[L + 1]) return SR / L;
  }
  return 0;
}

test('a sung vowel sounds at the requested pitch', () => {
  for (const hz of [110, 220, 330]) {
    const f = fundamental(renderSound('a', null, { f0: hz, length: 0.4 }));
    assert.ok(Math.abs(1200 * Math.log2(f / hz)) < 50, `${hz} Hz → ${f.toFixed(1)} Hz`);
  }
});

test('a sung sound is rendered to the length asked for', () => {
  assert.equal(renderSound('a', null, { f0: 220, length: 0.9 }).length, Math.round(0.9 * SR));
  assert.equal(renderSound('m', null, { f0: 220, length: 0.05 }).length, Math.round(0.05 * SR));
});

test('singing higher keeps the vowel: [i] stays front, [u] stays back', () => {
  // Energy above 1.8 kHz relative to below 1 kHz: [i]'s high F2/F3 against
  // [u]'s low F1/F2 — a pitch shift that moved formants would collapse this.
  const tilt = (sym, hz) => {
    const b = renderSound(sym, null, { f0: hz, length: 0.4 });
    let hi = 0, lo = 0;
    for (let f = 200; f < 1000; f += 25) lo += mag(b, f);
    for (let f = 1800; f < 3200; f += 25) hi += mag(b, f);
    return hi / lo;
  };
  for (const hz of [125, 300]) assert.ok(tilt('i', hz) > 3 * tilt('u', hz), `at ${hz} Hz`);
});

test('a contour glides from its first pitch to its last', () => {
  const b = renderSound('a', null, { f0: [150, 300], length: 0.6 });
  // Linear over the sound: 150 Hz at 0 s, 300 Hz at 0.6 s. Each window is
  // searched half an octave either side of where the contour should be, which
  // rules out octave errors — and a contour stuck at its start (150 Hz) falls
  // outside the later windows' range, so it would still fail.
  for (const [t0, t1] of [[0.05, 0.15], [0.25, 0.35], [0.45, 0.55]]) {
    const expected = 150 + 150 * ((t0 + t1) / 2) / 0.6;
    const win = b.subarray(Math.round(t0 * SR), Math.round(t1 * SR));
    const got = fundamental(win, 0, expected * Math.SQRT2, expected / Math.SQRT2);
    assert.ok(Math.abs(1200 * Math.log2(got / expected)) < 100, `${t0}-${t1}s: ${got.toFixed(0)} Hz, expected ${expected.toFixed(0)}`);
  }
});

test('the files are unchanged by the sung path', () => {
  // Rendering sung sounds must not leak pitch into the next file render.
  const before = renderSound('a');
  renderSound('a', null, { f0: 400, length: 0.3 });
  assert.deepEqual(renderSound('a'), before);
});

test('a bilabial trill is a run of lip closures, each released with a pop', () => {
  // 25 Hz: the lips are open for the first 40% of each 40 ms cycle and shut
  // for the rest. Shut, only the muffled voice bar gets out: the bright energy
  // (sample-to-sample change) must drop by well over 15 dB, while some
  // voicing remains.
  const trill = renderSound('ʙ');
  const meanOver = (startSeconds, endSeconds, measure) => {
    const first = Math.round(startSeconds * SR), last = Math.round(endSeconds * SR);
    let total = 0;
    for (let i = first; i < last; i++) total += measure(i);
    return total / (last - first);
  };
  const brightness = (start, end) => meanOver(start, end, (i) => (trill[i] - trill[i - 1]) ** 2);
  const energy = (start, end) => meanOver(start, end, (i) => trill[i] ** 2);
  for (const cycleStart of [0.08, 0.12, 0.16]) {
    const openBrightness = brightness(cycleStart + 0.002, cycleStart + 0.014);
    const shutBrightness = brightness(cycleStart + 0.020, cycleStart + 0.038);
    assert.ok(openBrightness > 50 * shutBrightness, `open vs shut at ${cycleStart}s: ${openBrightness} / ${shutBrightness}`);
    assert.ok(energy(cycleStart + 0.020, cycleStart + 0.038) > 0, `voice bar through the closure at ${cycleStart}s`);
  }
  // Voiceless: nothing at all gets out while the lips are shut.
  const voiceless = renderSound('ʙ', 'vl');
  let shutPeak = 0;
  for (let i = Math.round(0.105 * SR); i < Math.round(0.118 * SR); i++) shutPeak = Math.max(shutPeak, Math.abs(voiceless[i]));
  assert.ok(shutPeak < 1e-3);
});

// --- the chart's shaded cells ------------------------------------------------

// Mean of measure(i) over [start, end) seconds of buf.
function meanOver(buf, start, end, measure) {
  const first = Math.round(start * SR), last = Math.round(end * SR);
  let total = 0;
  for (let i = first; i < last; i++) total += measure(i);
  return total / (last - first);
}
const energyOf = (buf, start, end) => meanOver(buf, start, end, (i) => buf[i] ** 2);

// RMS spectral magnitude over a band around f, for noise spectra.
function band(buf, f, halfWidth = 150) {
  let sum = 0, n = 0;
  for (let x = f - halfWidth; x <= f + halfWidth; x += 10) { sum += mag(buf, x) ** 2; n++; }
  return Math.sqrt(sum / n);
}

test('a voiced glottal stop is voiced through its closure, where [ʔ] would be silence', () => {
  const stop = renderSound('ʔ̬');
  assert.ok(energyOf(stop, 0.01, 0.055) > 1e-3);
  // No burst — nothing is trapped above the folds — so the release is the
  // voice coming in hard, louder than the pressed buzz before it.
  assert.ok(energyOf(stop, 0.06, 0.08) > 2 * energyOf(stop, 0.01, 0.055));
});

test('a voiced pharyngeal stop holds its voicing through the closure, where [ɢ]\'s dies away', () => {
  const lateOverEarly = (sym) => {
    const b = renderSound(sym);
    // Each window is a whole number of the 40 Hz flutter's periods.
    return energyOf(b, 0.035, 0.06) / energyOf(b, 0.01, 0.035);
  };
  assert.ok(lateOverEarly('ʡ̬') > 0.9, lateOverEarly('ʡ̬'));
  assert.ok(lateOverEarly('ɢ') < 0.7, lateOverEarly('ɢ'));
});

test('a velar trill is whole closures at a heavier articulator\'s slower beat', () => {
  // 18.75 Hz: open for the first 45% of each 53 ms cycle, shut for the rest.
  const trill = renderSound('ʀ̟');
  const brightness = (start, end) => meanOver(trill, start, end, (i) => (trill[i] - trill[i - 1]) ** 2);
  for (const cycle of [2, 3]) {
    const start = cycle / 18.75;
    const open = brightness(start + 0.003, start + 0.021);
    const shut = brightness(start + 0.027, start + 0.051);
    assert.ok(open > 50 * shut, `cycle ${cycle}: ${open} / ${shut}`);
  }
});

test('a glottal trill is the voice itself switched off and on', () => {
  // 25 Hz: voiced for the first 55% of each 40 ms cycle; after that only the
  // tract's ring-down, which dies within a few milliseconds.
  const trill = renderSound('ʢ̠');
  for (const cycle of [2, 3, 4]) {
    const start = cycle / 25;
    const ratio = energyOf(trill, start + 0.003, start + 0.02) / energyOf(trill, start + 0.028, start + 0.0395);
    assert.ok(ratio > 20, `cycle ${cycle}: ${ratio}`);
  }
});

test('a glottal tap snaps the voice shut for a moment of silence; [ɾ] only dips', () => {
  const silent = (sym) => renderSound(sym).filter((x) => x === 0).length / SR;
  assert.ok(silent('ʔ̆') > 0.01, `${silent('ʔ̆')} s`);
  assert.ok(silent('ɾ') < 0.001);
});

test('a lateral is its column\'s sound with a notch where the pocket behind the contact sits', () => {
  // [notation, the central sound of the same column, the notch, a reference band]
  for (const [lateral, central, notch, ref] of [
    ['ɸˡ', 'ɸ', 2000, 1200], ['βˡ', 'β', 2000, 1200], ['fˡ', 'f', 5800, 4500], ['vˡ', 'v', 5800, 4500],
    ['ħˡ', 'ħ', 2200, 1200], ['ʕˡ', 'ʕ', 2200, 1200], ['hˡ', 'h', 1000, 1500], ['ɦˡ', 'ɦ', 1000, 1500],
    ['ʋˡ', 'ʋ', 1900, 1300], ['ɦ̞ˡ', 'ɦ̞', 2100, 1500],
  ]) {
    const depth = (sym) => { const b = renderSound(sym); return band(b, notch) / band(b, ref); };
    assert.ok(depth(lateral) < 0.5 * depth(central), `${lateral} ${depth(lateral)} vs ${central} ${depth(central)}`);
  }
});

test('a pharyngeal nasal carries the pharynx\'s high F1; a glottal nasal buzzes pressed, as creak', () => {
  const at750 = (sym) => { const b = renderSound(sym); return mag(b, 6 * F0) / mag(b, 2 * F0); };
  assert.ok(at750('ʡ̃') > 3 * at750('ɴ'), `${at750('ʡ̃')} vs ${at750('ɴ')}`);
  // Every other pulse weak: energy between the harmonics, at F0/2's odd multiples.
  const subharmonics = (sym) => {
    const b = renderSound(sym);
    const between = [0.5, 1.5, 2.5, 3.5].reduce((s, k) => s + mag(b, k * F0), 0);
    return between / [1, 2, 3, 4].reduce((s, k) => s + mag(b, k * F0), 0);
  };
  assert.ok(subharmonics('ʔ̃') > 0.1, subharmonics('ʔ̃'));
  assert.ok(subharmonics('ŋ') < 0.01, subharmonics('ŋ'));
});

test('shaded cells can be sung like any other sound', () => {
  const f = fundamental(renderSound('ɦ̞', null, { f0: 220, length: 0.4 }));
  assert.ok(Math.abs(1200 * Math.log2(f / 220)) < 50, `${f.toFixed(1)} Hz`);
  assert.equal(renderSound('ʡ̃', null, { f0: 330, length: 0.5 }).length, Math.round(0.5 * SR));
});
