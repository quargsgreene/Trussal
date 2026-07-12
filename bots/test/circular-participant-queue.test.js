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
  const circularParticipantTestQueue = new CircularParticipantQueue();
  assert.equal(circularParticipantTestQueue.register('src-a', '0'), '0');
  // Same media-stream source re-announced under a different token: the mapping
  // persists — it keeps its original token and adds no second slot.
  assert.equal(circularParticipantTestQueue.register('src-a', '9'), '0', 'keeps the first-assigned token');
  assert.equal(circularParticipantTestQueue.size, 1, 'no duplicate slot for a re-registered source');
  assert.equal(circularParticipantTestQueue.tokenFor('src-a'), '0');
  assert.equal(circularParticipantTestQueue.jitsiIdFor('0'), 'src-a');
});

test('register binds a real jitsiId to a slot first seeded by token alone (no duplicate)', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('0', '0');                          // seeded by token (e.g. direct buffer seeding)
  assert.equal(circularParticipantTestQueue.register('src-real', '0'), '0'); // the real source arrives later
  assert.equal(circularParticipantTestQueue.size, 1, 'one slot per token');
  assert.equal(circularParticipantTestQueue.tokenFor('src-real'), '0');
  assert.equal(circularParticipantTestQueue.jitsiIdFor('0'), 'src-real', 'placeholder identity upgraded to the media-stream id');
});

// --- join order (requirement 3) ----------------------------------------------

test('order() is join order (insertion), not a numeric re-sort; new joiners append at the tail', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-0a', '0a');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0', '0a']);
  // A late human joins mid-meeting -> appended at the tail; existing slots keep
  // their positions, so whose turn it is never renumbers under them.
  circularParticipantTestQueue.register('src-1', '1');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0', '0a', '1']);
});

// --- circular write pointer + lap detection (requirements 1 & 4) -------------

test('serve() rotates one slot per slotMs and reports whose turn it is', () => {
  let clock = 0;
  const circularParticipantTestQueue = new CircularParticipantQueue({ now: () => clock, slotMs: 1000 });
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-0a', '0a'); // a bot in the ring (requirement 5)
  circularParticipantTestQueue.register('src-1', '1');

  clock = 0;
  let s = circularParticipantTestQueue.serve();
  assert.equal(s.token, '0');
  assert.equal(s.position, 0);
  assert.equal(s.newTurn, true);
  assert.equal(s.lapped, false);

  // Many playback ticks fall inside one slot: only the first is a new turn.
  s = circularParticipantTestQueue.serve();
  assert.equal(s.token, '0');
  assert.equal(s.newTurn, false, 'same slot -> not a new turn');

  clock = 1000; assert.equal(circularParticipantTestQueue.serve().token, '0a', 'next slot -> next participant');
  clock = 2000; assert.equal(circularParticipantTestQueue.serve().token, '1');

  // Slot 3 wraps back to position 0: the write pointer has "reached the same
  // position again" a full lap later — the lap boundary requirement 4 names.
  clock = 3000;
  s = circularParticipantTestQueue.serve();
  assert.equal(s.token, '0', 'rotation wraps back round');
  assert.equal(s.position, 0);
  assert.equal(s.lapped, true, 'a full lap back to this position is flagged');
});

test('serve() on an empty ring yields no active participant', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue({ now: () => 0, slotMs: 1000 });
  assert.deepEqual(circularParticipantTestQueue.serve(), { token: null, position: null, slot: -1, newTurn: false, lapped: false });
});

test('serve() clamps a backward clock so the slot index never regresses', () => {
  let clock = 5000;
  const circularParticipantTestQueue = new CircularParticipantQueue({ now: () => clock, slotMs: 1000 });
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-1', '1');
  assert.equal(circularParticipantTestQueue.serve().slot, 0, 'the first serve anchors the start; slot counts from there');
  clock = 8000;
  assert.equal(circularParticipantTestQueue.serve().slot, 3);
  clock = 0; // clock jumps backwards (e.g. an injected test clock reset)
  assert.equal(circularParticipantTestQueue.serve().slot, 3, 'monotonic: does not run backwards');
});

// --- remove: a leave compacts the ring; a rejoin re-appends at the tail ------

test('remove() drops a slot, compacts the ring, and the rotation continues over the rest', () => {
  let clock = 0;
  const circularParticipantTestQueue = new CircularParticipantQueue({ now: () => clock, slotMs: 1000 });
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-0a', '0a');
  circularParticipantTestQueue.register('src-1', '1');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0', '0a', '1']);

  // Remove the middle participant: the ring compacts, no gap where it was.
  assert.equal(circularParticipantTestQueue.remove('src-0a'), '0a', 'returns the removed token');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0', '1']);
  assert.equal(circularParticipantTestQueue.size, 2);
  assert.equal(circularParticipantTestQueue.hasToken('0a'), false, 'the token is gone');
  assert.equal(circularParticipantTestQueue.tokenFor('src-0a'), null, 'the jitsiId mapping is gone');

  // The rotation now cycles just the two survivors.
  clock = 0;    assert.equal(circularParticipantTestQueue.serve().token, '0');
  clock = 1000; assert.equal(circularParticipantTestQueue.serve().token, '1');
  clock = 2000; assert.equal(circularParticipantTestQueue.serve().token, '0', 'wraps over the compacted ring');

  // Removing something never registered is a no-op.
  assert.equal(circularParticipantTestQueue.remove('nobody'), null);
});

test('remove() then re-register appends the returning id at the tail (no gap, not recycled)', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-0a', '0a');
  circularParticipantTestQueue.register('src-1', '1');

  circularParticipantTestQueue.remove('src-0');                              // the first participant leaves
  assert.deepEqual(circularParticipantTestQueue.order(), ['0a', '1'], 'compacted, no gap where 0 was');

  // The same id/token rejoins -> a fresh tail slot; existing slots never shifted.
  assert.equal(circularParticipantTestQueue.register('src-0', '0'), '0');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0a', '1', '0'], 'rejoin re-appends at the tail');
});
