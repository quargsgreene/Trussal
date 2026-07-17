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
  assert.deepEqual(circularParticipantTestQueue.serve(), { token: null, position: null, slot: -1, newTurn: false, lapped: false, departed: false });
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

// --- Metaprogram ordering ------------------------------------------------------

test('applyMetaprogramOrder makes the ring exactly the listed tokens, in written order', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-1', '1');
  circularParticipantTestQueue.register('src-2', '2');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0', '1', '2']);

  const retired = circularParticipantTestQueue.applyMetaprogramOrder(['2', '0', '3']);
  assert.deepEqual(retired, [], 'nobody departed, nothing retired');
  assert.deepEqual(circularParticipantTestQueue.order(), ['2', '0', '3'],
    'written order, including a placeholder slot for the unseen 3');
  assert.equal(circularParticipantTestQueue.hasValidMetaprogram(), true);
  // 1 is present but unlisted: silent off the ring, identity still pinned.
  assert.deepEqual(circularParticipantTestQueue.waitingTokens(), ['1']);
  assert.equal(circularParticipantTestQueue.tokenFor('src-1'), '1', 'the pin persists off the ring');
});

test('serve() rotates in metaprogram order, placeholder (silent) turns included', () => {
  let clock = 0;
  const circularParticipantTestQueue = new CircularParticipantQueue({ now: () => clock, slotMs: 1000 });
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-1', '1');
  circularParticipantTestQueue.applyMetaprogramOrder(['1', '0']);

  clock = 0;    assert.equal(circularParticipantTestQueue.serve().token, '1');
  clock = 1000; assert.equal(circularParticipantTestQueue.serve().token, '0');
  clock = 2000; assert.equal(circularParticipantTestQueue.serve().token, '1', 'wraps in metaprogram order');
});

test('captureMetaprogramTokens filters malformed tokens but keeps written order AND repeats', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  assert.deepEqual(
    circularParticipantTestQueue.captureMetaprogramTokens(['2', '0a', '2', 'nope', '', null, '10', '0a']),
    ['2', '0a', '2', '10', '0a'],
  );
});

// --- repeated tokens play their written multiplicity ---------------------------

test('a token listed N times holds N ring positions and serves N times per lap', () => {
  let clock = 0;
  const q = new CircularParticipantQueue({ now: () => clock, slotMs: 1000 });
  q.register('src-0', '0');
  q.register('src-0a', '0a');
  q.applyMetaprogramOrder(['0', '0', '0a']); // <0 0 0a>: 0 twice, 0a once
  assert.deepEqual(q.order(), ['0', '0', '0a'], 'both occurrences of 0 keep a slot');
  assert.equal(q.size, 3);

  // Every 0 slot streams the same participant's audio.
  assert.equal(q.jitsiIdFor('0'), 'src-0');
  assert.equal(q.tokenFor('src-0'), '0');

  clock = 0;    assert.equal(q.serve().token, '0');
  clock = 1000; assert.equal(q.serve().token, '0', 'second consecutive turn is 0 again');
  clock = 2000; assert.equal(q.serve().token, '0a');
  clock = 3000; assert.equal(q.serve().token, '0', 'lap wraps to the first 0');
});

test('interleaved and back-to-back repeats keep their exact written positions', () => {
  const q = new CircularParticipantQueue();
  q.register('src-0', '0');
  q.register('src-0a', '0a');
  q.register('src-0b', '0b');
  q.applyMetaprogramOrder(['0', '0a', '0', '0b', '0a', '0b', '0']);
  assert.deepEqual(q.order(), ['0', '0a', '0', '0b', '0a', '0b', '0']);
  // 0 appears three times, all bound to the one participant.
  assert.equal(q.order().filter((t) => t === '0').length, 3);
  assert.equal(q.jitsiIdFor('0'), 'src-0');
});

test('a repeated token registered only after the program lists it upgrades every placeholder', () => {
  const q = new CircularParticipantQueue();
  q.register('src-0', '0');
  q.applyMetaprogramOrder(['0', '1', '1']); // 1 listed twice before its audio arrives
  assert.deepEqual(q.order(), ['0', '1', '1']);
  assert.equal(q.jitsiIdFor('1'), '1', 'both 1 slots are placeholders until the stream binds');

  assert.equal(q.register('src-1', '1'), '1');
  assert.equal(q.jitsiIdFor('1'), 'src-1', 'the real id fills every 1 position');
  assert.equal(q.tokenFor('src-1'), '1');
  assert.deepEqual(q.order(), ['0', '1', '1'], 'no duplicate slot added');
});

test('removing a repeated token in join-order mode drops all its positions, then a rejoin re-appends once', () => {
  const q = new CircularParticipantQueue();
  q.register('src-0', '0');
  q.register('src-1', '1');
  q.applyMetaprogramOrder(['0', '1', '0']); // 0 twice
  assert.deepEqual(q.order(), ['0', '1', '0']);

  // Revert to join order: repeats collapse to one slot each.
  q.applyMetaprogramOrder([]);
  assert.deepEqual(q.order(), ['0', '1'], 'join order holds one slot per token');
  assert.equal(q.jitsiIdFor('0'), 'src-0');
});

