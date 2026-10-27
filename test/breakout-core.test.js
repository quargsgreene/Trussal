import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAIN_ROOM,
  BREAKOUT_CALL_RE,
  parseBreakoutLiteral,
  validateBreakoutLiteral,
  rewriteBreakoutCalls,
  normalizeRooms,
  locateParticipant,
  planBreakout,
  shouldShowPanic,
  PANIC_LINGER_MS,
} from '../src/breakout-core.js';

// --- literals ----------------------------------------------------------------

test('validateBreakoutLiteral coerces participants to trimmed, de-duplicated strings', () => {
  const spec = validateBreakoutLiteral({ name: ' Room A ', participants: ['0', 1, '2a', '0'] });
  assert.deepEqual(spec, { name: 'Room A', participants: ['0', '1', '2a'] });
});

test('validateBreakoutLiteral rejects a missing/blank name', () => {
  assert.throws(() => validateBreakoutLiteral({}), /name/);
  assert.throws(() => validateBreakoutLiteral({ name: '  ' }), /name/);
});

test('"main" is a legal name for both calls', () => {
  assert.equal(validateBreakoutLiteral({ name: 'main' }, 'breakout').name, MAIN_ROOM);
  assert.equal(validateBreakoutLiteral({ name: 'main', participants: ['0'] }, 'assign').name, MAIN_ROOM);
});

test('parseBreakoutLiteral surfaces a JSON error naming the call', () => {
  assert.throws(() => parseBreakoutLiteral('{name: no quotes}', 'assign'), /assign\(\): not valid JSON/);
});

test('parseBreakoutLiteral accepts an already-parsed object', () => {
  assert.deepEqual(parseBreakoutLiteral({ name: 'r', participants: ['1'] }), { name: 'r', participants: ['1'] });
});

// --- rewriting ---------------------------------------------------------------

test('BREAKOUT_CALL_RE matches breakout() and assign(), bare or chained', () => {
  assert.equal(BREAKOUT_CALL_RE.test('$: breakout({"name":"r"})'), true);
  assert.equal(BREAKOUT_CALL_RE.test('$: cat(assign("x"))'), true);
  assert.equal(BREAKOUT_CALL_RE.test('$: s("bd").reassign()'), false);
});

test('rewriteBreakoutCalls mints a bare object literal as one atom and attaches the renderer', () => {
  const { code, atoms } = rewriteBreakoutCalls('$: breakout({"name":"room", "participants": ["0", "1"]}).slow(2)', { peer: 'p1' });
  assert.equal(code, '$: breakout("bk0").slow(2)\n._bkRender()');
  assert.deepEqual(parseBreakoutLiteral(atoms.bk0.text), { name: 'room', participants: ['0', '1'] });
  assert.equal(atoms.bk0.fn, 'breakout');
  assert.equal(atoms.bk0.peer, 'p1');
});

test('rewriteBreakoutCalls accepts a quoted literal and a brace inside a room name', () => {
  const { code, atoms } = rewriteBreakoutCalls(`$: assign('{"name":"a}b","participants":["0"]}')`);
  assert.equal(code, '$: assign("bk0")\n._bkRender()');
  assert.equal(parseBreakoutLiteral(atoms.bk0.text).name, 'a}b');
});

test('a pattern of room names mints one token per room, keeping the mini structure', () => {
  const { code, atoms } = rewriteBreakoutCalls('$: breakout({"name":"<room main ~>/2", "participants": ["1"]})');
  assert.equal(code, '$: breakout("<bk0 bk1 ~>/2")\n._bkRender()');
  assert.deepEqual(parseBreakoutLiteral(atoms.bk0.text), { name: 'room', participants: ['1'] });
  assert.deepEqual(parseBreakoutLiteral(atoms.bk1.text), { name: 'main', participants: ['1'] });
});

test('an escaped space keeps a room name with a space as one step', () => {
  const { code, atoms } = rewriteBreakoutCalls(String.raw`$: assign({"name":"<Room\\ A main>", "participants": ["1"]})`);
  assert.equal(code, '$: assign("<bk0 bk1>")\n._bkRender()');
  assert.equal(parseBreakoutLiteral(atoms.bk0.text).name, 'Room A');
});

test('a plain name with no group is one room, whatever else it contains', () => {
  const { code, atoms } = rewriteBreakoutCalls('$: breakout({"name":"Room A/B"})');
  assert.equal(code, '$: breakout("bk0")\n._bkRender()');
  assert.equal(parseBreakoutLiteral(atoms.bk0.text).name, 'Room A/B');
});

test('a literal that does not parse is minted whole, to fail when it fires', () => {
  const { code, atoms } = rewriteBreakoutCalls('$: breakout({"name":})');
  assert.equal(code, '$: breakout("bk0")\n._bkRender()');
  assert.throws(() => parseBreakoutLiteral(atoms.bk0.text), /not valid JSON/);
});

test('rewriteBreakoutCalls mints every call in a statement and shares the counter', () => {
  const counter = { n: 5 };
  const { code, atoms } = rewriteBreakoutCalls(
    '$: cat(assign({"name":"a","participants":["1"]}), assign({"name":"main","participants":["1"]}))\n\n$: s("bd")',
    { counter },
  );
  assert.equal(code, '$: cat(assign("bk5"), assign("bk6"))\n._bkRender()\n\n$: s("bd")');
  assert.deepEqual(Object.keys(atoms), ['bk5', 'bk6']);
  assert.equal(counter.n, 7);
});

