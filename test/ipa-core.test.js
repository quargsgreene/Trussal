import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IPA_GROUPS,
  IPA_SYMBOLS,
  SOUNDING,
  containsIpa,
  parseIpa,
  planIpa,
  soundFile,
  ipaKeyLabel,
  isCombining,
} from '../src/ipa-core.js';

const syms = (text) => parseIpa(text).filter((s) => s.sym).map((s) => s.sym);
const files = (text) => planIpa(text).map((p) => p.file);

test('every IPA symbol is a single UTF-16 unit, so one key press inserts one symbol', () => {
  for (const sym of IPA_SYMBOLS.keys()) assert.equal(sym.length, 1, `${sym} (${sym.codePointAt(0).toString(16)})`);
});

test('no symbol appears on two keyboard pages', () => {
  const total = IPA_GROUPS.reduce((n, g) => n + g.symbols.length, 0);
  assert.equal(IPA_SYMBOLS.size, total);
});

test('every letter on the chart has a sound of its own; marks do not', () => {
  for (const { sym, cls } of IPA_SYMBOLS.values()) {
    const sounding = SOUNDING.some((s) => s.sym === sym);
    if (cls === 'mark' || sym === 'ʔ') assert.equal(sounding, false, sym);
    else assert.equal(sounding, true, sym);
  }
});

test('sound files are named by code point, so ɡ and g never collide', () => {
  assert.equal(soundFile('ɡ'), 'ipa-0261.wav');
  assert.equal(soundFile('a', 'nas'), 'ipa-0061-nas.wav');
});

test('plain words and other orthographies are not IPA', () => {
  for (const w of ['hello world', 'squirrels?', 'café', 'français', 'Ærø', 'θάλασσα']) {
    assert.equal(containsIpa(w), false, w);
  }
});

test('a word with an IPA-only symbol, or a wrapped transcription, is IPA', () => {
  assert.equal(containsIpa('ʃiːp'), true);
  assert.equal(containsIpa('/bed/'), true);
  assert.equal(containsIpa('[kat]'), true);
});

test('each symbol plays its own sound — no English respelling', () => {
  // [x] is a velar fricative, [y] a close front rounded vowel, [c] a palatal
  // stop — none of them what an English reader would say.
  assert.deepEqual(files('/xyc/'), ['ipa-0078.wav', 'ipa-0079.wav', 'ipa-0063.wav']);
});

test('the keyboard g stands in for the IPA ɡ', () => {
  assert.deepEqual(syms('/ga/'), ['ɡ', 'a']);
});

test('precomposed letters are split into base and mark, but ç stays ç', () => {
  const [seg] = parseIpa('ã');
  assert.equal(seg.sym, 'a');
  assert.ok(seg.mods.has('nasalized'));
  assert.deepEqual(syms('/çi/'), ['ç', 'i']);
});

test('length marks lengthen; extra-short shortens', () => {
  const dur = (t) => planIpa(t)[0].dur;
  assert.ok(dur('/aː/') > dur('/aˑ/'));
  assert.ok(dur('/aˑ/') > dur('/a/'));
  assert.ok(dur('/a/') > dur('/ă/'));
});

test('a vowel diacritic picks the phonation variant file', () => {
  assert.deepEqual(files('ã'), ['ipa-0061-nas.wav']);
  assert.deepEqual(files('/a̤/'), ['ipa-0061-br.wav']);
  assert.deepEqual(files('/a̰/'), ['ipa-0061-cr.wav']);
  assert.deepEqual(files('/ḁ/'), ['ipa-0061-vl.wav']);
  assert.deepEqual(files('/m̥/'), ['ipa-006d-vl.wav']);
});

test('voicing diacritics on obstruents swap to the chart partner', () => {
  assert.deepEqual(files('/b̥/'), [soundFile('p')]);
  assert.deepEqual(files('/s̬/'), [soundFile('z')]);
});

test('aspiration, labialization and palatalization trail the sound', () => {
  assert.deepEqual(files('/pʰa/'), [soundFile('p'), soundFile('h'), soundFile('a')]);
  assert.deepEqual(files('/kʷa/'), [soundFile('k'), soundFile('w'), soundFile('a')]);
  assert.deepEqual(files('/tʲa/'), [soundFile('t'), soundFile('j'), soundFile('a')]);
});

test('an unreleased stop is silent closure', () => {
  assert.deepEqual(files('/at̚/'), [soundFile('a')]);
});

test('a glottal stop is silence between the vowels, not a file', () => {
  const plan = planIpa('/aʔa/');
  assert.equal(plan.length, 2);
  assert.ok(plan[1].at - (plan[0].at + plan[0].dur) > 0.05);
});

test('tone letters set the preceding vowel\'s pitch, and a run is a contour', () => {
  const [high] = planIpa('/ma˥/').filter((p) => p.file === soundFile('a'));
  const [low] = planIpa('/ma˩/').filter((p) => p.file === soundFile('a'));
  assert.ok(high.rates[0] > low.rates[0]);
  const [rise] = planIpa('/ma˧˥/').filter((p) => p.file === soundFile('a'));
  assert.equal(rise.rates.length, 2);
  assert.ok(rise.rates[1] > rise.rates[0]);
});

