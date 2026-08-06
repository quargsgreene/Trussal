import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setPeerPacks, removePeerPacks, clearPacks, getPack, hasPack, knownPackNames,
  parseDataRef, isDataRef, resolveDataRef, makeDataFn, sampleDataRefAt,
  dataBegin, dataClip, dataChop, dataShuffle, rewriteDataRefs,
} from '../src/data-ref.js';
import { parseDataFile } from '../src/data-samples-core.js';

// A stand-in for the lazily-loaded Strudel module: enough surface for
// buildPattern, and it records what it was handed so the tests can assert on
// the values rather than on pattern internals.
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

test('an out-of-range index is silence, not a thrown program-killer', () => {
  setPeerPacks('p1', [pack('Weather', [[1, 2]])]);
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(resolveDataRef('Weather:9', strudel), strudel.silence);
  } finally {
    console.error = realError;
  }
  assert.match(errors[0], /out of range/, 'loud, but the room keeps playing');
});

test('_data falls back to mini so a rewritten sound reference is unchanged', () => {
  setPeerPacks('p1', [pack('Weather', [[1, 2]])]);
  const _data = makeDataFn(strudel);
  assert.deepEqual(_data('Weather', 1).values, [1, 2]);
  assert.deepEqual(_data('piano', 3, 'piano:3'), { kind: 'mini', text: 'piano:3' });
});

test('an empty sample is silence rather than an empty fastcat', () => {
  setPeerPacks('p1', [pack('E', [[]])]);
  assert.equal(resolveDataRef('E:1', strudel), strudel.silence);
});

// ---------------------------------------------------------------------------
// Determinism across peers
// ---------------------------------------------------------------------------

test('two peers owning the same pack name resolve identically everywhere', () => {
  // Peer b uploaded a different Weather.csv than peer a. Whichever browser
  // asks, the answer has to be the same one, or the room hears two mixes.
  setPeerPacks('peer-b', [pack('Weather', [[9, 9]])]);
  setPeerPacks('peer-a', [pack('Weather', [[1, 1]])]);
  assert.deepEqual(getPack('Weather').samples[0].values, [1, 1], 'lowest peerId wins');

  // Same registrations, opposite arrival order — same winner.
  clearPacks();
  setPeerPacks('peer-a', [pack('Weather', [[1, 1]])]);
  setPeerPacks('peer-b', [pack('Weather', [[9, 9]])]);
  assert.deepEqual(getPack('Weather').samples[0].values, [1, 1]);
});

test('a departing peer takes its packs with it', () => {
  setPeerPacks('p1', [pack('A', [[1]])]);
  setPeerPacks('p2', [pack('B', [[2]])]);
  removePeerPacks('p1');
  assert.equal(hasPack('A'), false);
  assert.equal(hasPack('B'), true);
});

test('an empty pack list deregisters the peer', () => {
  setPeerPacks('p1', [pack('A', [[1]])]);
  setPeerPacks('p1', []);
  assert.equal(hasPack('A'), false);
});

// ---------------------------------------------------------------------------
// clip / chop / begin / shuffle
// ---------------------------------------------------------------------------

