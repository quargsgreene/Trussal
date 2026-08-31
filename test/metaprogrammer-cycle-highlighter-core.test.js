import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  participantPositions, restPositions, elementPositions,
} from '../components/metaprogrammer-cycle-highlighter-core.js';

const DIR = "'metaprogram editor'\n";

// The span the highlighter would outline: the exact glyphs at [offset, offset+len).
function spans(text, type = 'participant') {
  return elementPositions(text, type).map(p => ({
    token: p.token, at: text.slice(p.offset, p.offset + p.len),
  }));
}

// --- mondo surface: parser columns already index this text -----------------

test('mondo <…>: each box lands on its own token', () => {
  assert.deepEqual(spans(DIR + '$ participants <0 1 2>\n'), [
    { token: '0', at: '0' }, { token: '1', at: '1' }, { token: '2', at: '2' },
  ]);
});

test('mondo: a glued postfix operator is inside the box', () => {
  assert.deepEqual(spans(DIR + '$ participants <0@2 10!3 2a?>\n'), [
    { token: '0', at: '0@2' }, { token: '10', at: '10!3' }, { token: '2a', at: '2a?' },
  ]);
});

test('mondo (cat …) s-expression: boxes still land on the tokens', () => {
  assert.deepEqual(spans(DIR + '$ participants (cat 0 1a 2zzz)\n'), [
    { token: '0', at: '0' }, { token: '1a', at: '1a' }, { token: '2zzz', at: '2zzz' },
  ]);
});

test('mondo rests are outlined in their own index space', () => {
  assert.deepEqual(spans(DIR + '$ participants <0 ~ 1 ~>\n', 'rest'), [
    { token: '~', at: '~' }, { token: '~', at: '~' },
  ]);
});

// --- mini surface: parser columns index the LOWERED string, not this text --

test('mini $: participants("<…>"): boxes land on the real tokens, not the "("', () => {
  const src = DIR + '$: participants("<0 1 2>")\n';
  assert.deepEqual(spans(src), [
    { token: '0', at: '0' }, { token: '1', at: '1' }, { token: '2', at: '2' },
  ]);
});

test('mini: a chained .method() (which shifts the lowered lines) does not move the boxes', () => {
  const src = DIR + '$: participants("<0 1 2>").cycles("wcl", 10).room("wcl", 30)\n';
  assert.deepEqual(spans(src), [
    { token: '0', at: '0' }, { token: '1', at: '1' }, { token: '2', at: '2' },
  ]);
});

test('mini: multi-line chain', () => {
  const src = DIR + '$: participants("<0 1>")\n  .cycles("wcl", 10)\n  .room("wcl", 30)\n';
  assert.deepEqual(spans(src), [{ token: '0', at: '0' }, { token: '1', at: '1' }]);
});

test('mini [ … ] subdivision', () => {
  assert.deepEqual(spans(DIR + '$: participants("[0 1a 2zzz]")\n'), [
    { token: '0', at: '0' }, { token: '1a', at: '1a' }, { token: '2zzz', at: '2zzz' },
  ]);
});

test('mini: glued postfix operators are inside the box; a trailing group rate is not a token', () => {
  assert.deepEqual(spans(DIR + '$: participants("<0@2 10!3 2a?>*2")\n'), [
    { token: '0', at: '0@2' }, { token: '10', at: '10!3' }, { token: '2a', at: '2a?' },
  ]);
});

test('mini: a nested group and its own rate', () => {
  // 0, then the inner pair 1 2 — the inner `*2` rate is not mistaken for a token.
  assert.deepEqual(spans(DIR + '$: participants("<0 [1 2]*2>")\n'), [
    { token: '0', at: '0' }, { token: '1', at: '1' }, { token: '2', at: '2' },
  ]);
});

test('mini: rests are found in their own index space, spans exclude participants', () => {
  const src = DIR + '$: participants("<0 ~ 1 _>")\n';
  assert.deepEqual(spans(src, 'rest'), [{ token: '~', at: '~' }, { token: '_', at: '_' }]);
  assert.deepEqual(spans(src, 'participant'), [{ token: '0', at: '0' }, { token: '1', at: '1' }]);
});

test('mini: offsets are real indices into the given text', () => {
  const src = DIR + 'lead\n$: participants("<7 42>")\n';
  for (const p of participantPositions(src)) {
    assert.equal(src.slice(p.offset, p.offset + p.len), p.token);
  }
  assert.equal(restPositions(src).length, 0);
});

test('a program with no scheduling sequence yields no positions', () => {
  assert.deepEqual(participantPositions(DIR + '# cycles "wcl" 10\n'), []);
  assert.deepEqual(participantPositions(DIR + '$: cycles("wcl", 10)\n'), []);
});

test('a recoverable parse error still outlines the token the parser kept', () => {
  // `<0 @1>` — the un-glued `@` is a syntax error the parser recovers from,
  // keeping element 0; the highlighter should still be able to box it.
  assert.deepEqual(spans(DIR + '$: participants("<0 @1>")\n'), [{ token: '0', at: '0' }]);
});