// --- planning ----------------------------------------------------------------

const RAW_ROOMS = {
  'main@conf': {
    jid: 'main@conf', name: 'Main', isMainRoom: true,
    participants: {
      'main@conf/aaa': { jid: 'u1@x/r1', displayName: 'Ann' },
      'main@conf/bbb': { jid: 'u2@x/r2', displayName: 'Bo' },
    },
  },
  'r1@breakout': {
    jid: 'r1@breakout', name: 'room',
    participants: { 'r1@breakout/ccc': { jid: 'u3@x/r3', displayName: 'Cy' } },
  },
};
const PEERS = new Map([
  ['0', { jitsiId: 'aaa', displayName: 'Ann' }],
  ['1', { jitsiId: 'bbb', displayName: 'Bo' }],
  ['2b', { jitsiId: 'zzz', displayName: 'Cy' }], // id changed with the move
]);

test('normalizeRooms reads endpoint ids off occupant JIDs', () => {
  const rooms = normalizeRooms(RAW_ROOMS);
  assert.deepEqual(rooms[0].participants[0], { id: 'aaa', jid: 'u1@x/r1', displayName: 'Ann' });
});

test('locateParticipant falls back to the display name', () => {
  const where = locateParticipant(normalizeRooms(RAW_ROOMS), PEERS.get('2b'));
  assert.equal(where.room.jid, 'r1@breakout');
  assert.equal(where.participantJid, 'u3@x/r3');
});

test('breakout() into an existing room moves only those not already there', () => {
  const plan = planBreakout({ fn: 'breakout', spec: { name: 'room', participants: ['0', '2b'] } }, normalizeRooms(RAW_ROOMS), PEERS);
  assert.equal(plan.create, null);
  assert.deepEqual(plan.moves, [{ token: '0', participantJid: 'u1@x/r1', roomJid: 'r1@breakout' }]);
});

test('breakout() of a new room creates it and waits before moving anyone', () => {
  const plan = planBreakout({ fn: 'breakout', spec: { name: 'new', participants: ['0'] } }, normalizeRooms(RAW_ROOMS), PEERS);
  assert.equal(plan.create, 'new');
  assert.equal(plan.waiting, true);
  assert.deepEqual(plan.moves, []);
});

test('assign() never creates a room', () => {
  const plan = planBreakout({ fn: 'assign', spec: { name: 'nope', participants: ['0'] } }, normalizeRooms(RAW_ROOMS), PEERS);
  assert.equal(plan.create, null);
  assert.match(plan.error, /no breakout room named "nope"/);
});

test('assign() to "main" sends someone back to the main room', () => {
  const plan = planBreakout({ fn: 'assign', spec: { name: 'main', participants: ['2b', '1'] } }, normalizeRooms(RAW_ROOMS), PEERS);
  assert.deepEqual(plan.moves, [{ token: '2b', participantJid: 'u3@x/r3', roomJid: 'main@conf' }]);
});

test('breakout() to "main" sends someone back and never creates a room', () => {
  const plan = planBreakout({ fn: 'breakout', spec: { name: 'main', participants: ['2b'] } }, normalizeRooms(RAW_ROOMS), PEERS);
  assert.equal(plan.create, null);
  assert.deepEqual(plan.moves.map((m) => m.roomJid), ['main@conf']);
});

test('back and forth: a move just sent counts before Jitsi reports it', () => {
  const rooms = normalizeRooms(RAW_ROOMS); // Jitsi still lists "0" in main
  const justSent = { 'u1@x/r1': 'r1@breakout' };
  const expectedRoomOf = (jid) => justSent[jid] ?? null;
  const again = planBreakout({ fn: 'breakout', spec: { name: 'room', participants: ['0'] } }, rooms, PEERS, { expectedRoomOf });
  assert.deepEqual(again.moves, []);
  const back = planBreakout({ fn: 'assign', spec: { name: 'main', participants: ['0'] } }, rooms, PEERS, { expectedRoomOf });
  assert.deepEqual(back.moves, [{ token: '0', participantJid: 'u1@x/r1', roomJid: 'main@conf' }]);
});

test('a participant who pressed panic, or has no token, is skipped', () => {
  const plan = planBreakout(
    { fn: 'breakout', spec: { name: 'room', participants: ['0', '1', '9'] } },
    normalizeRooms(RAW_ROOMS), PEERS, { isExempt: (token) => token === '0' },
  );
  assert.deepEqual(plan.moves.map((m) => m.token), ['1']);
  assert.deepEqual(plan.skipped.map((s) => s.token), ['0', '9']);
});

// --- panic button ------------------------------------------------------------

test('the panic button only shows for someone who has been moved', () => {
  const now = 1_000_000;
  assert.equal(shouldShowPanic({ inBreakout: false, lastMoveAt: null }, now), false);
  assert.equal(shouldShowPanic({ inBreakout: true, lastMoveAt: now - 10 * PANIC_LINGER_MS }, now), true);
  assert.equal(shouldShowPanic({ inBreakout: false, lastMoveAt: now - 1000 }, now), true);
  assert.equal(shouldShowPanic({ inBreakout: false, lastMoveAt: now - PANIC_LINGER_MS }, now), false);
});