test('a repeat present does not block adding a genuinely new participant token', () => {
  const q = new CircularParticipantQueue();
  q.register('src-0', '0');
  q.register('src-0a', '0a');
  q.applyMetaprogramOrder(['0', '0', '0a']);
  q.register('src-1', '1'); // new participant joins → off-ring while unlisted
  assert.deepEqual(q.waitingTokens(), ['1']);

  q.applyMetaprogramOrder(['0', '0', '0a', '1']); // add 1 while 0 is still repeated
  assert.deepEqual(q.order(), ['0', '0', '0a', '1'], '1 folds in; the repeat is untouched');
  assert.equal(q.jitsiIdFor('1'), 'src-1');
  assert.deepEqual(q.waitingTokens(), []);
});

test('a newcomer whose token the metaprogram does not list stays silent until added', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.applyMetaprogramOrder(['0']);

  assert.equal(circularParticipantTestQueue.register('src-9', '9'), '9',
    'register still returns the token so the bot keeps buffering their audio');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0'], 'no slot: silent until the program lists 9');
  assert.deepEqual(circularParticipantTestQueue.waitingTokens(), ['9']);

  // The program is updated to include them: they fold in at their written spot.
  circularParticipantTestQueue.applyMetaprogramOrder(['9', '0']);
  assert.deepEqual(circularParticipantTestQueue.order(), ['9', '0']);
  assert.equal(circularParticipantTestQueue.jitsiIdFor('9'), 'src-9', 'the off-ring pin carried the real id in');
  assert.deepEqual(circularParticipantTestQueue.waitingTokens(), []);
});

test('depart keeps a listed slot as a ghost; a program update retires it', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-1', '1');
  circularParticipantTestQueue.applyMetaprogramOrder(['0', '1']);

  const gone = circularParticipantTestQueue.depart('src-0');
  assert.deepEqual(gone, { token: '0', removed: false }, 'metaprogram still lists 0 -> ghost kept');
  assert.deepEqual(circularParticipantTestQueue.order(), ['0', '1'], 'the ghost keeps its turn');

  const retired = circularParticipantTestQueue.applyMetaprogramOrder(['1']);
  assert.deepEqual(retired, ['0'], 'dropping 0 from the program retires the ghost');
  assert.deepEqual(circularParticipantTestQueue.order(), ['1']);
});

test('depart in join-order mode (and for off-ring pins) removes immediately', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-1', '1');
  assert.deepEqual(circularParticipantTestQueue.depart('src-0'), { token: '0', removed: true });
  assert.deepEqual(circularParticipantTestQueue.order(), ['1']);

  // Off-ring pin: departing drops the pin outright (nothing was playing them).
  circularParticipantTestQueue.applyMetaprogramOrder(['1']);
  circularParticipantTestQueue.register('src-9', '9');
  assert.deepEqual(circularParticipantTestQueue.waitingTokens(), ['9']);
  assert.deepEqual(circularParticipantTestQueue.depart('src-9'), { token: '9', removed: true });
  assert.deepEqual(circularParticipantTestQueue.waitingTokens(), []);
});

test('a present participant dropped from the program waits off-ring and returns with its identity', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.register('src-1', '1');
  circularParticipantTestQueue.applyMetaprogramOrder(['0', '1']);

  circularParticipantTestQueue.applyMetaprogramOrder(['0']);
  assert.deepEqual(circularParticipantTestQueue.order(), ['0']);
  assert.deepEqual(circularParticipantTestQueue.waitingTokens(), ['1'], 'present but unlisted -> off the ring, not gone');

  circularParticipantTestQueue.applyMetaprogramOrder(['1', '0']);
  assert.deepEqual(circularParticipantTestQueue.order(), ['1', '0']);
  assert.equal(circularParticipantTestQueue.jitsiIdFor('1'), 'src-1', 'same identity folds back in');
});

test('an empty participants list reverts to join-order mode: ghosts retired, waiters fold back in', () => {
  const circularParticipantTestQueue = new CircularParticipantQueue();
  circularParticipantTestQueue.register('src-0', '0');
  circularParticipantTestQueue.applyMetaprogramOrder(['0', '5']);
  circularParticipantTestQueue.register('src-2', '2'); // unlisted -> waits off-ring
  circularParticipantTestQueue.depart('src-0');        // listed -> ghost

  const retired = circularParticipantTestQueue.applyMetaprogramOrder([]);
  assert.equal(circularParticipantTestQueue.hasValidMetaprogram(), false);
  assert.deepEqual(retired, ['0'], 'the departed ghost is retired on revert');
  assert.deepEqual(circularParticipantTestQueue.order(), ['5', '2'],
    'the unclaimed placeholder survives; the waiter folds back in');
  assert.deepEqual(circularParticipantTestQueue.waitingTokens(), []);
});
