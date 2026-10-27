// ipa-core.js
// The International Phonetic Alphabet, as data, plus the pure half of making
// it audible: parse an IPA string into segments and lay them out on a time
// line. No DOM, no Web Audio — runs identically in the browser bundle and
// under node:test (test/ipa-core.test.js). Readers:
//   - on-screen-keyboard.js — the IPA keyboard pages (IPA_PAGES)
//   - scripts/ipa-synth.mjs — renders one audio file per sound (soundFile)
//   - ipa-voice.js          — plays planIpa()'s time line when a word lands
//
// --- Why synthesized sounds, not a browser voice -----------------------------
//
// The Web Speech API has no phoneme input (SSML <phoneme> is ignored by every
// shipping voice), and spelling IPA out in English would make it pointless —
// [x] or [ʁ] or [ɬ] have no English spelling. So every sound here is rendered
// from its articulatory description (scripts/ipa-synth.mjs) into its own file,
// and an IPA word is played by sequencing those files, with length, stress,
// tone and the audible diacritics applied at playback.

// [symbol, name, class, voiced]. `class` decides how a sound is rendered and
// timed; 'mark' is anything that modifies a neighbour instead of sounding.
const VOWELS = [
  ['i', 'close front unrounded vowel'],
  ['y', 'close front rounded vowel'],
  ['ɨ', 'close central unrounded vowel'],
  ['ʉ', 'close central rounded vowel'],
  ['ɯ', 'close back unrounded vowel'],
  ['u', 'close back rounded vowel'],
  ['ɪ', 'near-close front unrounded vowel'],
  ['ʏ', 'near-close front rounded vowel'],
  ['ʊ', 'near-close back rounded vowel'],
  ['e', 'close-mid front unrounded vowel'],
  ['ø', 'close-mid front rounded vowel'],
  ['ɘ', 'close-mid central unrounded vowel'],
  ['ɵ', 'close-mid central rounded vowel'],
  ['ɤ', 'close-mid back unrounded vowel'],
  ['o', 'close-mid back rounded vowel'],
  ['ə', 'mid central vowel (schwa)'],
  ['ɚ', 'r-coloured mid central vowel'],
  ['ɛ', 'open-mid front unrounded vowel'],
  ['œ', 'open-mid front rounded vowel'],
  ['ɜ', 'open-mid central unrounded vowel'],
  ['ɝ', 'r-coloured open-mid central vowel'],
  ['ɞ', 'open-mid central rounded vowel'],
  ['ʌ', 'open-mid back unrounded vowel'],
  ['ɔ', 'open-mid back rounded vowel'],
  ['æ', 'near-open front unrounded vowel'],
  ['ɐ', 'near-open central vowel'],
  ['a', 'open front unrounded vowel'],
  ['ɶ', 'open front rounded vowel'],
  ['ɑ', 'open back unrounded vowel'],
  ['ɒ', 'open back rounded vowel'],
].map(([s, n]) => [s, n, 'vowel', true]);

