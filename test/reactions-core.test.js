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

test('REACTION_CALL_RE matches bare and chained calls only', () => {
  assert.equal(REACTION_CALL_RE.test('reaction("su")'), true);
  assert.equal(REACTION_CALL_RE.test('$: reaction("su").fast(4)'), true);
  assert.equal(REACTION_CALL_RE.test('.reaction("su")'), true);
  assert.equal(REACTION_CALL_RE.test('s("bd sd")'), false);
  assert.equal(REACTION_CALL_RE.test('myReactionThing("su")'), false);
});
