import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REACTIONS,
  REACTION_CALL_RE,
  resolveReaction,
  resolveUnreactMs,
  DEFAULT_UNREACT_MS,
} from '../src/reactions-core.js';

test('resolveReaction accepts the abbreviation or Jitsi\'s own id, case-insensitively', () => {
  assert.equal(resolveReaction('su').id, 'surprised');
  assert.equal(resolveReaction('SU').id, 'surprised');
  assert.equal(resolveReaction('surprised').id, 'surprised');
  assert.equal(resolveReaction('nope'), null);
  assert.equal(resolveReaction(''), null);
  assert.equal(resolveReaction(undefined), null);
});

// Regression guard for the "reactions silently stop working" bug: Jitsi's
// reactions middleware throws on any id it does not know (its
// getReactionMessageFromBuffer reads REACTIONS[reaction].message), which wedges
// the shared buffer and swallows every later reaction. Every id here MUST be
// one of Jitsi's own reaction ids (react/features/reactions/constants.ts).
test('every REACTIONS id is a real Jitsi reaction id', () => {
  const JITSI_REACTION_IDS = new Set([
    'like', 'clap', 'laugh', 'surprised', 'boo', 'silence', 'love',
  ]);

  for (const [abbrev, reaction] of Object.entries(REACTIONS)) {
    assert.ok(JITSI_REACTION_IDS.has(reaction.id),
      `abbreviation ${abbrev} maps to "${reaction.id}", which is not a Jitsi reaction id`);
  }
  // The heart reaction specifically: Jitsi calls it `love`, not `heart`.
  assert.equal(resolveReaction('h').id, 'love');
  assert.equal(resolveReaction('heart'), null);
  assert.equal(resolveReaction('love').id, 'love');
});

test('REACTION_CALL_RE matches bare and chained calls only', () => {
  assert.equal(REACTION_CALL_RE.test('reaction("su")'), true);
  assert.equal(REACTION_CALL_RE.test('$: reaction("su").fast(4)'), true);
  assert.equal(REACTION_CALL_RE.test('.reaction("su")'), true);
  assert.equal(REACTION_CALL_RE.test('s("bd sd")'), false);
  assert.equal(REACTION_CALL_RE.test('myReactionThing("su")'), false);
});