const CONSONANTS = [
  ['p', 'voiceless bilabial plosive', 'plosive', false],
  ['b', 'voiced bilabial plosive', 'plosive', true],
  ['t', 'voiceless alveolar plosive', 'plosive', false],
  ['d', 'voiced alveolar plosive', 'plosive', true],
  ['ʈ', 'voiceless retroflex plosive', 'plosive', false],
  ['ɖ', 'voiced retroflex plosive', 'plosive', true],
  ['c', 'voiceless palatal plosive', 'plosive', false],
  ['ɟ', 'voiced palatal plosive', 'plosive', true],
  ['k', 'voiceless velar plosive', 'plosive', false],
  ['ɡ', 'voiced velar plosive', 'plosive', true],
  ['q', 'voiceless uvular plosive', 'plosive', false],
  ['ɢ', 'voiced uvular plosive', 'plosive', true],
  ['ʔ', 'glottal stop', 'plosive', false],
  ['m', 'bilabial nasal', 'nasal', true],
  ['ɱ', 'labiodental nasal', 'nasal', true],
  ['n', 'alveolar nasal', 'nasal', true],
  ['ɳ', 'retroflex nasal', 'nasal', true],
  ['ɲ', 'palatal nasal', 'nasal', true],
  ['ŋ', 'velar nasal', 'nasal', true],
  ['ɴ', 'uvular nasal', 'nasal', true],
  ['ʙ', 'bilabial trill', 'trill', true],
  ['r', 'alveolar trill', 'trill', true],
  ['ʀ', 'uvular trill', 'trill', true],
  ['ⱱ', 'labiodental flap', 'tap', true],
  ['ɾ', 'alveolar tap', 'tap', true],
  ['ɽ', 'retroflex flap', 'tap', true],
  ['ɸ', 'voiceless bilabial fricative', 'fricative', false],
  ['β', 'voiced bilabial fricative', 'fricative', true],
  ['f', 'voiceless labiodental fricative', 'fricative', false],
  ['v', 'voiced labiodental fricative', 'fricative', true],
  ['θ', 'voiceless dental fricative', 'fricative', false],
  ['ð', 'voiced dental fricative', 'fricative', true],
  ['s', 'voiceless alveolar fricative', 'fricative', false],
  ['z', 'voiced alveolar fricative', 'fricative', true],
  ['ʃ', 'voiceless postalveolar fricative', 'fricative', false],
  ['ʒ', 'voiced postalveolar fricative', 'fricative', true],
  ['ʂ', 'voiceless retroflex fricative', 'fricative', false],
  ['ʐ', 'voiced retroflex fricative', 'fricative', true],
  ['ç', 'voiceless palatal fricative', 'fricative', false],
  ['ʝ', 'voiced palatal fricative', 'fricative', true],
  ['x', 'voiceless velar fricative', 'fricative', false],
  ['ɣ', 'voiced velar fricative', 'fricative', true],
  ['χ', 'voiceless uvular fricative', 'fricative', false],
  ['ʁ', 'voiced uvular fricative', 'fricative', true],
  ['ħ', 'voiceless pharyngeal fricative', 'fricative', false],
  ['ʕ', 'voiced pharyngeal fricative', 'fricative', true],
  ['h', 'voiceless glottal fricative', 'fricative', false],
  ['ɦ', 'voiced glottal fricative', 'fricative', true],
  ['ɬ', 'voiceless alveolar lateral fricative', 'fricative', false],
  ['ɮ', 'voiced alveolar lateral fricative', 'fricative', true],
  ['ʋ', 'labiodental approximant', 'approximant', true],
  ['ɹ', 'alveolar approximant', 'approximant', true],
  ['ɻ', 'retroflex approximant', 'approximant', true],
  ['j', 'palatal approximant', 'approximant', true],
  ['ɰ', 'velar approximant', 'approximant', true],
  ['l', 'alveolar lateral approximant', 'approximant', true],
  ['ɭ', 'retroflex lateral approximant', 'approximant', true],
  ['ʎ', 'palatal lateral approximant', 'approximant', true],
  ['ʟ', 'velar lateral approximant', 'approximant', true],
  ['ɫ', 'velarized alveolar lateral approximant', 'approximant', true],
];

const OTHER_CONSONANTS = [
  ['ʍ', 'voiceless labial-velar fricative', 'fricative', false],
  ['w', 'voiced labial-velar approximant', 'approximant', true],
  ['ɥ', 'voiced labial-palatal approximant', 'approximant', true],
  ['ʜ', 'voiceless epiglottal fricative', 'fricative', false],
  ['ʢ', 'voiced epiglottal fricative', 'fricative', true],
  ['ʡ', 'epiglottal plosive', 'plosive', false],
  ['ɕ', 'voiceless alveolo-palatal fricative', 'fricative', false],
  ['ʑ', 'voiced alveolo-palatal fricative', 'fricative', true],
  ['ɺ', 'alveolar lateral flap', 'tap', true],
  ['ɧ', 'simultaneous ʃ and x', 'fricative', false],
  ['ʘ', 'bilabial click', 'click', false],
  ['ǀ', 'dental click', 'click', false],
  ['ǃ', 'postalveolar click', 'click', false],
  ['ǂ', 'palatoalveolar click', 'click', false],
  ['ǁ', 'alveolar lateral click', 'click', false],
  ['ɓ', 'bilabial implosive', 'implosive', true],
  ['ɗ', 'dental/alveolar implosive', 'implosive', true],
  ['ʄ', 'palatal implosive', 'implosive', true],
  ['ɠ', 'velar implosive', 'implosive', true],
  ['ʛ', 'uvular implosive', 'implosive', true],
  ['ʼ', 'ejective', 'mark', false],
];