test('combining tone marks work the same way', () => {
  const [fall] = planIpa('/â/');
  assert.ok(fall.rates[0] > fall.rates[1]);
});

test('primary stress makes its syllable louder and higher', () => {
  const plan = planIpa("/ˈpapa/");
  const vowels = plan.filter((p) => p.file === soundFile('a'));
  assert.ok(vowels[0].gain > vowels[1].gain);
  assert.ok(vowels[0].rates[0] > vowels[1].rates[0]);
});

test('spaces and group marks are pauses; a link removes one', () => {
  const gap = (t) => { const [a, b] = planIpa(t); return b.at - (a.at + a.dur); };
  assert.ok(gap('/a | a/') > gap('/a a/'));
  assert.ok(gap('/a a/') > gap('/a‿a/'));
});

test('sustained sounds loop; stops play out once', () => {
  const [a] = planIpa('/a/');
  const [p] = planIpa('/p/');
  assert.equal(a.loop, true);
  assert.equal(p.loop, false);
});

test('combining marks are labelled on a dotted circle', () => {
  assert.equal(isCombining('̃'), true);
  assert.equal(ipaKeyLabel('̃'), '◌̃');
  assert.equal(ipaKeyLabel('ʃ'), 'ʃ');
});

// --- pitch and quantize ------------------------------------------------------

import { noteToMidi, midiToFreq, pitchFromValue, PITCH_RANGE } from '../src/ipa-core.js';

test('note names follow Strudel: default octave 3, # / s sharp, b / f flat', () => {
  assert.equal(noteToMidi('a4'), 69);
  assert.equal(noteToMidi('c'), 48);
  assert.equal(noteToMidi('C#4'), 61);
  assert.equal(noteToMidi('cs4'), 61);
  assert.equal(noteToMidi('eb3'), 51);
  assert.equal(noteToMidi('ef3'), 51);
  assert.equal(noteToMidi('hello'), null);
});

test('pitch precedence matches Strudel: freq, then note (name or MIDI), then octave', () => {
  assert.equal(pitchFromValue({ freq: 220, note: 'c4' }), 220);
  assert.equal(Math.round(pitchFromValue({ note: 'a4' })), 440);
  assert.equal(Math.round(pitchFromValue({ note: 69 })), 440);
  assert.equal(Math.round(pitchFromValue({ note: 'a4', octave: -1 })), 220);
  // What .scale() writes: n is consumed and note is set.
  assert.equal(Math.round(pitchFromValue({ note: 'E3' })), Math.round(midiToFreq(52)));
});

test('n alone, or no pitch at all, is not a pitch', () => {
  assert.equal(pitchFromValue({ n: 3 }), null);
  assert.equal(pitchFromValue({ word: 'tc0' }), null);
});

test('with a pitch every segment carries f0 at that pitch, bent by tone and stress', () => {
  const plan = planIpa('/ma/', { pitch: 220 });
  for (const p of plan) assert.deepEqual(p.f0, [220]);
  const [rise] = planIpa('/a˧˥/', { pitch: 220 });
  assert.equal(rise.f0[0], 220);
  assert.ok(rise.f0[1] > 220);
  const stressed = planIpa('/ˈa/', { pitch: 220 })[0];
  assert.ok(stressed.f0[0] > 220);
});

test('a pitch is clamped to the singing range', () => {
  assert.deepEqual(planIpa('/a/', { pitch: 5 })[0].f0, [PITCH_RANGE.min]);
  assert.deepEqual(planIpa('/a/', { pitch: 1e5 })[0].f0, [PITCH_RANGE.max]);
});

test('without a pitch the plan has no f0, so the files play', () => {
  assert.equal(planIpa('/a/')[0].f0, undefined);
});

test('quantize gives each sound one slot on the grid', () => {
  const q = 0.5;
  const plan = planIpa('/sama/', { quantize: q });
  const starts = plan.filter((p) => p.loop).map((p) => p.at);
  // s, a, m, a — all sustained, each starting on its slot.
  assert.deepEqual(starts.map((x) => +x.toFixed(6)), [0, 0.5, 1, 1.5]);
  for (const p of plan) assert.ok(Math.abs(p.dur - (q + 0.012)) < 1e-9);
});

test('quantize: a stop sits at the end of its slot, releasing into the next sound', () => {
  const plan = planIpa('/pa/', { quantize: 0.5 });
  const [p, a] = plan;
  assert.ok(Math.abs(p.at + p.dur - 0.5) < 1e-9);
  assert.equal(a.at, 0.5);
});

test('quantize: length marks multiply the slot, a tied pair shares one', () => {
  const long = planIpa('/aːa/', { quantize: 0.5 });
  assert.equal(long[1].at, 1);
  const tied = planIpa('/t͡sa/', { quantize: 0.5 });
  assert.equal(tied[tied.length - 1].at, 0.5);
});

test('quantize: pauses are counted in slots', () => {
  const plan = planIpa('/a a/', { quantize: 0.5 });
  assert.equal(plan[1].at, 1);
});

