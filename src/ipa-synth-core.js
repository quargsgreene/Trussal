// ipa-synth-core.js — the synthesizer behind every IPA sound. Pure: no DOM,
// no Web Audio, no Node — it returns Float32Arrays at SAMPLE_RATE. Two users:
//   - scripts/ipa-synth.mjs renders the loopable files in /assets/ipa
//     (renderSound(sym, variant)), which play IPA words with no pitch;
//   - ipa-voice.js renders on demand at a note's pitch
//     (renderSound(sym, variant, { f0, length })) when a word is sung.
//
// A Klatt-style source-filter synthesizer:
//   - SOURCE: a glottal pulse train (Rosenberg pulse, lip-radiation
//     differentiated) for voicing, seeded white noise for frication and
//     aspiration — mixed per sound;
//   - FILTER: cascade formant resonators for vowels, approximants, nasals
//     (with a place-dependent antiresonance) and aspiration; parallel
//     resonators over noise for frication and bursts, shaped by place.
// Every parameter below comes from the sound's articulatory description —
// its height/backness/rounding, or place/manner/voicing — not from any
// language's phoneme inventory, so [x] is a velar fricative and [y] is a
// close front rounded vowel, whatever English would call them.
//
// Deterministic: same parameters, same seed, identical samples.

import {
  SOUNDING, VARIANTS, SAMPLE_RATE as SR, F0, LOOP, SUSTAINED_LENGTH,
  ONESHOT_LENGTH, isSustained,
} from './ipa-core.js';

const T = 1 / SR;

// What the current render is for. renderSound() sets it and every generator
// below reads it, rather than threading pitch and length through each one.
// Renders are synchronous, so nothing can observe it half-set.
//   f0(t)  — fundamental in Hz at t seconds (a constant F0 for the files)
//   length — seconds of steady sound to render for a sustained class
let ctx = { f0: () => F0, length: SUSTAINED_LENGTH };

// --- DSP primitives --------------------------------------------------------------

// Klatt's two-pole resonator, unity gain at DC.
function resonator(f, bw) {
  const C = -Math.exp(-2 * Math.PI * bw * T);
  const B = 2 * Math.exp(-Math.PI * bw * T) * Math.cos(2 * Math.PI * f * T);
  const A = 1 - B - C;
  let y1 = 0, y2 = 0;
  return (x) => { const y = A * x + B * y1 + C * y2; y2 = y1; y1 = y; return y; };
}

// Its inverse: a spectral zero, for nasal and lateral side branches.
function antiresonator(f, bw) {
  const C = -Math.exp(-2 * Math.PI * bw * T);
  const B = 2 * Math.exp(-Math.PI * bw * T) * Math.cos(2 * Math.PI * f * T);
  const A = 1 - B - C;
  let x1 = 0, x2 = 0;
  return (x) => { const y = (x - B * x1 - C * x2) / A; x2 = x1; x1 = x; return y; };
}

function cascade(formants) {
  const rs = formants.map(([f, bw]) => resonator(f, bw));
  return (x) => { for (const r of rs) x = r(x); return x; };
}

// Parallel bank over noise: each peak is a resonator normalised to its own
// bandwidth, so `gain` reads as relative spectral level.
function parallel(peaks) {
  const rs = peaks.map(([f, bw, g]) => [resonator(f, bw), g]);
  return (x) => { let y = 0; for (const [r, g] of rs) y += g * r(x); return y; };
}

function highpass(fc) {
  const a = Math.exp(-2 * Math.PI * fc * T);
  let x1 = 0, y1 = 0;
  return (x) => { const y = a * (y1 + x - x1); x1 = x; y1 = y; return y; };
}

function lowpass(fc) {
  const a = Math.exp(-2 * Math.PI * fc * T);
  let y1 = 0;
  return (x) => (y1 = (1 - a) * x + a * y1);
}

// Seeded noise (mulberry32), so rebuilding never changes a file.
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

// Glottal source. `oq` is the open quotient (breathy voice opens longer);
// `rate` scales the render's F0 (creak runs at half). Returns the
// differentiated pulse (lip radiation) and the raw flow, which modulates
// frication in voiced fricatives the way airflow does.
//
// A phase accumulator rather than a sample counter, so F0 can be any pitch
// and can glide. At the files' 125 Hz the step is exactly 1/128 — a power of
// two, so every period is bit-identical and the file loops stay seamless.
function glottis({ oq = 0.6, rate = 1, alternate = 0 } = {}) {
  const f0 = ctx.f0;
  let i = 0, ph = 0, prev = 0, cycle = 0;
  return () => {
    const open = oq * 0.7, close = oq;
    let flow = 0;
    if (ph < open) flow = 0.5 * (1 - Math.cos(Math.PI * ph / open));
    else if (ph < close) flow = Math.cos(0.5 * Math.PI * (ph - open) / (close - open));
    // Creak: every other pulse weaker (diplophonia), still periodic.
    if (alternate && cycle % 2) flow *= 1 - alternate;
    const d = flow - prev;
    prev = flow;
    ph += (f0(i++ * T) * rate) / SR;
    if (ph >= 1) { ph -= 1; cycle++; }
    return { pulse: d * 8, flow };
  };
}