// Combining marks are typed alone and land on whatever precedes the caret.
const DIACRITICS = [
  ['̥', 'voiceless (below)'],
  ['̊', 'voiceless (above)'],
  ['̬', 'voiced'],
  ['ʰ', 'aspirated'],
  ['̹', 'more rounded'],
  ['̜', 'less rounded'],
  ['̟', 'advanced'],
  ['̠', 'retracted'],
  ['̈', 'centralized'],
  ['̽', 'mid-centralized'],
  ['̩', 'syllabic'],
  ['̯', 'non-syllabic'],
  ['˞', 'rhoticity'],
  ['̤', 'breathy voiced'],
  ['̰', 'creaky voiced'],
  ['̼', 'linguolabial'],
  ['ʷ', 'labialized'],
  ['ʲ', 'palatalized'],
  ['ˠ', 'velarized'],
  ['ˤ', 'pharyngealized'],
  ['̴', 'velarized or pharyngealized'],
  ['̝', 'raised'],
  ['̞', 'lowered'],
  ['̘', 'advanced tongue root'],
  ['̙', 'retracted tongue root'],
  ['̪', 'dental'],
  ['̺', 'apical'],
  ['̻', 'laminal'],
  ['̃', 'nasalized'],
  ['ⁿ', 'nasal release'],
  ['ˡ', 'lateral release'],
  ['̚', 'no audible release'],
  ['͡', 'tie bar (above)'],
  ['͜', 'tie bar (below)'],
].map(([s, n]) => [s, n, 'mark', false]);

const SUPRASEGMENTALS = [
  ['ˈ', 'primary stress'],
  ['ˌ', 'secondary stress'],
  ['ː', 'long'],
  ['ˑ', 'half-long'],
  ['̆', 'extra-short'],
  ['|', 'minor (foot) group'],
  ['‖', 'major (intonation) group'],
  ['.', 'syllable break'],
  ['‿', 'linking (absence of a break)'],
  ['̋', 'extra-high tone'],
  ['́', 'high tone'],
  ['̄', 'mid tone'],
  ['̀', 'low tone'],
  ['̏', 'extra-low tone'],
  ['̌', 'rising tone'],
  ['̂', 'falling tone'],
  ['᷄', 'high rising tone'],
  ['᷅', 'low rising tone'],
  ['᷈', 'rising-falling tone'],
  ['˥', 'extra-high tone letter'],
  ['˦', 'high tone letter'],
  ['˧', 'mid tone letter'],
  ['˨', 'low tone letter'],
  ['˩', 'extra-low tone letter'],
  ['ꜛ', 'upstep'],
  ['ꜜ', 'downstep'],
  ['↗', 'global rise'],
  ['↘', 'global fall'],
].map(([s, n]) => [s, n, 'mark', false]);

// The pulmonic chart's shaded cells: articulations the IPA judges impossible,
// so they have no letters. Each is written the way the IPA writes any sound
// it has no letter for — the nearest letter plus the diacritic that moves it
// there, the idiom of [ɢ̆] for a uvular tap or [β̞] for a bilabial approximant:
//   voiced stops    ʡ̬ ʔ̬      ̬ voices the column's voiceless stop
//   nasals          ʡ̃ ʔ̃      a nasalized stop is a nasal stop ([b̃] is [m])
//   trills          ʀ̟ ʢ̠      the nearest trill moved one column (̟ forward, ̠ back)
//   taps            ɡ̆ ʔ̆      an extra-short stop is a tap
//   approximant     ɦ̞        ̞ lowers a fricative to an approximant
//   laterals        ɸˡ … ɦ̞ˡ  the column's fricative or approximant, made lateral
// parseIpa reads each as one sound, ahead of what its marks mean elsewhere.
const IMPOSSIBLE = [
  ['ʡ̬', 'voiced pharyngeal plosive', 'plosive', true],
  ['ʔ̬', 'voiced glottal plosive', 'plosive', true],
  ['ʡ̃', 'pharyngeal nasal', 'nasal', true],
  ['ʔ̃', 'glottal nasal', 'nasal', true],
  ['ʀ̟', 'velar trill', 'trill', true],
  ['ʢ̠', 'glottal trill', 'trill', true],
  ['ɡ̆', 'velar tap', 'tap', true],
  ['ʔ̆', 'glottal tap', 'tap', true],
  ['ɸˡ', 'voiceless bilabial lateral fricative', 'fricative', false],
  ['βˡ', 'voiced bilabial lateral fricative', 'fricative', true],
  ['fˡ', 'voiceless labiodental lateral fricative', 'fricative', false],
  ['vˡ', 'voiced labiodental lateral fricative', 'fricative', true],
  ['ħˡ', 'voiceless pharyngeal lateral fricative', 'fricative', false],
  ['ʕˡ', 'voiced pharyngeal lateral fricative', 'fricative', true],
  ['hˡ', 'voiceless glottal lateral fricative', 'fricative', false],
  ['ɦˡ', 'voiced glottal lateral fricative', 'fricative', true],
  ['ɦ̞', 'glottal approximant', 'approximant', true],
  ['β̞ˡ', 'bilabial lateral approximant', 'approximant', true],
  ['ʋˡ', 'labiodental lateral approximant', 'approximant', true],
  ['ʕ̞ˡ', 'pharyngeal lateral approximant', 'approximant', true],
  ['ɦ̞ˡ', 'glottal lateral approximant', 'approximant', true],
];