// --- the chart's shaded cells ------------------------------------------------

import { IMPOSSIBLE_GROUP, IMPOSSIBLE_SYMBOLS, IPA_PAGES } from '../src/ipa-core.js';

test('the Impossible page is the last keyboard page and holds every shaded cell of the 2020 chart', () => {
  assert.equal(IPA_PAGES[IPA_PAGES.length - 1], IMPOSSIBLE_GROUP);
  assert.deepEqual(IPA_PAGES.slice(0, -1), [...IPA_GROUPS]);
  const names = IMPOSSIBLE_GROUP.symbols.map((s) => s.name);
  for (const name of [
    'voiced pharyngeal plosive', 'voiced glottal plosive', 'pharyngeal nasal', 'glottal nasal',
    'velar trill', 'glottal trill', 'velar tap', 'glottal tap', 'glottal approximant',
  ]) assert.ok(names.includes(name), name);
  for (const place of ['bilabial', 'labiodental', 'pharyngeal', 'glottal']) {
    assert.ok(names.includes(`voiceless ${place} lateral fricative`), place);
    assert.ok(names.includes(`voiced ${place} lateral fricative`), place);
    assert.ok(names.includes(`${place} lateral approximant`), place);
  }
  assert.equal(IMPOSSIBLE_GROUP.symbols.length, 21);
});

test('each shaded cell is a sound of its own, written apart from every chart symbol', () => {
  for (const { sym } of IMPOSSIBLE_GROUP.symbols) {
    assert.equal(IPA_SYMBOLS.has(sym), false, sym);
    assert.ok(SOUNDING.some((s) => s.sym === sym), sym);
    assert.equal(sym, sym.normalize('NFD'), `${sym} is typed already normalised`);
    assert.equal(containsIpa(sym), true, sym);
    assert.deepEqual(syms(`/${sym}/`), [sym], sym);
  }
  assert.equal(IMPOSSIBLE_SYMBOLS.size, IMPOSSIBLE_GROUP.symbols.length);
});

test('a shaded cell is read as one sound, not as its letter and marks', () => {
  assert.deepEqual(syms('/aɡ̆a/'), ['a', 'ɡ̆', 'a']);
  assert.deepEqual(syms('/aʔ̬a/'), ['a', 'ʔ̬', 'a']);
  assert.deepEqual(syms('/fˡa/'), ['fˡ', 'a']);
  // The most specific notation wins.
  assert.deepEqual(syms('/ɦ̞ˡ ɦ̞ ɦˡ ɦ/'), ['ɦ̞ˡ', 'ɦ̞', 'ɦˡ', 'ɦ']);
  // ASCII g stands in for ɡ here too.
  assert.deepEqual(syms('/gă/'), ['ɡ', 'a'], 'the breve on the vowel stays on the vowel');
  assert.deepEqual(syms('/ğa/'), ['ɡ̆', 'a']);
});

test('other marks on a shaded cell still apply, whatever order they were typed in', () => {
  // NFD sorts marks below ahead of marks above: [ʔ̃] with ̥ typed after the
  // tilde still matches, and the ̥ picks the voiceless file.
  assert.deepEqual(files('/ʔ\u0303\u0325/'), [soundFile('ʔ̃', 'vl')]);
  assert.deepEqual(files('/ʔ\u0325\u0303/'), [soundFile('ʔ̃', 'vl')]);
  const [tap] = parseIpa('/ɡ\u0306\u0325/');
  assert.equal(tap.sym, 'ɡ̆');
  assert.ok(tap.mods.has('voiceless'));
  // Voicing swaps a lateral fricative to its partner, as on the chart.
  assert.deepEqual(files('/βˡ̥/'), [soundFile('ɸˡ')]);
  assert.deepEqual(files('/hˡ̬/'), [soundFile('ɦˡ')]);
});

test('ˡ after a stop is still lateral release', () => {
  assert.deepEqual(files('/tˡa/'), [soundFile('t'), soundFile('l'), soundFile('a')]);
});

test('a glottal stop is still silence; only its shaded cells sound', () => {
  assert.deepEqual(files('/ʔ/'), []);
  assert.deepEqual(files('/ʔ̬ ʔ̃ ʔ̆/'), [soundFile('ʔ̬'), soundFile('ʔ̃'), soundFile('ʔ̆')]);
});

test('a shaded cell\'s file is named by all its code points', () => {
  assert.equal(soundFile('ɡ̆'), 'ipa-0261-0306.wav');
  assert.equal(soundFile('ɦ̞ˡ'), 'ipa-0266-031e-02e1.wav');
  assert.equal(soundFile('ʔ̃', 'vl'), 'ipa-0294-0303-vl.wav');
});

test('shaded cells keep their class\'s timing: stops and taps play once, the rest loop', () => {
  const [stop, nasal, tap, lateral] = planIpa('/ʔ̬ ʡ̃ ɡ̆ ɸˡ/');
  assert.equal(stop.loop, false);
  assert.equal(nasal.loop, true);
  assert.equal(tap.loop, false);
  assert.equal(lateral.loop, true);
});
