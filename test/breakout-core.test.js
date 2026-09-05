import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAIN_ROOM,
  parseBreakoutLiteral,
  validateBreakoutLiteral,
  resolveBreakoutState,
  roomForToken,
} from '../src/breakout-core.js';

test('validateBreakoutLiteral normalizes a room with no participants', () => {
  const spec = validateBreakoutLiteral({ name: 'Room A' });
  assert.deepEqual(spec, { name: 'Room A', participants: [] });
});

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

test('resolveBreakoutState folds declared rooms and assign() into one state', () => {
  const breakouts = [{ name: 'A', participants: ['0'] }, { name: 'B', participants: [] }];
  const assignments = [{ token: '1', room: 'B' }];
  const state = resolveBreakoutState(breakouts, assignments);
  assert.equal(roomForToken(state, '0'), 'A'); // seated by breakout()'s own participants list
  assert.equal(roomForToken(state, '1'), 'B'); // seated by assign()
  assert.equal(roomForToken(state, '2'), MAIN_ROOM); // never mentioned
  const roomA = state.rooms.find((r) => r.name === 'A');
  assert.deepEqual(roomA.participants, ['0']);
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