const entry = ([sym, name, cls, voiced]) => Object.freeze({ sym, name, cls, voiced });

// The chart's pages, in chart order: one symbol per key, so one key press
// inserts one symbol.
export const IPA_GROUPS = Object.freeze([
  { id: 'vowels', label: 'Vowels', symbols: VOWELS.map(entry) },
  { id: 'consonants', label: 'Consonants', symbols: CONSONANTS.map(entry) },
  { id: 'other', label: 'Other', symbols: OTHER_CONSONANTS.map(entry) },
  { id: 'diacritics', label: 'Diacritics', symbols: DIACRITICS.map(entry) },
  { id: 'prosody', label: 'Stress & tone', symbols: SUPRASEGMENTALS.map(entry) },
].map(Object.freeze));

export const IMPOSSIBLE_GROUP = Object.freeze({
  id: 'impossible', label: 'Impossible', impossible: true, symbols: Object.freeze(IMPOSSIBLE.map(entry)),
});

// The keyboard's pages: the chart, then its shaded cells. Each is one tab of
// the IPA layout.
export const IPA_PAGES = Object.freeze([...IPA_GROUPS, IMPOSSIBLE_GROUP]);

// symbol → entry, across every chart group.
export const IPA_SYMBOLS = new Map(
  IPA_GROUPS.flatMap((g) => g.symbols.map((s) => [s.sym, s])),
);

// notation → entry, for the shaded cells.
export const IMPOSSIBLE_SYMBOLS = new Map(IMPOSSIBLE_GROUP.symbols.map((s) => [s.sym, s]));

// Every symbol that makes a sound of its own, i.e. gets an audio file.
export const SOUNDING = [
  ...[...IPA_SYMBOLS.values()].filter((s) => s.cls !== 'mark' && s.sym !== 'ʔ'),
  ...IMPOSSIBLE_GROUP.symbols,
];

// A combining mark has nothing to sit on alone, so a key label shows it on a
// dotted circle the way the IPA chart prints it.
export function isCombining(sym) {
  return /^\p{M}$/u.test(sym);
}

export function ipaKeyLabel(sym) {
  return isCombining(sym) ? `◌${sym}` : sym;
}

// --- Recognising IPA -----------------------------------------------------------
//
// Plain ASCII is the IPA too ("bed" is a valid transcription), and several IPA
// letters are ordinary letters elsewhere (ç, æ, ø, ð, θ, β, χ…), so a word is
// only treated as IPA if it has a symbol no common orthography writes, or is
// wrapped the way a transcription is: /phonemic/ or [phonetic]. Combining
// marks never count on their own — "café" is French, not a high tone.
const ORTHOGRAPHIC = new Set(['ç', 'æ', 'œ', 'ø', 'ð', 'θ', 'β', 'χ', 'ħ', 'ʼ', '|', '.', '↗', '↘']);
const IPA_ONLY = new Set([...IPA_SYMBOLS.keys()].filter(
  (s) => /[^\x00-\x7F]/.test(s) && !ORTHOGRAPHIC.has(s) && !isCombining(s),
));
const WRAPPED_RE = /^\s*(?:\/[^/]+\/|\[[^\]]+\])\s*$/;

export function containsIpa(text) {
  const s = String(text ?? '');
  if (WRAPPED_RE.test(s)) return true;
  for (const ch of s) if (IPA_ONLY.has(ch)) return true;
  return false;
}

// --- Audio files ---------------------------------------------------------------
//
// One file per sounding symbol, named by code point so the name is ASCII and
// unambiguous ("ɡ" is U+0261, not the "g" on a keyboard); a shaded cell's
// notation is several code points, joined by "-". A few classes also
// get phonation variants, because voicelessness, breathiness, creak and
// nasality change the source or add a resonance, which cannot be faked by
// filtering a finished file.
export const VARIANTS = Object.freeze({
  vowel: ['nas', 'vl', 'br', 'cr'],
  nasal: ['vl'],
  approximant: ['vl'],
  trill: ['vl'],
});

export function soundFile(sym, variant = null) {
  const hex = [...sym].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('-');
  return `ipa-${hex}${variant ? `-${variant}` : ''}.wav`;
}

// Sustained sounds are rendered short and LOOPED over a steady stretch, so a
// long vowel costs no more file than a short one. The loop (2560 samples) is a
// whole number of glottal periods (F0 = 125 Hz at 16 kHz is exactly 128
// samples), of creaky voice's two-pulse cycle (512) and of trill beats (25 Hz,
// 640; the velar trill's slower 18.75 Hz fits three to the loop), so periodic
// sounds loop seamlessly; noise is crossfaded at the seam.
export const SAMPLE_RATE = 16000;
export const F0 = 125;
export const LOOP = Object.freeze({ start: 0.08, end: 0.24 });
export const SUSTAINED_LENGTH = 0.26;
const SUSTAINED = new Set(['vowel', 'nasal', 'trill', 'fricative', 'approximant']);