test('begin drops from the front, by fraction or by count', () => {
  const v = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(dataBegin(v, 0.5), [5, 6, 7, 8, 9], 'the latter half, per the spec example');
  assert.deepEqual(dataBegin(v, 0.9), [9]);
  assert.deepEqual(dataBegin(v, 3), [3, 4, 5, 6, 7, 8, 9], '>= 1 is a count');
  assert.deepEqual(dataBegin(v, 0), v);
  assert.deepEqual(dataBegin(v, 99), []);
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

test('shuffle is a permutation, and the same one on every client', () => {
  const v = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const a = dataShuffle(v, ['Weather', 3, 0]);
  const b = dataShuffle(v, ['Weather', 3, 0]);
  assert.deepEqual(a, b, 'seeded, not Math.random');
  assert.deepEqual([...a].sort((x, y) => x - y), v, 'every value survives');
  assert.notDeepEqual(a, v, 'and the order actually changed');
  assert.notDeepEqual(dataShuffle(v, ['Weather', 4, 0]), a, 'a different sample shuffles differently');
  assert.notDeepEqual(dataShuffle(v, ['Weather', 3, 1]), a, 'a different seed shuffles differently');
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

test('the rewrite ignores everything that is not a whole-string reference', () => {
  for (const code of [
    '$: s("bd sd")',                 // a mini sequence
    "$: s('Weather:3')",             // single quotes are not mini-parsed
    '$: note("c4 e4")',
    'const x = { Weather: 3 };',     // an object literal
    'x ? a : 3',                     // a ternary
    '$: s("bd").gain(0.3)',
    'label: s("bd")',                // a labeled voice
  ]) {
    assert.equal(rewriteDataRefs(code), code, code);
  }
});

test('the rewrite is deterministic regardless of what is registered', () => {
  const code = '$: s("piano").distort("Weather:3")';
  clearPacks();
  const withNothingLoaded = rewriteDataRefs(code);
  setPeerPacks('p1', [pack('Weather', [[1], [2], [3]])]);
  assert.equal(rewriteDataRefs(code), withNothingLoaded,
    'every browser must build the same program text for the same peer');
});

// ---------------------------------------------------------------------------
// The spec's worked example, end to end
// ---------------------------------------------------------------------------

test('a 10-row Weather.csv drives distortion from its third column', () => {
  // 1. Upload: the file becomes a pack named after itself, one sample per
  //    column, and shows in the studio as Weather:4.
  const csv = 'date,tempC,humidity,windKph\n'
    + Array.from({ length: 10 }, (_, i) => `2026-01-0${i},${10 + i},${i / 3},${i * 3}`).join('\n');
  const uploaded = parseDataFile('Weather.csv', csv);
  assert.equal(uploaded.name, 'Weather');
  assert.equal(uploaded.samples.length, 4);

  // 2. Broadcast: it arrives on every peer through the bus, JSON round-tripped.
  const overTheWire = JSON.parse(JSON.stringify(uploaded));
  setPeerPacks('peer-a', [overTheWire]);

  // 3. The performer writes the pattern; the rewrite runs in every browser.
  const rewritten = rewriteDataRefs('$: s("piano").distort("Weather:3".begin(0.5))');
  assert.equal(rewritten, "$: s(\"piano\").distort(_data('Weather',3,'Weather:3').begin(0.5))");
  assert.ok(!/"Weather:3"/.test(rewritten), 'the literal never reaches mini-notation');

  // 4. Evaluation: _data resolves the third column, .begin(0.5) takes its
  //    latter half, and the piano's own s(...) is untouched.
  const _data = makeDataFn(strudel);
  const humidity = [0, 1 / 3, 2 / 3, 1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3].map(v => Number(v.toPrecision(6)));
  assert.deepEqual(_data('Weather', 3, 'Weather:3').dataValues, humidity);
  assert.deepEqual(_data('Weather', 3, 'Weather:3').begin(0.5).values, humidity.slice(5));
});

test('a reference in one peer\'s code resolves for a peer who uploaded nothing', () => {
  // The failure this whole broadcast path exists to prevent: peer B evaluates
  // peer A's voice, so an unresolvable reference there would mean the room
  // hears two different programs.
  const pack = parseDataFile('Weather.csv', 'a,b\n1,4\n2,5\n3,6\n');
  setPeerPacks('peer-a', [JSON.parse(JSON.stringify(pack))]);   // as peer B sees it
  assert.deepEqual(resolveDataRef('Weather:2', strudel).values, [4, 5, 6]);
});

test('non-string specs are not references — H() is handed numbers and patterns', () => {
  setPeerPacks('p1', [pack('W', [[1, 2]])]);
  assert.equal(parseDataRef(42), null);
  assert.equal(parseDataRef(null), null);
  assert.equal(parseDataRef(undefined), null);
  // A Pattern-like object must fall through to reify untouched, without being
  // stringified to find that out.
  const patternLike = { queryArc() { return []; }, get toString() { throw new Error('stringified'); } };
  assert.equal(resolveDataRef(patternLike, strudel), null);
});
