// Music-theory helpers for the composing AI: scales and chord progressions
// in Strudel-friendly note names. Pure module.

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

export const SCALE_INTERVALS = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  wholetone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
});

function noteIndex(root) {
  const normalized = String(root).trim().toLowerCase()
    .replace('db', 'c#').replace('eb', 'd#').replace('gb', 'f#')
    .replace('ab', 'g#').replace('bb', 'a#');
  const idx = NOTE_NAMES.indexOf(normalized);
  if (idx === -1) throw new RangeError(`unknown root note '${root}'`);
  return idx;
}

// scaleNotes('g', 'minor', 4) → ['g4','a4','a#4','c5','d5','d#5','f5']
export function scaleNotes(root, mode = 'major', octave = 4) {
  const intervals = SCALE_INTERVALS[mode];
  if (!intervals) throw new RangeError(`unknown scale '${mode}' (have: ${Object.keys(SCALE_INTERVALS).join(', ')})`);
  const rootIdx = noteIndex(root);
  return intervals.map(iv => {
    const abs = rootIdx + iv;
    return `${NOTE_NAMES[abs % 12]}${octave + Math.floor(abs / 12)}`;
  });
}

// Diatonic triads by roman numeral over a major or minor key.
const NUMERALS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

export function chordForNumeral(key, mode, numeral) {
  const scale = SCALE_INTERVALS[mode === 'minor' ? 'minor' : 'major'];
  const clean = String(numeral).toLowerCase().replace(/[^ivx]/g, '');
  const degree = NUMERALS.indexOf(clean);
  if (degree === -1) throw new RangeError(`unknown numeral '${numeral}'`);
  const rootIdx = noteIndex(key);
  const pick = (d) => rootIdx + scale[d % 7] + 12 * Math.floor(d / 7);
  return [pick(degree), pick(degree + 2), pick(degree + 4)].map(abs =>
    `${NOTE_NAMES[abs % 12]}${4 + Math.floor(abs / 12)}`);
}

// chordProgression('a', 'minor', ['i','VI','III','VII']) → array of triads.
export function chordProgression(key, mode, numerals) {
  return (numerals || []).map(n => chordForNumeral(key, mode, n));
}

// Convenience: format a progression as a Strudel chord pattern string.
export function progressionToPattern(key, mode, numerals) {
  return `<${chordProgression(key, mode, numerals).map(triad => `[${triad.join(',')}]`).join(' ')}>`;
}