export function isSustained(cls) {
  return SUSTAINED.has(cls);
}

// --- Parsing -------------------------------------------------------------------

// Spellings people actually type for IPA characters they cannot reach.
const ASCII_STANDINS = { g: 'ɡ', ':': 'ː', "'": 'ˈ' };

const TONE_LEVEL = { '˥': 5, '˦': 4, '˧': 3, '˨': 2, '˩': 1 };
// Combining tone marks → the levels they pass through.
const TONE_MARK = {
  '̋': [5], '́': [4], '̄': [3], '̀': [2], '̏': [1],
  '̌': [2, 4], '̂': [4, 2], '᷄': [3, 4], '᷅': [2, 3], '᷈': [2, 4, 2],
};
// Pauses: [seconds, quantize slots]. Under quantize() a pause is counted in
// the same beat grid as the sounds — a word gap or minor group is one slot, a
// major group two; a syllable break only separates, it takes no time.
const BREAKS = { ' ': [0.12, 1], '.': [0.03, 0], '|': [0.25, 1], '‖': [0.5, 2] };
const STRESS = { 'ˈ': 2, 'ˌ': 1 };
const LENGTH = { 'ː': 1.8, 'ˑ': 1.4, '̆': 0.55 };
// The same marks as multiples of a quantize() slot: long is two, half-long one
// and a half, extra-short half — the grid's own arithmetic, not speech timing.
const LENGTH_SLOTS = { 'ː': 2, 'ˑ': 1.5, '̆': 0.5 };
const TIES = new Set(['͡', '͜']);

// Normalise to one code point per mark, then glue the cedilla back: NFD would
// split ç — an IPA letter in its own right — into c plus a mark.
function normalise(text) {
  return String(text ?? '')
    .replace(/^\s*[/[]|[/\]]\s*$/g, '')
    .normalize('NFD')
    .replace(/ç/g, 'ç');
}

// The shaded cells' notations by their letter, the most specific first, so
// [ɦ̞ˡ] wins over [ɦ̞] and [ɦˡ].
const IMPOSSIBLE_BY_LETTER = new Map();
for (const { sym } of IMPOSSIBLE_GROUP.symbols) {
  const [letter, ...rest] = [...sym];
  const lateral = rest[rest.length - 1] === 'ˡ';
  const marks = lateral ? rest.slice(0, -1) : rest;
  if (!IMPOSSIBLE_BY_LETTER.has(letter)) IMPOSSIBLE_BY_LETTER.set(letter, []);
  IMPOSSIBLE_BY_LETTER.get(letter).push({ sym, marks, lateral });
}
for (const list of IMPOSSIBLE_BY_LETTER.values()) {
  list.sort((a, b) => b.marks.length + b.lateral - (a.marks.length + a.lateral));
}

// A shaded cell's notation at chars[i], if there is one. Marks come in any
// order (NFD sorts them), so it matches when its marks are among those on the
// letter; the rest stay marks on the sound. ˡ follows the letter's marks.
function matchImpossible(chars, i) {
  const candidates = IMPOSSIBLE_BY_LETTER.get(chars[i]);
  if (!candidates) return null;
  let j = i + 1;
  while (j < chars.length && isCombining(chars[j])) j++;
  const lateral = chars[j] === 'ˡ';
  let k = j + 1;
  while (lateral && k < chars.length && isCombining(chars[k])) k++;
  for (const c of candidates) {
    if (c.lateral && !lateral) continue;
    const rest = chars.slice(i + 1, j);
    const found = c.marks.every((m) => {
      const at = rest.indexOf(m);
      if (at !== -1) rest.splice(at, 1);
      return at !== -1;
    });
    if (!found) continue;
    return c.lateral
      ? { sym: c.sym, rest: [...rest, ...chars.slice(j + 1, k)], end: k }
      : { sym: c.sym, rest, end: j };
  }
  return null;
}

// Text → one token per symbol: a character, or a shaded cell's whole notation
// followed by any marks it did not use.
function tokens(text) {
  const chars = [...normalise(text)].map((ch) => ASCII_STANDINS[ch] ?? ch);
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const m = matchImpossible(chars, i);
    if (!m) { out.push(chars[i]); continue; }
    out.push(m.sym, ...m.rest);
    i = m.end - 1;
  }
  return out;
}

