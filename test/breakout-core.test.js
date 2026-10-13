import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAIN_ROOM,
  parseBreakoutLiteral,
  validateBreakoutLiteral,
  resolveBreakoutState,
  roomForToken,
  buildDefaultBreakoutProgram,
} from '../src/breakout-core.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';

test('validateBreakoutLiteral accepts participants and coerces to strings', () => {
  const spec = validateBreakoutLiteral({ name: 'Room A', participants: ['0', 1, '2a'] });
  assert.deepEqual(spec.participants, ['0', '1', '2a']);
});

test('validateBreakoutLiteral rejects a missing/blank name and the reserved "main"', () => {
  assert.throws(() => validateBreakoutLiteral({}), /name/);
  assert.throws(() => validateBreakoutLiteral({ name: '  ' }), /name/);
  assert.throws(() => validateBreakoutLiteral({ name: 'main' }), /reserved/);
});

test('parseBreakoutLiteral surfaces a JSON error', () => {
  assert.throws(() => parseBreakoutLiteral('{name: no quotes}'), /not valid JSON/);
});

test('resolveBreakoutState: a later assign() for the same token wins', () => {
  const breakouts = [{ name: 'A', participants: [] }, { name: 'B', participants: [] }];
  const assignments = [{ token: '0', room: 'A' }, { token: '0', room: 'B' }];
  const state = resolveBreakoutState(breakouts, assignments);
  assert.equal(roomForToken(state, '0'), 'B');
});

test('resolveBreakoutState: assign() to "main" sends someone back, even if a room lists them', () => {
  const breakouts = [{ name: 'A', participants: ['0'] }];
  const assignments = [{ token: '0', room: MAIN_ROOM }];
  const state = resolveBreakoutState(breakouts, assignments);
  assert.equal(roomForToken(state, '0'), MAIN_ROOM);
});

test('resolveBreakoutState: assign() to an undeclared room name still creates it', () => {
  const state = resolveBreakoutState([], [{ token: '0', room: 'Ad Hoc' }]);
  assert.equal(roomForToken(state, '0'), 'Ad Hoc');
  assert.deepEqual(state.rooms, [{ name: 'Ad Hoc', participants: ['0'] }]);
});

// --- buildDefaultBreakoutProgram ---------------------------------------------

test('buildDefaultBreakoutProgram seeds a rest when nobody is in the room yet', () => {
  assert.match(buildDefaultBreakoutProgram([]), /\$ participants <~>/);
  assert.match(buildDefaultBreakoutProgram(undefined), /\$ participants <~>/);
});