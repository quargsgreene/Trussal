import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REACTIONS,
  REACTION_CALL_RE,
  resolveReaction,
  resolveUnreactMs,
  reactionSoundFileById,
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

test('every reaction maps to the Jitsi sound file it shipped with', () => {
  // Jitsi's own reactions/sounds.ts filenames. `heart` is Jitsi's "love" and
  // `clap` is Jitsi's "applause" — the ids differ, the sounds do not.
  assert.equal(reactionSoundFileById('like'), 'reactions-thumbs-up.mp3');
  assert.equal(reactionSoundFileById('surprised'), 'reactions-surprise.mp3');
  assert.equal(reactionSoundFileById('silence'), 'reactions-crickets.mp3');
  assert.equal(reactionSoundFileById('laugh'), 'reactions-laughter.mp3');
  assert.equal(reactionSoundFileById('boo'), 'reactions-boo.mp3');
  assert.equal(reactionSoundFileById('heart'), 'reactions-love.mp3');
  assert.equal(reactionSoundFileById('clap'), 'reactions-applause.mp3');
});

test('reactionSoundFileById is case-insensitive and null for unknowns', () => {
  assert.equal(reactionSoundFileById('LIKE'), 'reactions-thumbs-up.mp3');
  assert.equal(reactionSoundFileById('nope'), null);
  assert.equal(reactionSoundFileById(''), null);
  assert.equal(reactionSoundFileById(undefined), null);
});

test('every REACTIONS entry has a sound file', () => {
  for (const { id } of Object.values(REACTIONS)) {
    assert.ok(reactionSoundFileById(id), `no sound file for reaction id "${id}"`);
  }
});