// IPA text → an array of segments and breaks:
//   { sym, cls, voiced, mods: Set, length, slots, stress, tones: [levels], tieNext }
//   { brk: seconds, slots }
// Unknown characters (digits, Latin letters the IPA does not use) are skipped.
export function parseIpa(text) {
  const out = [];
  let pendingStress = 0;
  let pendingStep = 0; // ꜛ / ꜜ, applied from the next segment on
  let glide = 0;       // ↗ / ↘, applied across the rest of the utterance
  const last = () => {
    for (let i = out.length - 1; i >= 0; i--) if (out[i].sym) return out[i];
    return null;
  };
  const lastVowel = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].brk != null) return null;
      if (out[i].cls === 'vowel' || out[i].mods?.has('syllabic')) return out[i];
    }
    return null;
  };

  for (let ch of tokens(text)) {
    if (/\s/.test(ch)) ch = ' ';
    const prev = last();

    if (ch in BREAKS) {
      // Collapse runs (two spaces are one pause), and never open with one.
      const tail = out[out.length - 1];
      if (!tail) continue;
      const [secs, slots] = BREAKS[ch];
      if (tail.brk != null) { tail.brk = Math.max(tail.brk, secs); tail.slots = Math.max(tail.slots, slots); }
      else out.push({ brk: secs, slots });
      continue;
    }
    if (ch === '‿') {
      if (out[out.length - 1]?.brk != null) out.pop();
      continue;
    }
    if (ch in STRESS) { pendingStress = Math.max(pendingStress, STRESS[ch]); continue; }
    if (ch === 'ꜛ') { pendingStep += 1; continue; }
    if (ch === 'ꜜ') { pendingStep -= 1; continue; }
    if (ch === '↗') { glide = 1; continue; }
    if (ch === '↘') { glide = -1; continue; }
    if (ch === 'ʔ') {
      // A glottal stop is silence — closure, no release — so it is a break
      // the length of a stop closure rather than a file.
      out.push({ brk: 0.07, slots: 1, glottal: true });
      continue;
    }
    if (ch in TONE_LEVEL) {
      // Chao tone letters FOLLOW their syllable; a run of them is a contour.
      const v = lastVowel();
      if (v) {
        if (!v.toneLetters) { v.toneLetters = true; v.tones = []; }
        v.tones.push(TONE_LEVEL[ch]);
      }
      continue;
    }
    if (prev && ch in TONE_MARK) { prev.tones = [...TONE_MARK[ch]]; continue; }
    if (prev && ch in LENGTH) { prev.length *= LENGTH[ch]; prev.slots *= LENGTH_SLOTS[ch]; continue; }
    if (prev && TIES.has(ch)) { prev.tieNext = true; continue; }

    const known = IPA_SYMBOLS.get(ch) ?? IMPOSSIBLE_SYMBOLS.get(ch);
    if (known && known.cls === 'mark') {
      if (prev) applyMark(prev, ch);
      continue;
    }
    if (!known) continue;

    out.push({
      sym: known.sym, cls: known.cls, voiced: known.voiced,
      mods: new Set(), length: 1, slots: 1, stress: pendingStress, tones: null,
      step: pendingStep, glide,
    });
    pendingStep = 0;
    // Stress marks the syllable it precedes: carry it to the nucleus.
    if (known.cls === 'vowel') pendingStress = 0;
  }
  // A trailing break has nothing to separate.
  while (out.length && out[out.length - 1].brk != null && !out[out.length - 1].glottal) out.pop();
  return out;
}

const MARK_MODS = {
  '̥': 'voiceless', '̊': 'voiceless', '̬': 'voiced',
  'ʰ': 'aspirated', 'ʼ': 'ejective',
  '̩': 'syllabic', '̯': 'nonsyllabic',
  '˞': 'rhotic', '̤': 'breathy', '̰': 'creaky', '̃': 'nasalized',
  'ʷ': 'labialized', 'ʲ': 'palatalized', 'ˠ': 'velarized', 'ˤ': 'pharyngealized',
  '̴': 'velarized', 'ⁿ': 'nasalrelease', 'ˡ': 'lateralrelease', '̚': 'unreleased',
};

// The tongue-position diacritics (advanced, retracted, raised, lowered,
// centralized, rounding, tongue root, dental/apical/laminal, linguolabial) move
// formants by fractions of a vowel's distance to its neighbour; they are
// accepted and typed but do not change the sound.
function applyMark(seg, ch) {
  const mod = MARK_MODS[ch];
  if (mod) seg.mods.add(mod);
}

// --- Planning --------------------------------------------------------------------

// Seconds at ordinary length. Sustained sounds are looped to this; the rest
// are one-shot files of a fixed length and play out whole.
const BASE_DUR = { vowel: 0.19, nasal: 0.11, trill: 0.12, fricative: 0.15, approximant: 0.09 };
export const ONESHOT_LENGTH = { plosive: 0.09, tap: 0.035, click: 0.07, implosive: 0.1 };

