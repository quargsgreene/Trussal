import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setPeerPacks, removePeerPacks, clearPacks, getPack, hasPack, knownPackNames,
  parseDataRef, isDataRef, resolveDataRef, makeDataFn, sampleDataRefAt,
  dataBegin, dataClip, dataChop, dataShuffle, rewriteDataRefs,
} from '../src/data-ref.js';
import { parseDataFile } from '../src/data-samples-core.js';

const strudel = {
  fastcat: (...values) => ({ kind: 'fastcat', values }),
  mini: (text) => ({ kind: 'mini', text }),
  silence: { kind: 'silence' },
};

const pack = (name, samples) => ({
  name,
  kind: 'csv',
  samples: samples.map((values, i) => ({ label: `c${i}`, values, truncated: false })),
});

beforeEach(() => clearPacks());

test('reference syntax is a whole string, name and 1-based index', () => {
  assert.deepEqual(parseDataRef('Weather:3'), { name: 'Weather', index: 3 });
  assert.deepEqual(parseDataRef('  Weather : 3 '), { name: 'Weather', index: 3 });
  assert.equal(parseDataRef('Weather:0'), null, 'indices start at 1');
  assert.equal(parseDataRef('Weather'), null, 'a bare name is not a reference');
  assert.equal(parseDataRef('bd:3 sd:2'), null, 'a mini sequence is left to mini');
  assert.equal(parseDataRef('bd*4:2'), null);
  assert.equal(parseDataRef('3:3'), null, 'names are identifiers');
});

test('a reference resolves only when the pack exists', () => {
  setPeerPacks('p1', [pack('Weather', [[1, 2], [3, 4]])]);
  assert.equal(isDataRef('Weather:1'), true);
  assert.equal(isDataRef('piano:3'), false, 'sound references stay sound references');
  assert.deepEqual([...knownPackNames()], ['Weather']);
});

test('resolving gives the column values, 1-based', () => {
  setPeerPacks('p1', [pack('Weather', [[1, 2], [3, 4], [5, 6, 7]])]);
  assert.deepEqual(resolveDataRef('Weather:3', strudel).values, [5, 6, 7]);
  assert.deepEqual(resolveDataRef('Weather:1', strudel).values, [1, 2]);
  assert.equal(resolveDataRef('Nope:1', strudel), null, 'unknown pack → caller falls back');
});

test('clip keeps the front, and composes with begin for a middle slice', () => {
  const v = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(dataClip(v, 0.5), [0, 1, 2, 3, 4]);
  assert.deepEqual(dataClip(v, 3), [0, 1, 2]);
  assert.deepEqual(dataClip(dataBegin(v, 0.2), 0.5), [2, 3, 4, 5]);
});

test('chop resamples to n evenly spaced values', () => {
  const v = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(dataChop(v, 5), [0, 2, 4, 6, 8]);
  assert.deepEqual(dataChop(v, 1), [0]);
  assert.deepEqual(dataChop([1, 2], 4), [1, 1, 2, 2], 'more than the source thickens it');
  assert.deepEqual(dataChop(v, 0), v, 'nonsense counts leave it alone');
});

test('the ops chain off a reference and rebuild a pattern each time', () => {
  setPeerPacks('p1', [pack('Weather', [[], [], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]])]);
  const ref = resolveDataRef('Weather:3', strudel);

  // The spec's worked example: the latter half of the third column.
  assert.deepEqual(ref.begin(0.5).values, [5, 6, 7, 8, 9]);
  // Still chainable afterwards.
  assert.deepEqual(ref.begin(0.5).clip(2).values, [5, 6]);
  assert.deepEqual(ref.chop(2).values, [0, 5]);
  // And the original is untouched by any of it.
  assert.deepEqual(ref.values, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('the data ops shadow Strudel controls of the same name only on a reference', () => {
  setPeerPacks('p1', [pack('W', [[1, 2, 3, 4]])]);
  const ref = resolveDataRef('W:1', strudel);
  assert.equal(typeof ref.begin, 'function');
  assert.equal(Object.prototype.propertyIsEnumerable.call(ref, 'begin'), false,
    'non-enumerable, so it does not leak into pattern serialization');
  // A plain pattern from the same fake module has no data ops — .begin() there
  // is Strudel's sample-start control, which is the point.
  assert.equal(strudel.fastcat(1, 2).begin, undefined);
});

test('values ride along for the contexts with no Strudel scheduler', () => {
  setPeerPacks('p1', [pack('W', [[1, 2, 3, 4]])]);
  assert.deepEqual(resolveDataRef('W:1', strudel).dataValues, [1, 2, 3, 4]);

  // sampleDataRefAt walks the whole sample across one cycle.
  assert.equal(sampleDataRefAt('W:1', 0), 1);
  assert.equal(sampleDataRefAt('W:1', 0.25), 2);
  assert.equal(sampleDataRefAt('W:1', 0.5), 3);
  assert.equal(sampleDataRefAt('W:1', 0.99), 4);
  assert.equal(sampleDataRefAt('W:1', 3.25), 2, 'the same every cycle');
  assert.equal(sampleDataRefAt('W:1', -0.75), 2, 'and before the epoch too');
  assert.equal(sampleDataRefAt('Nope:1', 0), null);
});

// ---------------------------------------------------------------------------
// The source rewrite
// ---------------------------------------------------------------------------

test('a whole-string reference becomes a _data call', () => {
  assert.equal(
    rewriteDataRefs('$: s("piano").distort("Weather:3")'),
    "$: s(\"piano\").distort(_data('Weather',3,'Weather:3'))");
  // The spec's worked example, end to end.
  assert.equal(
    rewriteDataRefs('$: s("piano").distort("Weather:3".begin(0.5))'),
    "$: s(\"piano\").distort(_data('Weather',3,'Weather:3').begin(0.5))");
});

test('the rewrite leaves sound-name positions alone', () => {
  for (const code of ['s("bd:3")', 'sound("bd:3")', '.s( "bd:3" )', 'stack(s("bd:3"))']) {
    assert.equal(rewriteDataRefs(code), code, code);
  }
  // ...but only the sound controls: a trailing "s" in another name is not one.
  assert.match(rewriteDataRefs('bass("Weather:3")'), /_data\('Weather',3/);
  assert.match(rewriteDataRefs('note("Weather:3")'), /_data\('Weather',3/);
});

test('the rewrite is deterministic regardless of what is registered', () => {
  const code = '$: s("piano").distort("Weather:3")';
  clearPacks();
  const withNothingLoaded = rewriteDataRefs(code);
  setPeerPacks('p1', [pack('Weather', [[1], [2], [3]])]);
  assert.equal(rewriteDataRefs(code), withNothingLoaded,
    'every browser must build the same program text for the same peer');
});
