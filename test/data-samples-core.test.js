import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDataFile, parseDelimited, looksLikeHeader, castValue, parseLenientNumber,
  flattenValues, packNameFromFilename, uniquePackName, isDataFile, roundValue,
  isRecognizedStrudelValue,
  MAX_VALUES_PER_SAMPLE, MAX_SAMPLES_PER_PACK,
} from '../src/data-samples-core.js';

const ords = () => new Map();

test('a pack has one sample per column, not per row', () => {
  const csv = 'date,tempC,humidity,windKph\n'
    + Array.from({ length: 10 }, (_, i) => `2026-01-0${i},${i},${i * 2},${i * 3}`).join('\n');
  const pack = parseDataFile('Weather.csv', csv);

  assert.equal(pack.name, 'Weather');
  assert.equal(pack.samples.length, 4, 'four columns → four samples');
  // The example from the spec: "Weather:3" is the third column, 1-based, and
  // the chip shows the sample count (4), not the row count (10).
  assert.equal(pack.samples[2].label, 'humidity');
  assert.equal(pack.samples[2].values.length, 10);
  assert.deepEqual(pack.samples[2].values, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
});

test('quoted fields keep their commas, and the delimiter never becomes a value', () => {
  const rows = parseDelimited('a,"1,234",c\n"say ""hi""",2,3\n', ',');
  assert.deepEqual(rows, [['a', '1,234', 'c'], ['say "hi"', '2', '3']]);
  // The comma inside the quoted field is ignored on the way to a number.
  assert.equal(castValue('1,234', ords()), 1234);
});

test('a newline inside quotes stays inside the field', () => {
  const rows = parseDelimited('a,"line1\nline2"\nb,c\n', ',');
  assert.deepEqual(rows, [['a', 'line1\nline2'], ['b', 'c']]);
});

test('TSV splits on tabs and leaves commas alone', () => {
  const pack = parseDataFile('Trip.tsv', 'city\tpop\nSao Paulo, BR\t12,300,000\nOslo, NO\t700000\n');
  assert.equal(pack.samples.length, 2);
  assert.equal(pack.samples[0].label, 'city');
  // Both city strings are unparseable → stable first-seen ordinals.
  assert.deepEqual(pack.samples[0].values, [0, 1]);
  assert.deepEqual(pack.samples[1].values, [12300000, 700000]);
});

test('header detection needs an all-non-numeric first row over data', () => {
  assert.equal(looksLikeHeader([['a', 'b'], ['1', '2']]), true);
  assert.equal(looksLikeHeader([['a', '2'], ['1', '2']]), false, 'mixed row is data');
  assert.equal(looksLikeHeader([['a', 'b']]), false, 'nothing underneath it');
  assert.equal(looksLikeHeader([['1', '2'], ['3', '4']]), false);
});

test('headerless numeric CSV keeps every row as data', () => {
  const pack = parseDataFile('Nums.csv', '1,2\n3,4\n5,6\n');
  assert.deepEqual(pack.samples[0].values, [1, 3, 5]);
  assert.deepEqual(pack.samples[0].label, 'column 1');
});

test('lenient numbers: separators and units stripped, but only at the start', () => {
  assert.equal(parseLenientNumber('1,234'), 1234);
  assert.equal(parseLenientNumber('$1,234.56'), 1234.56);
  assert.equal(parseLenientNumber('72F'), 72);
  assert.equal(parseLenientNumber('45%'), 45);
  assert.equal(parseLenientNumber('-3.5e2 kg'), -350);
  assert.equal(parseLenientNumber('sunny'), null);
  // Anchored: a trailing digit must not be mined out of a category or a note.
  assert.equal(parseLenientNumber('room3'), null);
  assert.equal(parseLenientNumber('c4'), null);
});

test('recognized Strudel values pass through uncast', () => {
  assert.equal(isRecognizedStrudelValue('c4'), true);
  assert.equal(isRecognizedStrudelValue('a#3'), true);
  assert.equal(isRecognizedStrudelValue('Eb2'), true);
  assert.equal(isRecognizedStrudelValue('~'), true);
  assert.equal(isRecognizedStrudelValue('sunny'), false);

  const o = ords();
  assert.equal(castValue('c4', o), 'c4', 'stays a note, does not become 4');
  assert.equal(castValue('~', o), '~');
  assert.equal(o.size, 0, 'recognized values never consume an ordinal');
});

test('unparseable values become stable per-sample ordinals', () => {
  const o = ords();
  assert.equal(castValue('sunny', o), 0);
  assert.equal(castValue('rain', o), 1);
  assert.equal(castValue('sunny', o), 0, 'same category, same number');
  assert.equal(castValue('fog', o), 2);

  // Per sample, not per pack: two columns' categories must not collide.
  const pack = parseDataFile('Cat.csv', 'a,b\nsunny,rain\nrain,sunny\n');
  assert.deepEqual(pack.samples[0].values, [0, 1]);
  assert.deepEqual(pack.samples[1].values, [0, 1]);
});

test('empties, booleans and nulls cast to numbers', () => {
  const o = ords();
  assert.equal(castValue('', o), 0);
  assert.equal(castValue(null, o), 0);
  assert.equal(castValue(undefined, o), 0);
  assert.equal(castValue(true, o), 1);
  assert.equal(castValue(false, o), 0);
});

test('values are rounded at parse time so every peer holds the same numbers', () => {
  assert.equal(roundValue(1 / 3), 0.333333);
  assert.equal(roundValue(0), 0);
  assert.equal(roundValue(NaN), 0);
  assert.equal(roundValue(Infinity), 0);
  const pack = parseDataFile('P.json', JSON.stringify({ a: [1 / 3, 2 / 3] }));
  assert.deepEqual(pack.samples[0].values, [0.333333, 0.666667]);
  assert.equal(JSON.parse(JSON.stringify(pack)).samples[0].values[0], 0.333333,
    'survives a round trip over the bus unchanged');
});

test('JSON: one sample per top-level property', () => {
  const pack = parseDataFile('Cfg.json', JSON.stringify({ gain: 0.5, cutoff: 800, name: 'lead' }));
  assert.equal(pack.samples.length, 3);
  assert.deepEqual(pack.samples.map(s => s.label), ['gain', 'cutoff', 'name']);
  assert.deepEqual(pack.samples[0].values, [0.5]);
  assert.deepEqual(pack.samples[2].values, [0], 'unparseable string → ordinal');
});

test('JSON: array and object values are extracted into a pattern', () => {
  const pack = parseDataFile('P.json', JSON.stringify({
    arr: [1, 2, 3],
    obj: { x: 4, y: 5 },
  }));
  assert.deepEqual(pack.samples[0].values, [1, 2, 3]);
  assert.deepEqual(pack.samples[1].values, [4, 5], 'keys dropped, values kept');
});

test('JSON: multidimensional values flatten depth-first to one dimension', () => {
  const { values, truncated } = flattenValues([1, [2, [3, 4]], { a: 5, b: [6] }], 100, ords());
  assert.deepEqual(values, [1, 2, 3, 4, 5, 6]);
  assert.equal(truncated, false);

  const pack = parseDataFile('Deep.json', JSON.stringify({ grid: [[1, 2], [3, 4]] }));
  assert.deepEqual(pack.samples[0].values, [1, 2, 3, 4]);
});

test('JSON: an array of records reads column-wise like the same table as CSV', () => {
  const json = JSON.stringify([{ t: 1, h: 10 }, { t: 2, h: 20 }, { t: 3, h: 30 }]);
  const pack = parseDataFile('Rec.json', json);
  assert.deepEqual(pack.samples.map(s => s.label), ['t', 'h']);
  assert.deepEqual(pack.samples[0].values, [1, 2, 3]);
  assert.deepEqual(pack.samples[1].values, [10, 20, 30]);
});

test('JSON: a bare array of scalars is one sample named after the pack', () => {
  const pack = parseDataFile('Steps.json', '[1,2,3]');
  assert.equal(pack.samples.length, 1);
  assert.equal(pack.samples[0].label, 'Steps');
  assert.deepEqual(pack.samples[0].values, [1, 2, 3]);
});

test('flatten stops at the limit and says so', () => {
  const { values, truncated } = flattenValues([1, 2, 3, 4, 5], 3, ords());
  assert.deepEqual(values, [1, 2, 3]);
  assert.equal(truncated, true);
});

test('a sample longer than the cap is truncated head-first and reported', () => {
  const long = Array.from({ length: MAX_VALUES_PER_SAMPLE + 500 }, (_, i) => i);
  const pack = parseDataFile('Long.json', JSON.stringify({ ramp: long }));
  assert.equal(pack.samples[0].values.length, MAX_VALUES_PER_SAMPLE);
  assert.equal(pack.samples[0].values[0], 0, 'keeps the head');
  assert.equal(pack.samples[0].truncated, true);
  assert.equal(pack.truncatedSamples, 1);
});

test('a pack with too many columns drops the tail and reports the count', () => {
  const width = MAX_SAMPLES_PER_PACK + 5;
  const header = Array.from({ length: width }, (_, i) => `c${i}`).join(',');
  const row = Array.from({ length: width }, (_, i) => i).join(',');
  const pack = parseDataFile('Wide.csv', `${header}\n${row}\n`);
  assert.equal(pack.samples.length, MAX_SAMPLES_PER_PACK);
  assert.equal(pack.droppedSamples, 5);
});

test('the browser-wide budget caps a pack even when its own limits would not', () => {
  const pack = parseDataFile('B.json', JSON.stringify({ a: [1, 2, 3, 4], b: [5, 6, 7, 8] }),
    { budget: 6 });
  assert.equal(pack.samples[0].values.length, 4);
  assert.equal(pack.samples[1].values.length, 2, 'second sample gets what is left');
  assert.equal(pack.truncatedSamples, 1);
});

test('pack names come from the filename, sanitized to something referenceable', () => {
  assert.equal(packNameFromFilename('Weather.csv'), 'Weather');
  assert.equal(packNameFromFilename('/uploads/My Weather 2024.csv'), 'My_Weather_2024');
  assert.equal(packNameFromFilename('2024-data.json'), '_2024_data', 'never starts with a digit');
  assert.equal(packNameFromFilename('___.csv'), 'data', 'a stem that sanitizes to nothing');
  // A leading dot is a dotfile, not an extension — and so never a data file.
  assert.equal(isDataFile('.csv'), false);
});

test('a name collision gets a suffix instead of overwriting', () => {
  assert.equal(uniquePackName('Weather', []), 'Weather');
  assert.equal(uniquePackName('Weather', ['Weather']), 'Weather_2');
  assert.equal(uniquePackName('Weather', ['Weather', 'Weather_2']), 'Weather_3');
  // Audio banks share the namespace, since a reference cannot say which it meant.
  const pack = parseDataFile('piano.csv', 'a\n1\n', { taken: ['piano'] });
  assert.equal(pack.name, 'piano_2');
});

test('file-type gate', () => {
  assert.equal(isDataFile('a.csv'), true);
  assert.equal(isDataFile('a.TSV'), true);
  assert.equal(isDataFile('a.json'), true);
  assert.equal(isDataFile('a.wav'), false);
  assert.equal(isDataFile('noext'), false);
});

test('unreadable files throw rather than registering an empty pack', () => {
  assert.throws(() => parseDataFile('bad.json', '{nope'), /not valid JSON/);
  assert.throws(() => parseDataFile('empty.csv', ''), /no rows|no values/);
  assert.throws(() => parseDataFile('a.wav', 'x'), /not a JSON, CSV or TSV/);
});