// Relative pitch of tones and stress. Without a note it is carried by
// playbackRate on the files, so a tone also nudges the formants by the same
// ratio — at most ±25%, about where a real voice's formants drift between
// speakers. With a note the sound is re-synthesized at the pitch instead, so
// the formants stay put.
const TONE_RATE = { 5: 1.26, 4: 1.12, 3: 1, 2: 0.89, 1: 0.8 };
const STRESS_GAIN = { 0: 1, 1: 1.25, 2: 1.6 };
const STRESS_RATE = { 0: 1, 1: 1.04, 2: 1.08 };
const OVERLAP = 0.012;

// Secondary articulations and releases, played as a short trailing sound.
const TRAIL = {
  aspirated: ['h', 0.06], labialized: ['w', 0.05], palatalized: ['j', 0.05],
  velarized: ['ɰ', 0.04], pharyngealized: ['ʕ', 0.04], rhotic: ['ɹ', 0.06],
  nasalrelease: ['n', 0.06], lateralrelease: ['l', 0.06],
};

// Voicing diacritics on obstruents swap to the chart partner: a devoiced [b̥]
// is acoustically an unaspirated [p], a voiced [s̬] is [z].
const PARTNERS = new Map();
for (const group of [CONSONANTS, OTHER_CONSONANTS, IMPOSSIBLE]) {
  for (let i = 0; i + 1 < group.length; i++) {
    const [a, , clsA, vA] = group[i];
    const [b, , clsB, vB] = group[i + 1];
    if (clsA === clsB && !vA && vB && (clsA === 'plosive' || clsA === 'fricative')) {
      PARTNERS.set(`${a}:voiced`, b);
      PARTNERS.set(`${b}:voiceless`, a);
    }
  }
}

function variantFor(seg) {
  const allowed = VARIANTS[seg.cls] || [];
  const wants = [];
  if (seg.mods.has('voiceless')) wants.push('vl');
  if (seg.mods.has('nasalized')) wants.push('nas');
  if (seg.mods.has('breathy')) wants.push('br');
  if (seg.mods.has('creaky')) wants.push('cr');
  return wants.find((v) => allowed.includes(v)) ?? null;
}

// The singing range a note is clamped to: low enough for a bass, high enough
// for a soprano's top, and inside what the formant filters can carry.
export const PITCH_RANGE = Object.freeze({ min: 40, max: 1500 });

