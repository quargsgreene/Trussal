import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REACTIONS,
  REACTION_CALL_RE,
  resolveReaction,
  resolveUnreactMs,
  DEFAULT_UNREACT_MS,
} from '../src/reactions-core.js';

test('every requested reaction has an abbreviation', () => {
  const labels = Object.values(REACTIONS).map((r) => r.label).sort();
  assert.deepEqual(labels, ['Boo', 'Clap', 'Heart', 'Laugh', 'Silence', 'Surprise', 'Thumbs Up'].sort());
  assert.equal(REACTIONS.tu.label, 'Thumbs Up');
  assert.equal(REACTIONS.su.label, 'Surprise');
  assert.equal(REACTIONS.si.label, 'Silence');
  assert.equal(REACTIONS.la.label, 'Laugh');
  assert.equal(REACTIONS.b.label, 'Boo');
  assert.equal(REACTIONS.h.label, 'Heart');
  assert.equal(REACTIONS.c.label, 'Clap');
});

test('resolveReaction accepts the abbreviation or Jitsi\'s own id, case-insensitively', () => {
  assert.equal(resolveReaction('su').id, 'surprised');
  assert.equal(resolveReaction('SU').id, 'surprised');
  assert.equal(resolveReaction('surprised').id, 'surprised');
  assert.equal(resolveReaction('nope'), null);
  assert.equal(resolveReaction(''), null);
  assert.equal(resolveReaction(undefined), null);
});

test('resolveUnreactMs defaults and clamps', () => {
  assert.equal(resolveUnreactMs(undefined), DEFAULT_UNREACT_MS);
  assert.equal(resolveUnreactMs('not a number'), DEFAULT_UNREACT_MS);
  assert.equal(resolveUnreactMs(10), 200); // clamped up to the floor
  assert.equal(resolveUnreactMs(999999), 30000); // clamped down to the ceiling
  assert.equal(resolveUnreactMs(1500), 1500);
});

test('REACTION_CALL_RE matches bare and chained calls only', () => {
  assert.equal(REACTION_CALL_RE.test('reaction("su")'), true);
  assert.equal(REACTION_CALL_RE.test('$: reaction("su").fast(4)'), true);
  assert.equal(REACTION_CALL_RE.test('.reaction("su")'), true);
  assert.equal(REACTION_CALL_RE.test('s("bd sd")'), false);
  assert.equal(REACTION_CALL_RE.test('myReactionThing("su")'), false);
});