function rms(buf) {
  let s = 0;
  for (const x of buf) s += x * x;
  return Math.sqrt(s / buf.length);
}

function normaliseRms(buf, db, from = 0) {
  const r = rms(buf.subarray(from)) || 1;
  const g = 10 ** (db / 20) / r;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

function normalisePeak(buf, db) {
  let p = 0;
  for (const x of buf) p = Math.max(p, Math.abs(x));
  const g = 10 ** (db / 20) / (p || 1);
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

function render(seconds, fn) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = fn(i, i * T);
  return out;
}

// Where a sustained render's level is measured: after the onset, inside the
// stretch the files loop over. renderSound() always renders at least this far.
const STEADY = Math.round(LOOP.start * SR);

// A short fade-in only: the end of every file is faded by the player, which
// cuts sustained sounds wherever their length lands.
function fadeIn(buf, s = 0.008) {
  const n = Math.min(buf.length, Math.round(s * SR));
  for (let i = 0; i < n; i++) buf[i] *= i / n;
  return buf;
}

// Make the loop's end flow into its start: over the last stretch before
// LOOP.end, blend toward the samples just before LOOP.start, so the jump back
// lands on matching material. Periodic sounds are already identical there and
// are unchanged; noise loses its click.
function crossfadeLoop(buf, s = 0.02) {
  const a = STEADY, b = Math.round(LOOP.end * SR);
  const n = Math.round(s * SR);
  for (let k = 0; k < n; k++) {
    const w = (k + 1) / n;
    const i = b - n + k;
    buf[i] = buf[i] * (1 - w) + buf[a - n + k] * w;
  }
  return buf;
}

const HIGHER = [[3300, 250], [3750, 300]]; // F4, F5 — fixed, as in Klatt's default
// A tract with no constriction in it: schwa's formants, and the glottal sounds'.
const NEUTRAL = [500, 1500, 2500];

// --- Vowels ----------------------------------------------------------------------
//
// F1 tracks height (open → high F1), F2 tracks backness (front → high F2), and
// rounding lowers F2 and F3. Values are the cardinal-vowel targets for an
// adult voice at this F0.
const VOWEL_FORMANTS = {
  i: [270, 2290, 3010], y: [270, 1900, 2250], ɨ: [300, 1600, 2400], ʉ: [300, 1400, 2200],
  ɯ: [320, 1150, 2400], u: [300, 750, 2300], ɪ: [390, 1990, 2550], ʏ: [390, 1700, 2250],
  ʊ: [430, 1020, 2240], e: [400, 2100, 2700], ø: [400, 1650, 2250], ɘ: [420, 1500, 2450],
  ɵ: [420, 1300, 2300], ɤ: [450, 1100, 2450], o: [420, 750, 2350], ə: [500, 1400, 2450],
  ɚ: [490, 1350, 1700], ɛ: [580, 1850, 2600], œ: [580, 1550, 2300], ɜ: [580, 1450, 2450],
  ɝ: [550, 1350, 1700], ɞ: [580, 1300, 2300], ʌ: [640, 1190, 2390], ɔ: [580, 880, 2450],
  æ: [700, 1700, 2450], ɐ: [700, 1350, 2400], a: [800, 1550, 2600], ɶ: [780, 1300, 2400],
  ɑ: [750, 1150, 2500], ɒ: [700, 900, 2450],
};

function formantList([f1, f2, f3], wide = 1) {
  return [[f1, 60 * wide], [f2, 90 * wide], [f3, 150 * wide], ...HIGHER];
}

// Voiced through a cascade, the whole vowel a single filter chain.
function voicedTract(formants, { oq, alternate, rate, breath = 0, nasal = null, seed = 1 } = {}) {
  const src = glottis({ oq, alternate, rate });
  const tilt = lowpass(breath ? 1800 : 3500);
  const asp = noise(seed);
  const tract = cascade(formants);
  const nz = nasal ? [resonator(nasal.pole, 100), antiresonator(nasal.zero, 100)] : null;
  return () => {
    const { pulse, flow } = src();
    let x = tilt(pulse);
    // Breathy voice leaks turbulent air through the open phase.
    if (breath) x += breath * asp() * (0.4 + flow);
    if (nz) x = nz[1](nz[0](x));
    return tract(x);
  };
}

// Whisper: the same tract, excited by aspiration noise instead of the folds.
function whisperedTract(formants, seed) {
  const n = noise(seed);
  const tract = cascade(formants.map(([f, bw]) => [f, bw * 1.5]));
  const hp = highpass(300);
  return () => tract(hp(n()) * 0.3);
}

const LEVEL = {
  vowel: -14, nasal: -19, approximant: -17, trill: -18,
  whisper: -26,
};

function renderVowel(sym, variant, seed) {
  const fs = VOWEL_FORMANTS[sym];
  let gen;
  let level = LEVEL.vowel;
  if (variant === 'vl') { gen = whisperedTract(formantList(fs), seed); level = LEVEL.whisper; }
  else if (variant === 'br') gen = voicedTract(formantList(fs, 1.3), { oq: 0.85, breath: 0.12, seed });
  else if (variant === 'cr') { gen = voicedTract(formantList(fs), { oq: 0.35, rate: 0.5, alternate: 0.5 }); level -= 2; }
  // Nasalization couples in the nasal cavity: a pole near 270 Hz and a zero
  // that rides above it, with a damped (wider) F1.
  else if (variant === 'nas') { gen = voicedTract(formantList([fs[0] + 50, fs[1], fs[2]], 1.4), { nasal: { pole: 270, zero: 450 + fs[0] * 0.3 } }); level -= 1; }
  else gen = voicedTract(formantList(fs));
  const buf = render(ctx.length, gen);
  return fadeIn(normaliseRms(buf, level, STEADY));
}

// --- Sonorant consonants --------------------------------------------------------

// Approximants and laterals are vowel-like tracts with a constriction: lower
// F1, and the place shows in F2/F3 (ɹ's famously low F3). Laterals add the
// antiresonance of the side branch around the tongue.
const APPROXIMANTS = {
  ʋ: { f: [300, 1400, 2300] },
  ɹ: { f: [350, 1100, 1600] },
  ɻ: { f: [350, 1200, 1450] },
  j: { f: [260, 2250, 3000] },
  ɰ: { f: [300, 1100, 2400] },
  w: { f: [300, 650, 2200] },
  ɥ: { f: [280, 1900, 2200] },
  l: { f: [360, 1500, 2700], zero: 2000 },
  ɭ: { f: [360, 1300, 2000], zero: 1700 },
  ʎ: { f: [300, 2100, 2900], zero: 2500 },
  ʟ: { f: [360, 1000, 2400], zero: 1700 },
  ɫ: { f: [400, 900, 2600], zero: 1800 },
  // Shaded cells. At the glottis the only constriction is the voice itself:
  // an unconstricted tract, breathy, with F1 pulled down the way every other
  // approximant's constriction pulls it. The laterals are each column's
  // approximant split around a midline contact — one zero per side, a little
  // apart, since no mouth is symmetric.
  'ɦ̞': { f: [300, ...NEUTRAL.slice(1)], breathy: true },
  'β̞ˡ': { f: [300, 700, 2200], zero: [1200, 1350] },
  'ʋˡ': { f: [300, 1300, 2300], zero: [1800, 2000] },
  'ʕ̞ˡ': { f: [650, 1100, 2500], zero: [2100, 2300] },
  'ɦ̞ˡ': { f: [300, ...NEUTRAL.slice(1)], zero: [2000, 2200], breathy: true },
};

// Nasal murmur: oral tract closed at the place of articulation, sound leaving
// through the nose. A low nasal formant dominates; the closed oral cavity adds
// an antiresonance whose frequency names the place.
const NASALS = {
  m: { zero: 1000, f2: 1100 }, ɱ: { zero: 1100, f2: 1200 }, n: { zero: 1600, f2: 1500 },
  ɳ: { zero: 1400, f2: 1300 }, ɲ: { zero: 2200, f2: 2000 }, ŋ: { zero: 2800, f2: 2300 },
  ɴ: { zero: 3200, f2: 1100 },
};

// Trills: the articulator beats against the airstream ~25 times a second.
// 25 Hz is 5 glottal periods, so the loop stays seamless. The lips are not a
// tongue tip, so [ʙ] has a renderer of its own (renderClosingTrill).
const TRILLS = {
  r: { f: [400, 1400, 2500], depth: 0.9 },
  ʀ: { f: [450, 1100, 2300], depth: 0.8 },
};
const TRILL_HZ = 25;

function renderApproximant(sym, variant, seed) {
  const { f, zero, breathy } = APPROXIMANTS[sym];
  const fl = formantList(f, zero ? 1.3 : 1);
  let gen = variant === 'vl' ? whisperedTract(fl, seed)
    : voicedTract(fl, breathy ? { oq: 0.85, breath: 0.12, seed } : {});
  for (const zf of [].concat(zero ?? [])) { const z = antiresonator(zf, 300); const g = gen; gen = () => z(g()); }
  const buf = render(ctx.length, gen);
  return fadeIn(normaliseRms(buf, variant === 'vl' ? LEVEL.whisper : LEVEL.approximant, STEADY));
}

function renderNasal(sym, variant, seed) {
  const { zero, f2 } = NASALS[sym];
  const fl = [[250, 60], [f2, 200], [2300, 250], ...HIGHER];
  const base = variant === 'vl' ? whisperedTract(fl, seed) : voicedTract(fl);
  const z = antiresonator(zero, 150);
  const lp = lowpass(2500);
  const buf = render(ctx.length, () => lp(z(base())));
  return fadeIn(normaliseRms(buf, variant === 'vl' ? LEVEL.whisper : LEVEL.nasal, STEADY));
}

// [ʙ]: the lips are blown apart and spring shut ~25 times a second, and they
// spend most of each cycle closed. A tongue-tip trill keeps the mouth open and
// only dips, but a lip trill is a run of tiny [b]s: in each cycle
//   - closure: the mouth sealed, the voice heard only as a muffled bar (the
//     cheeks puff) — or silence when voiceless;
//   - release: the lips pop open, a small labial burst;
//   - open: a brief labial vowel-like stretch (low F1 and F2, like [u]), with
//     turbulence at the flapping lips — the "brrr" buzz.
const LIP_TRILL = {
  place: 'bilabial',      // shapes the turbulence and the release pops
  hz: TRILL_HZ,
  formants: [300, 700, 2200],
  openFraction: 0.4,      // share of each cycle the lips are apart
  popDecaySeconds: 0.003, // how fast each release burst dies away
  popAttackSeconds: 0.0005,
};

// The velar trill [ʀ̟] is a shaded cell: the tongue body is too heavy for the
// airstream to set beating against the soft palate. If it could, it would beat
// like the lips do — whole closures, each released with a burst — but slower,
// for the mass, and the open phase would carry the velar pinch (F2 and F3
// close together).
const VELAR_TRILL = {
  place: 'velar',
  hz: 18.75,
  formants: [350, 1500, 2000],
  openFraction: 0.45,
  popDecaySeconds: 0.004,
  popAttackSeconds: 0.0005,
};

function renderClosingTrill(spec, variant, seed) {
  const voiced = variant !== 'vl';
  const lengthSeconds = ctx.length;
  const { place, hz, formants, openFraction, popDecaySeconds, popAttackSeconds } = spec;
  const openFormants = formantList(formants, 1.2);
  // Each strand is rendered steady, levelled on its own, then gated by the
  // articulator below; the glottal sources all start at phase 0, so they
  // pulse together.
  const renderStrand = (generator, levelDb) => normaliseRms(render(lengthSeconds, generator), levelDb, STEADY);

  const openTract = renderStrand(voiced ? voicedTract(openFormants) : whisperedTract(openFormants, seed), 0);
  const voiceBar = voiced ? renderStrand((() => {
    const folds = glottis({});
    const closedMouth = cascade([[200, 80], [600, 300]]);
    const muffle = lowpass(800);
    return () => muffle(closedMouth(folds().pulse));
  })(), -13) : null;
  const glottalFlow = voiced ? (() => {
    const folds = glottis({});
    return render(lengthSeconds, () => folds().flow);
  })() : null;
  const turbulence = renderStrand(noiseShaper(place, seed + 101), voiced ? -14 : -6);
  const releasePop = renderStrand((() => {
    const popNoise = noise(seed + 202);
    const popShape = parallel(BURST[place]);
    return () => popShape(popNoise());
  })(), voiced ? -3 : -1);

  const out = new Float32Array(openTract.length);
  for (let i = 0; i < out.length; i++) {
    const cyclePhase = (i * T * hz) % 1;
    const opening = cyclePhase < openFraction ? Math.sin(Math.PI * cyclePhase / openFraction) : 0;
    const secondsSinceRelease = cyclePhase / hz;
    const popEnvelope = Math.min(1, secondsSinceRelease / popAttackSeconds) * Math.exp(-secondsSinceRelease / popDecaySeconds);
    const turbulenceDrive = voiced ? 0.4 + 0.6 * glottalFlow[i] : 1;
    let sample = openTract[i] * opening
      + turbulence[i] * opening * turbulenceDrive
      + releasePop[i] * popEnvelope;
    if (voiceBar) sample += voiceBar[i] * (1 - opening);
    out[i] = sample;
  }
  return fadeIn(normaliseRms(out, voiced ? LEVEL.trill : LEVEL.whisper, STEADY));
}

function renderTrill(sym, variant, seed) {
  if (sym === 'ʙ') return renderClosingTrill(LIP_TRILL, variant, seed);
  const { f, depth } = TRILLS[sym];
  const fl = formantList(f);
  const base = variant === 'vl' ? whisperedTract(fl, seed) : voicedTract(fl);
  const buf = render(ctx.length, (i, t) => {
    // Brief closures (~35% of each cycle), smoothed so each beat is a dip,
    // not a click.
    const ph = (t * TRILL_HZ) % 1;
    const closed = ph < 0.35 ? Math.sin(Math.PI * ph / 0.35) : 0;
    return base() * (1 - depth * closed);
  });
  return fadeIn(normaliseRms(buf, variant === 'vl' ? LEVEL.whisper : LEVEL.trill, STEADY));
}

// --- Obstruents -------------------------------------------------------------------
//
// Place shapes the noise: the further forward the constriction, the smaller
// the cavity in front of it and the higher its resonance. Sibilants (s ʃ ʂ ɕ)
// are loud because the jet hits the teeth; non-sibilants (ɸ f θ) are weak and
// flat. Back fricatives take the shape of the vocal tract around them.
const FRICATIVE_NOISE = {
  bilabial: { peaks: [[1200, 1500, 1], [3000, 2500, 0.5]], level: -31 },
  labiodental: { peaks: [[4500, 4000, 1], [7000, 2000, 0.6]], hp: 1500, level: -30 },
  dental: { peaks: [[5000, 4000, 1], [7200, 2000, 0.5]], hp: 1800, level: -31 },
  alveolar: { peaks: [[6200, 1600, 1], [4500, 1500, 0.3]], hp: 3000, level: -20 },
  postalveolar: { peaks: [[2800, 900, 1], [4200, 1500, 0.6]], hp: 1600, level: -20 },
  retroflex: { peaks: [[2200, 700, 1], [3500, 1200, 0.6]], hp: 1300, level: -21 },
  alveolopalatal: { peaks: [[3600, 1300, 1], [5000, 1500, 0.5]], hp: 2000, level: -21 },
  palatal: { peaks: [[3600, 700, 1], [2500, 500, 0.4]], hp: 1800, level: -24 },
  velar: { peaks: [[1600, 500, 1], [2600, 800, 0.4]], hp: 900, level: -25 },
  uvular: { peaks: [[1100, 400, 1], [2200, 800, 0.4]], hp: 600, rough: 30, level: -25 },
  lateral: { peaks: [[3500, 1500, 1], [5500, 2000, 0.5]], hp: 1500, level: -23 },
  // Turbulence low in the throat excites the whole tract above it.
  pharyngeal: { tract: [800, 1200, 2500], level: -27 },
  epiglottal: { tract: [900, 1300, 2500], rough: 40, level: -26 },
  glottal: { tract: NEUTRAL, level: -28 },
  labialvelar: { tract: [300, 650, 2200], level: -28 },
};

// The shaded lateral cells: a column's own noise with the airstream split
// around a contact on the midline (lateralShaper). The pocket behind the
// contact is the side branch that makes [l] and [ɬ] lateral; its zero sits
// between the column's own peaks, where it can be heard.
const lateralOf = (place, zero) => ({ ...FRICATIVE_NOISE[place], lateral: zero });
Object.assign(FRICATIVE_NOISE, {
  bilabiallateral: lateralOf('bilabial', 2000),
  labiodentallateral: lateralOf('labiodental', 5800),
  pharyngeallateral: lateralOf('pharyngeal', 2200),
  glottallateral: lateralOf('glottal', 1000),
});

const FRICATIVES = {
  ɸ: 'bilabial', β: 'bilabial', f: 'labiodental', v: 'labiodental', θ: 'dental', ð: 'dental',
  s: 'alveolar', z: 'alveolar', ʃ: 'postalveolar', ʒ: 'postalveolar', ʂ: 'retroflex', ʐ: 'retroflex',
  ç: 'palatal', ʝ: 'palatal', x: 'velar', ɣ: 'velar', χ: 'uvular', ʁ: 'uvular',
  ħ: 'pharyngeal', ʕ: 'pharyngeal', h: 'glottal', ɦ: 'glottal', ɬ: 'lateral', ɮ: 'lateral',
  ʍ: 'labialvelar', ʜ: 'epiglottal', ʢ: 'epiglottal', ɕ: 'alveolopalatal', ʑ: 'alveolopalatal',
  ɧ: ['postalveolar', 'velar'],
  'ɸˡ': 'bilabiallateral', 'βˡ': 'bilabiallateral', 'fˡ': 'labiodentallateral', 'vˡ': 'labiodentallateral',
  'ħˡ': 'pharyngeallateral', 'ʕˡ': 'pharyngeallateral', 'hˡ': 'glottallateral', 'ɦˡ': 'glottallateral',
};

// Voiced fricatives low in the throat carry a full vowel-like tract, not just
// a voice bar: breathy-voiced [ɦ], the approximant-like [ʕ ʢ], and their
// shaded lateral cells.
const THROAT_VOICED = new Set(['ʕ', 'ʢ', 'ɦ', 'ʕˡ', 'ɦˡ']);

function noiseShaper(place, seed) {
  return shapeNoise(FRICATIVE_NOISE[place], seed);
}

function shapeNoise(spec, seed) {
  if (spec.lateral) return lateralShaper(spec, seed);
  const n = noise(seed);
  if (spec.tract) {
    const tract = cascade(formantList(spec.tract, 1.6));
    const hp = highpass(200);
    return () => tract(hp(n()) * 0.3);
  }
  const bank = parallel(spec.peaks);
  const hp = spec.hp ? highpass(spec.hp) : (x) => x;
  return () => hp(bank(n()));
}

// One jet down each side of the contact: two turbulent sources, the second
// tuned a little higher — no mouth is symmetric — through the pocket's zero.
function lateralShaper({ lateral, ...spec }, seed) {
  const higher = spec.tract
    ? { ...spec, tract: spec.tract.map((f) => f * 1.1) }
    : { ...spec, peaks: spec.peaks.map(([f, bw, g]) => [f * 1.1, bw, g]) };
  const left = shapeNoise(spec, seed);
  const right = shapeNoise(higher, seed + 7907);
  const pocket = antiresonator(lateral, 300);
  return () => pocket(0.7 * (left() + right()));
}

function renderFricative(sym, voiced, seed) {
  const places = [].concat(FRICATIVES[sym]);
  const shapers = places.map((p, k) => noiseShaper(p, seed + k * 7919));
  const spec = FRICATIVE_NOISE[places[0]];
  const level = Math.max(...places.map((p) => FRICATIVE_NOISE[p].level));
  const src = voiced ? glottis({}) : null;
  // A voiced fricative: the folds vibrate, so frication pulses with each
  // period, and the voice itself comes through as a low "voice bar".
  const bar = voiced ? cascade([[250, 80], [1000, 300]]) : null;
  const lp = lowpass(1200);
  const buf = render(ctx.length, (i, t) => {
    let fr = 0;
    for (const s of shapers) fr += s();
    let rough = 1;
    if (spec.rough) rough = 0.6 + 0.4 * Math.sin(2 * Math.PI * spec.rough * t);
    if (!src) return fr * rough;
    return fr * rough * (0.35 + 0.65 * src().flow);
  });
  normaliseRms(buf, voiced ? level + 1 : level, STEADY);
  if (voiced) {
    // The voice bar is mixed after normalising, at a level of its own, so a
    // weak fricative like [v] is not drowned by its own voicing.
    const g = glottis({});
    const vb = render(ctx.length, () => lp(bar(g().pulse)));
    const throat = THROAT_VOICED.has(sym);
    normaliseRms(vb, throat ? -18 : -24, STEADY);
    if (throat) {
      const tract = voicedTract(formantList(spec.tract, 1.3), { oq: sym[0] === 'ɦ' ? 0.85 : 0.5 });
      const pocket = spec.lateral ? antiresonator(spec.lateral, 300) : (x) => x;
      const v = render(ctx.length, () => pocket(tract()));
      normaliseRms(v, -20, STEADY);
      for (let i = 0; i < buf.length; i++) vb[i] += v[i];
    }
    for (let i = 0; i < buf.length; i++) buf[i] += vb[i];
  }
  return fadeIn(buf);
}

// Plosive bursts: the release transient, spectrally shaped by place —
// diffuse-low for labials, diffuse-high for alveolars, compact mid for velars.
const BURST = {
  bilabial: [[800, 1500, 1], [2500, 2000, 0.3]],
  alveolar: [[4000, 2500, 1], [5500, 2000, 0.6]],
  retroflex: [[2500, 1500, 1], [3500, 1500, 0.4]],
  palatal: [[3200, 1000, 1], [4500, 1500, 0.4]],
  velar: [[1800, 600, 1], [3000, 1000, 0.3]],
  uvular: [[1200, 500, 1], [2400, 1000, 0.3]],
  epiglottal: [[1000, 600, 1], [2400, 1200, 0.3]],
};
const PLOSIVES = {
  p: 'bilabial', b: 'bilabial', t: 'alveolar', d: 'alveolar', ʈ: 'retroflex', ɖ: 'retroflex',
  c: 'palatal', ɟ: 'palatal', k: 'velar', ɡ: 'velar', q: 'uvular', ɢ: 'uvular', ʡ: 'epiglottal',
};
const IMPLOSIVES = { ɓ: 'bilabial', ɗ: 'alveolar', ʄ: 'palatal', ɠ: 'velar', ʛ: 'uvular' };

// closure | burst | brief frication. A voiced stop keeps the folds going
// through the closure (the voice bar); an implosive's larynx drops during it,
// so its voicing swells instead of dying away. `held` voicing does not die
// away at all, and `rough` shudders it at that many Hz (the shaded [ʡ̬]).
function renderStop(place, { voiced, implosive = false, held = false, rough = 0, length, seed }) {
  const n = noise(seed);
  const bank = parallel(BURST[place]);
  const g = glottis({});
  const bar = cascade([[200, 80], [600, 300]]);
  const closure = length - 0.03;
  const buf = render(length, (i, t) => {
    let y = 0;
    let voice = voiced ? bar(g().pulse) : 0;
    if (rough) voice *= 0.6 + 0.4 * Math.sin(2 * Math.PI * rough * t);
    if (t < closure) {
      if (voiced) y = voice * (implosive ? 0.05 + 0.3 * (t / closure) : held ? 0.15 : 0.12 * (1 - 0.5 * t / closure));
    } else {
      const u = t - closure;
      // An implosive's burst is weak: air flows IN when it releases.
      const amp = (implosive ? 0.4 : 1) * Math.exp(-u / (u < 0.008 ? 0.004 : 0.012));
      y = amp * bank(n()) + (voiced ? 0.3 * voice : 0);
    }
    return y;
  });
  return normalisePeak(buf, -6);
}

// Taps and flaps: one ballistic contact — a closure too brief for a burst
// (~20 ms of voice bar), then the tongue is already away.
const TAPS = {
  ⱱ: [350, 1200, 2300], ɾ: [350, 1700, 2600], ɽ: [350, 1500, 1800], ɺ: [360, 1500, 2600],
  // Shaded cells: the tongue body flicked at the soft palate the way a tip
  // flicks the ridge (with the velar pinch, F2 and F3 together), and the
  // folds snapping shut for an instant in a tract with nothing closed above
  // them — a dip so deep it clips to a moment of silence (TAP_DEPTH).
  'ɡ̆': [300, 1700, 2100], 'ʔ̆': NEUTRAL,
};
const TAP_DEPTH = { 'ʔ̆': 1.6 };

function renderTap(sym) {
  const tract = voicedTract(formantList(TAPS[sym]));
  const depth = TAP_DEPTH[sym] ?? 0.85;
  const len = ONESHOT_LENGTH.tap;
  const buf = render(len, (i, t) => {
    const ph = t / len;
    // Voiced throughout, with a smooth dip for the contact.
    return tract() * Math.max(0, 1 - depth * Math.sin(Math.PI * Math.min(1, ph * 1.2)));
  });
  return normalisePeak(buf, -10);
}

// Clicks: a velaric ingressive pop. The tongue seals front and back, the
// pocket between is rarefied, and the front release snaps. Bilabial is a soft
// lip smack, dental/lateral are noisy and affricated, postalveolar and palatal
// are sharp resonant pops.
const CLICKS = {
  ʘ: { ring: [900, 600], noise: [[1200, 1500, 1]], dur: 0.012, pop: 0.6, level: -12 },
  ǀ: { noise: [[4500, 3000, 1], [3000, 1500, 0.4]], dur: 0.03, pop: 0, level: -10 },
  ǃ: { ring: [1800, 150], noise: [[2000, 800, 0.3]], dur: 0.006, pop: 1, level: -3 },
  ǂ: { ring: [3000, 300], noise: [[3200, 1200, 0.5]], dur: 0.008, pop: 1, level: -5 },
  ǁ: { noise: [[2500, 2000, 1], [4000, 1500, 0.5]], dur: 0.04, pop: 0, level: -9 },
};

function renderClick(sym, seed) {
  const c = CLICKS[sym];
  const n = noise(seed);
  const bank = parallel(c.noise);
  const ring = c.ring ? resonator(c.ring[0], c.ring[1]) : null;
  const len = ONESHOT_LENGTH.click;
  const at = 0.02;
  const buf = render(len, (i, t) => {
    if (t < at) return 0;
    const u = t - at;
    const impulse = i === Math.round(at * SR) ? c.pop * 40 : 0;
    const fr = u < c.dur ? bank(n()) * (1 - u / c.dur) : 0;
    return (ring ? ring(impulse) : impulse * 0.01) + fr;
  });
  return normalisePeak(buf, c.level);
}

// --- The chart's shaded cells -----------------------------------------------------
//
// Articulations the IPA judges impossible (ipa-core.js's IMPOSSIBLE). No one
// has ever made them, so there is nothing to measure: each is the
// synthesizer's own rules carried past the point where anatomy stops them —
// its row's manner, tuned to its column the way the possible sounds of that
// column are tuned, and sounding where a real throat would fall silent. The
// taps, lateral fricatives and approximants fit the tables above; these need
// a renderer of their own.

// [ʡ̬]: a closure just above the glottis leaves no room for the air that
// voicing needs, so in a real throat the voice stops the moment it closes.
// Here it holds through the closure, shuddering with the 40 Hz flutter of the
// aryepiglottic folds that [ʜ ʢ] have.
function renderVoicedPharyngealStop(variant, seed) {
  return renderStop('epiglottal', {
    voiced: true, held: true, rough: FRICATIVE_NOISE.epiglottal.rough, length: ONESHOT_LENGTH.plosive, seed,
  });
}

// [ʔ̬]: a glottal stop is the folds held shut, which is just what stops them
// buzzing. Here they buzz anyway, pressed tight — brief open phases, every
// other pulse weak — and with nothing closed above them it comes out of the
// open, unconstricted mouth, quietly. The release is the folds letting go
// into full voice: no burst, since no air is trapped above them, only a hard
// onset.
function renderVoicedGlottalStop() {
  const len = ONESHOT_LENGTH.plosive;
  const closure = len - 0.03;
  const fl = formantList(NEUTRAL);
  const pressed = voicedTract(fl, { oq: 0.25, alternate: 0.6 });
  const modal = voicedTract(fl);
  const buf = render(len, (i, t) => {
    const p = pressed(), m = modal();
    if (t < closure) return 0.2 * p;
    return m * Math.exp(-(t - closure) / 0.02);
  });
  return normalisePeak(buf, -6);
}

// [ʡ̃]: a nasal needs air through the nose, and a pharyngeal closure is below
// the velic port, so none can reach it. Let the voice through anyway, the way
// a voice bar gets through a stop's closure — muffled, through the throat's
// walls. Above the closure the nose and the mouth both lie open to it, so the
// murmur carries the nasal pole and the pharynx's own high F1 and low F2.
function renderPharyngealNasal(variant, seed) {
  const fl = [[250, 80], [750, 150], [1200, 200], [2500, 250], ...HIGHER];
  const src = variant === 'vl' ? (() => { const n = noise(seed); return () => 0.3 * n(); })()
    : (() => { const g = glottis({}); return () => g().pulse; })();
  const throat = lowpass(900);
  const tract = cascade(fl);
  const lp = lowpass(2500);
  const buf = render(ctx.length, () => lp(tract(throat(src()))));
  return fadeIn(normaliseRms(buf, variant === 'vl' ? LEVEL.whisper : LEVEL.nasal, STEADY));
}

// [ʔ̃]: shut at the glottis there is no voice — the closure is the folds that
// would make it. Here they buzz pressed shut, as in [ʔ̬], and with nothing
// closed above them there is no oral antiresonance to name a place: the whole
// unconstricted tract and the nose ring together, a dark nasal murmur.
function renderGlottalNasal(variant, seed) {
  const fl = formantList(NEUTRAL, 1.4);
  const nasal = { pole: 270, zero: 600 };
  let gen;
  if (variant === 'vl') {
    const w = whisperedTract(fl, seed);
    const pole = resonator(nasal.pole, 100), zero = antiresonator(nasal.zero, 100);
    gen = () => zero(pole(w()));
  } else gen = voicedTract(fl, { oq: 0.3, alternate: 0.5, nasal });
  const lp = lowpass(2500);
  const buf = render(ctx.length, () => lp(gen()));
  return fadeIn(normaliseRms(buf, variant === 'vl' ? LEVEL.whisper : LEVEL.nasal, STEADY));
}

// [ʢ̠]: a glottal trill would need the folds to beat as an articulator while
// they buzz as the voice. Here the voice itself is switched off and on by
// whole glottal closures, TRILL_HZ times a second, each opening a hard onset
// like a glottal stop's release, into a tract with no constriction — so the
// tract rings on briefly after each closure, as it would. Voiceless, the
// bursts are breath.
function renderGlottalTrill(variant, seed) {
  const voiced = variant !== 'vl';
  const src = voiced ? glottis({ oq: 0.45 }) : null;
  const breath = voiced ? null : noise(seed);
  const hp = highpass(300);
  const tract = cascade(formantList(NEUTRAL));
  const open = 0.55;
  const buf = render(ctx.length, (i, t) => {
    const ph = (t * TRILL_HZ) % 1;
    const x = voiced ? src().pulse : 0.3 * hp(breath());
    const gate = ph < open ? Math.min(1, ph / 0.02, (open - ph) / 0.05) : 0;
    return tract(x * gate);
  });
  return fadeIn(normaliseRms(buf, voiced ? LEVEL.trill : LEVEL.whisper, STEADY));
}

const SHADED = {
  'ʡ̬': renderVoicedPharyngealStop,
  'ʔ̬': renderVoicedGlottalStop,
  'ʡ̃': renderPharyngealNasal,
  'ʔ̃': renderGlottalNasal,
  'ʀ̟': (variant, seed) => renderClosingTrill(VELAR_TRILL, variant, seed),
  'ʢ̠': renderGlottalTrill,
};

// --- Driver -----------------------------------------------------------------------

// A contour of F0 values spread evenly over `length` seconds → f0(t).
function contour(points, length) {
  const pts = [].concat(points).map(Number);
  if (pts.length === 1) return () => pts[0];
  return (t) => {
    const x = Math.max(0, Math.min(1, t / length)) * (pts.length - 1);
    const k = Math.min(pts.length - 2, Math.floor(x));
    return pts[k] + (pts[k + 1] - pts[k]) * (x - k);
  };
}

// Render one sound.
//   renderSound(sym, variant)                  — the file version: F0 125 Hz,
//                                                loopable, SUSTAINED_LENGTH long
//   renderSound(sym, variant, { f0, length })  — sung: F0 in Hz (a number, or
//                                                a contour array spread across
//                                                the sound), `length` seconds
//                                                for a sustained class; one-shot
//                                                classes keep their own length
// The second form is what ipa-voice.js uses when a word carries a note: the
// source runs at the note's pitch while the formants stay where the vowel
// puts them, which no amount of resampling a file could do.
export function renderSound(sym, variant = null, { f0 = null, length = null } = {}) {
  const entry = SOUNDING.find((s) => s.sym === sym);
  if (!entry) throw new Error(`no sound for ${sym}`);
  if (f0 == null) {
    ctx = { f0: () => F0, length: SUSTAINED_LENGTH };
    const buf = renderRaw(entry, variant);
    return isSustained(entry.cls) ? crossfadeLoop(buf) : buf;
  }
  const want = Math.max(0.01, length ?? SUSTAINED_LENGTH);
  // Rendered to at least the steady stretch, so the level is measured the same
  // way as the files', then cut to the length asked for.
  const len = Math.max(want, SUSTAINED_LENGTH);
  ctx = { f0: contour(f0, want), length: len };
  try {
    const buf = renderRaw(entry, variant);
    return isSustained(entry.cls) ? buf.slice(0, Math.round(want * SR)) : buf;
  } finally {
    ctx = { f0: () => F0, length: SUSTAINED_LENGTH };
  }
}

function renderRaw(entry, variant) {
  const { sym } = entry;
  const seed = [...sym].reduce((s, c) => s * 31 + c.codePointAt(0), 0) * 31 + (variant ? variant.charCodeAt(0) : 0);
  if (SHADED[sym]) return SHADED[sym](variant, seed);
  switch (entry.cls) {
    case 'vowel': return renderVowel(sym, variant, seed);
    case 'nasal': return renderNasal(sym, variant, seed);
    case 'trill': return renderTrill(sym, variant, seed);
    case 'approximant': return renderApproximant(sym, variant, seed);
    case 'fricative': return renderFricative(sym, entry.voiced, seed);
    case 'plosive': return renderStop(PLOSIVES[sym], { voiced: entry.voiced, length: ONESHOT_LENGTH.plosive, seed });
    case 'implosive': return renderStop(IMPLOSIVES[sym], { voiced: true, implosive: true, length: ONESHOT_LENGTH.implosive, seed });
    case 'tap': return renderTap(sym);
    case 'click': return renderClick(sym, seed);
    default: throw new Error(`unhandled class ${entry.cls}`);
  }
}

// Every (symbol, variant) pair that gets a file.
export function soundList() {
  const list = [];
  for (const { sym, cls } of SOUNDING) {
    list.push([sym, null]);
    for (const v of VARIANTS[cls] || []) list.push([sym, v]);
  }
  return list;
}
