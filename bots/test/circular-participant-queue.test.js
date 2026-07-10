import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CircularParticipantQueue, tokenOrder } from '../src/bot/circular-participant-queue.js';

// --- tokenOrder ---------------------------------------------------------------

test('tokenOrder sorts numeric index first, then bot suffix', () => {
  const shuffled = ['1', '0b', '0', '10', '0a', '2'];
  assert.deepEqual(shuffled.slice().sort(tokenOrder), ['0', '0a', '0b', '1', '2', '10']);
});

// --- assign-once mapping (requirement 2) -------------------------------------

test('register pins jitsiId -> token once and ignores a later differing token', () => {
  const q = new CircularParticipantQueue();
  assert.equal(q.register('src-a', '0'), '0');
  // Same media-stream source re-announced under a different token: the mapping
  // persists — it keeps its original token and adds no second slot.
  assert.equal(q.register('src-a', '9'), '0', 'keeps the first-assigned token');
  assert.equal(q.size, 1, 'no duplicate slot for a re-registered source');
  assert.equal(q.tokenFor('src-a'), '0');
  assert.equal(q.jitsiIdFor('0'), 'src-a');
});

test('register binds a real jitsiId to a slot first seeded by token alone (no duplicate)', () => {
  const q = new CircularParticipantQueue();
  q.register('0', '0');                          // seeded by token (e.g. direct buffer seeding)
  assert.equal(q.register('src-real', '0'), '0'); // the real source arrives later
  assert.equal(q.size, 1, 'one slot per token');
  assert.equal(q.tokenFor('src-real'), '0');
  assert.equal(q.jitsiIdFor('0'), 'src-real', 'placeholder identity upgraded to the media-stream id');
});

// --- join order (requirement 3) ----------------------------------------------

test('order() is join order (insertion), not a numeric re-sort; new joiners append at the tail', () => {
  const q = new CircularParticipantQueue();
  q.register('src-0', '0');
  q.register('src-0a', '0a');
  assert.deepEqual(q.order(), ['0', '0a']);
  // A late human joins mid-meeting -> appended at the tail; existing slots keep
  // their positions, so whose turn it is never renumbers under them.
  q.register('src-1', '1');
  assert.deepEqual(q.order(), ['0', '0a', '1']);
});

// --- circular write pointer + lap detection (requirements 1 & 4) -------------

test('serve() rotates one slot per slotMs and reports whose turn it is', () => {
  let clock = 0;
  const q = new CircularParticipantQueue({ now: () => clock, slotMs: 1000 });
  q.register('src-0', '0');
  q.register('src-0a', '0a'); // a bot in the ring (requirement 5)
  q.register('src-1', '1');

  clock = 0;
  let s = q.serve();
  assert.equal(s.token, '0');
  assert.equal(s.position, 0);
  assert.equal(s.newTurn, true);
  assert.equal(s.lapped, false);

  // Many playback ticks fall inside one slot: only the first is a new turn.
  s = q.serve();
  assert.equal(s.token, '0');
  assert.equal(s.newTurn, false, 'same slot -> not a new turn');

  clock = 1000; assert.equal(q.serve().token, '0a', 'next slot -> next participant');
  clock = 2000; assert.equal(q.serve().token, '1');

  // Slot 3 wraps back to position 0: the write pointer has "reached the same
  // position again" a full lap later — the lap boundary requirement 4 names.
  clock = 3000;
  s = q.serve();
  assert.equal(s.token, '0', 'rotation wraps back round');
  assert.equal(s.position, 0);
  assert.equal(s.lapped, true, 'a full lap back to this position is flagged');
});

test('serve() on an empty ring yields no active participant', () => {
  const q = new CircularParticipantQueue({ now: () => 0, slotMs: 1000 });
  assert.deepEqual(q.serve(), { token: null, position: null, slot: -1, newTurn: false, lapped: false });
});

test('serve() clamps a backward clock so the slot index never regresses', () => {
  let clock = 5000;
  const q = new CircularParticipantQueue({ now: () => clock, slotMs: 1000 });
  q.register('src-0', '0');
  q.register('src-1', '1');
  assert.equal(q.serve().slot, 0, 'the first serve anchors the start; slot counts from there');
  clock = 8000;
  assert.equal(q.serve().slot, 3);
  clock = 0; // clock jumps backwards (e.g. an injected test clock reset)
  assert.equal(q.serve().slot, 3, 'monotonic: does not run backwards');
});
