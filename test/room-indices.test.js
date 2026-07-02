import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  botSuffix,
  suffixToOrdinal,
  isValidBotSuffix,
  isValidParticipantToken,
  parseParticipantToken
} = require('../latency-instrument/room-indices.js');

test('spec examples: first bot is a, 28th is zb — never z first, never zz 28th', () => {
  assert.equal(botSuffix(0), 'a');   // "First person's first bot -> 0a"
  assert.equal(botSuffix(27), 'zb'); // "Second person's 28th bot -> 0zb"
  assert.notEqual(botSuffix(0), 'z');   // bad: "First person's first bot -> 0z"
  assert.notEqual(botSuffix(27), 'zz'); // bad: "28th bot -> 0zz"
});

test('suffix sequence grows only when all 26 letters exhaust a position', () => {
  assert.equal(botSuffix(25), 'z');   // 26th
  assert.equal(botSuffix(26), 'za');  // 27th
  assert.equal(botSuffix(51), 'zz');  // 52nd
  assert.equal(botSuffix(52), 'zza'); // 53rd
  assert.equal(botSuffix(3 * 26 + 21), 'zzzv'); // 1zzzv from the spec's scheduling example
});

test('suffixToOrdinal is the inverse of botSuffix', () => {
  for (const n of [0, 1, 25, 26, 27, 51, 52, 100, 999]) {
    assert.equal(suffixToOrdinal(botSuffix(n)), n);
  }
  assert.equal(suffixToOrdinal('bc'), null);
  assert.equal(suffixToOrdinal(''), null);
});

test('bad bot index shapes from the spec are rejected', () => {
  assert.equal(isValidParticipantToken('0bcd'), false);
  assert.equal(isValidParticipantToken('9fae'), false);
  assert.equal(isValidBotSuffix('bcd'), false);
  assert.equal(isValidBotSuffix('az'), false);
  // Good shapes:
  assert.equal(isValidParticipantToken('0a'), true);
  assert.equal(isValidParticipantToken('0zb'), true);
  assert.equal(isValidParticipantToken('1zzzv'), true);
  assert.equal(isValidParticipantToken('10'), true);
  assert.equal(isValidParticipantToken('a'), false);
  assert.equal(isValidParticipantToken(''), false);
});

test('parseParticipantToken splits owner and ordinal', () => {
  assert.deepEqual(parseParticipantToken('4'), { ownerIndex: 4, suffix: null, ordinal: null });
  assert.deepEqual(parseParticipantToken('1zb'), { ownerIndex: 1, suffix: 'zb', ordinal: 27 });
  assert.equal(parseParticipantToken('0bcd'), null);
});

test('botSuffix rejects non-ordinals', () => {
  assert.throws(() => botSuffix(-1), RangeError);
  assert.throws(() => botSuffix(1.5), RangeError);
});