// Parsed segments → a time line of file playbacks:
//   { file, sym, variant, at, dur, gain, rates: [r0, r1, …], loop, f0? }
// `rates` are relative pitches spread evenly across the segment (one value is
// level, more is a contour). Pure: ipa-voice.js only has to schedule it.
//
// Options:
//   pitch    — Hz. Every sound is sung at this pitch: `f0` is then `rates`
//              scaled by it, and ipa-voice.js synthesizes the segment there
//              instead of playing the file. Tones and stress still bend it.
//   quantize — seconds per sound. Each sound gets exactly one slot (length
//              marks multiply it, a tied pair shares one), pauses are counted
//              in slots, and a stop or click is placed at the END of its slot:
//              the closure holds for the slot and the release leads straight
//              into the next sound, as a held stop does.
export function planIpa(text, { pitch = null, quantize = null } = {}) {
  const segs = parseIpa(text);
  const q = quantize > 0 ? quantize : null;
  const hz = pitch > 0 ? pitch : null;
  const sounding = segs.filter((s) => s.sym).length;
  const plan = [];
  let t = 0;
  let step = 1;
  let n = 0;

  const push = (sym, variant, cls, at, dur, gain, rates) => {
    const p = { file: soundFile(sym, variant), sym, variant, at: Math.max(0, at), dur, gain, rates, loop: isSustained(cls) };
    if (hz) {
      p.f0 = rates.map((r) => +Math.min(PITCH_RANGE.max, Math.max(PITCH_RANGE.min, r * hz)).toFixed(2));
    }
    plan.push(p);
  };

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.brk != null) { t += q ? q * seg.slots : seg.brk; continue; }

    let sym = seg.sym;
    if (seg.mods.has('voiceless')) sym = PARTNERS.get(`${sym}:voiceless`) ?? sym;
    if (seg.mods.has('voiced')) sym = PARTNERS.get(`${sym}:voiced`) ?? sym;

    step *= seg.step > 0 ? 1.12 ** seg.step : 0.89 ** -seg.step;
    const glideAt = sounding > 1 ? n / (sounding - 1) : 0;
    const base = step * STRESS_RATE[seg.stress] * (1 + 0.2 * seg.glide * glideAt);
    const rates = (seg.tones?.length ? seg.tones : [3]).map((lv) => +(TONE_RATE[lv] * base).toFixed(4));
    let gain = STRESS_GAIN[seg.stress];
    if (seg.mods.has('ejective')) gain *= 1.5;
    n++;

    const sustained = isSustained(seg.cls);
    const tied = seg.tieNext || segs[i - 1]?.tieNext;
    const trails = Object.entries(TRAIL).filter(([mod]) => seg.mods.has(mod)).map(([, tr]) => tr);
    const variant = variantFor(seg);
    const silent = seg.mods.has('unreleased') && !sustained;

    if (q) {
      // One slot per sound; a tied pair (an affricate, a diphthong) is one
      // sound, so each half takes half a slot.
      const slot = q * seg.slots * (tied ? 0.5 : 1);
      const trailTime = trails.reduce((sum, [, d]) => sum + Math.min(d, slot * 0.3), 0);
      const own = Math.max(0.02, slot - trailTime);
      let at = t;
      let dur;
      if (sustained) dur = own + OVERLAP;
      else { dur = ONESHOT_LENGTH[seg.cls]; at = t + Math.max(0, own - dur); }
      if (!silent) push(sym, variant, seg.cls, at, dur, gain, rates);
      let tt = at + (sustained ? own : dur);
      for (const [trail, d] of trails) {
        const td = Math.min(d, slot * 0.3);
        push(trail, null, IPA_SYMBOLS.get(trail).cls, tt - OVERLAP, td + OVERLAP, gain * 0.8, [rates[rates.length - 1]]);
        tt += td;
      }
      t += slot;
      continue;
    }

    let dur;
    if (sustained) {
      dur = BASE_DUR[seg.cls] * seg.length;
      if (seg.mods.has('syllabic')) dur *= 1.6;
      if (seg.mods.has('nonsyllabic')) dur *= 0.5;
      // A long contour needs room to move.
      if (rates.length > 1) dur = Math.max(dur, 0.24);
    } else {
      dur = ONESHOT_LENGTH[seg.cls];
      // A long stop is a geminate: the closure holds, then it releases.
      if (seg.length > 1) t += 0.07 * (seg.length - 1);
    }
    if (tied && sustained) dur *= 0.6;

    // An unreleased stop is closure only: the release is what makes it heard.
    if (!silent) push(sym, variant, seg.cls, t, dur, gain, rates);
    t += dur;
    // An ejective's glottis releases after the oral burst.
    if (seg.mods.has('ejective')) t += 0.05;

    for (const [trail, tdur] of trails) {
      t -= OVERLAP;
      push(trail, null, IPA_SYMBOLS.get(trail).cls, t, tdur, gain * 0.8, [rates[rates.length - 1]]);
      t += tdur;
    }

    // Neighbouring sounds overlap by a crossfade; a tie bar binds tighter.
    t -= tied && seg.tieNext ? OVERLAP * 2 : OVERLAP;
  }
  return plan;
}

// --- Pitch from a Strudel hap -------------------------------------------------
//
// The same precedence as Strudel's own getFrequency (core/util.mjs): `freq`
// wins, then `note` — a name like "c4"/"eb3" or a MIDI number, which is also
// what `.scale()` writes and what `run()` feeds through `note`/`n`+`scale` —
// shifted by superdough's `octave`. `n` alone is not a pitch (superdough
// reads it as a sample index), exactly as for a synth voice.

const CHROMA = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// Strudel's note names: letter, accidentals (# or s sharp, b or f flat),
// optional octave, default octave 3 (core/util.mjs noteToMidi).
export function noteToMidi(note) {
  const m = /^([a-gA-G])([#sbf]*)(-?\d+)?$/.exec(String(note).trim());
  if (!m) return null;
  let acc = 0;
  for (const c of m[2]) acc += c === '#' || c === 's' ? 1 : -1;
  return (Number(m[3] ?? 3) + 1) * 12 + CHROMA[m[1].toLowerCase()] + acc;
}

export function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function pitchFromValue(value) {
  if (!value || typeof value !== 'object') return null;
  let hz = null;
  if (typeof value.freq === 'number' && value.freq > 0) hz = value.freq;
  else if (value.freq != null && Number(value.freq) > 0) hz = Number(value.freq);
  else if (value.note != null) {
    const midi = typeof value.note === 'number' ? value.note : noteToMidi(value.note);
    if (midi != null && Number.isFinite(midi)) hz = midiToFreq(midi);
  }
  if (hz == null) return null;
  const oct = Number(value.octave);
  if (Number.isFinite(oct) && oct !== 0) hz *= 2 ** oct;
  return hz;
}
