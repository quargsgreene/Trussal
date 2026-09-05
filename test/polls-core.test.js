import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePollLiteral,
  validatePollLiteral,
  canVote,
  applyVoteDelta,
  switchVote,
  rewritePollCalls,
  hasPollCycles,
  POLL_CALL_RE,
} from '../src/polls-core.js';

test('parsePollLiteral rejects malformed JSON with a clear error', () => {
  assert.throws(() => parsePollLiteral('{question: "no quotes on the key"}'), /not valid JSON/);
});

test('validatePollLiteral normalizes a minimal poll', () => {
  const spec = validatePollLiteral({ question: 'Is water wet?', options: ['yes', 'no', 'maybe'] });
  assert.equal(spec.question, 'Is water wet?');
  assert.deepEqual(spec.options, ['yes', 'no', 'maybe']);
  assert.deepEqual(spec.participants, []);
  assert.deepEqual(spec.tally, { yes: 0, no: 0, maybe: 0 });
});

test('validatePollLiteral accepts a flat votes object (the shape every example writes)', () => {
  const spec = validatePollLiteral({
    question: 'Is water wet?',
    options: ['yes', 'no', 'maybe'],
    votes: { yes: 2, no: 3, maybe: 0 },
    participants: ['0a', '1'],
  });
  assert.deepEqual(spec.tally, { yes: 2, no: 3, maybe: 0 });
  assert.deepEqual(spec.participants, ['0a', '1']);
});

test('validatePollLiteral also accepts the documented array-of-objects votes shape', () => {
  const spec = validatePollLiteral({ question: 'Q', options: ['a', 'b'], votes: [{ a: 1 }, { b: 2 }] });
  assert.deepEqual(spec.tally, { a: 1, b: 2 });
});

test('validatePollLiteral rejects missing question/options', () => {
  assert.throws(() => validatePollLiteral({ options: ['a'] }), /question/);
  assert.throws(() => validatePollLiteral({ question: 'Q' }), /options/);
  assert.throws(() => validatePollLiteral({ question: 'Q', options: [] }), /options/);
  assert.throws(() => validatePollLiteral({ question: 'Q', options: ['a', 'a'] }), /repeat/);
});

test('validatePollLiteral rejects a vote for an option that does not exist', () => {
  assert.throws(() => validatePollLiteral({ question: 'Q', options: ['a'], votes: { b: 1 } }), /not in "options"/);
});

test('canVote: empty participants means anyone may vote', () => {
  const spec = validatePollLiteral({ question: 'Q', options: ['a'] });
  assert.equal(canVote(spec, '0'), true);
  assert.equal(canVote(spec, 'anyone'), true);
});

test('canVote: a non-empty participants list is an allowlist', () => {
  const spec = validatePollLiteral({ question: 'Q', options: ['a'], participants: ['0a', '1'] });
  assert.equal(canVote(spec, '0a'), true);
  assert.equal(canVote(spec, '1'), true);
  assert.equal(canVote(spec, '2'), false);
});

test('applyVoteDelta adds and never mutates the input, floors at zero', () => {
  const tally = { yes: 1, no: 0 };
  const next = applyVoteDelta(tally, { yes: 2, no: -5 });
  assert.deepEqual(tally, { yes: 1, no: 0 });
  assert.deepEqual(next, { yes: 3, no: 0 });
});

test('switchVote moves one vote from the old option to the new one', () => {
  const tally = { yes: 2, no: 1 };
  assert.deepEqual(switchVote(tally, 'yes', 'no'), { yes: 1, no: 2 });
  assert.deepEqual(switchVote(tally, null, 'yes'), { yes: 3, no: 1 });
});

test('rewritePollCalls mints the whole JSON blob as one atom, braces and all', () => {
  const code = '$: poll(\'{"question":"Is water wet?","options":["yes","no"]}\').close(1000)';
  const { code: out, atoms } = rewritePollCalls(code, { peer: 'jit-1' });
  assert.match(out, /\$: poll\("pl0"\)\.close\(1000\)\n\._pollRender\(\)/);
  assert.equal(atoms.pl0.text, '{"question":"Is water wet?","options":["yes","no"]}');
  assert.equal(atoms.pl0.peer, 'jit-1');
});

test('rewritePollCalls also mints a chained vote() argument', () => {
  const code = '$: poll(\'{"question":"Q","options":["yes","no"]}\').vote(\'{"yes":3}\')';
  const { code: out, atoms } = rewritePollCalls(code);
  assert.match(out, /\.vote\("pl1"\)/);
  assert.equal(atoms.pl1.text, '{"yes":3}');
});

test('POLL_CALL_RE / hasPollCycles', () => {
  assert.equal(POLL_CALL_RE.test('poll("x")'), true);
  assert.equal(POLL_CALL_RE.test('s("bd sd")'), false);
  assert.equal(hasPollCycles('await initPolls()\n\n$: poll("x")'), true);
  assert.equal(hasPollCycles('$: poll("x")'), false);
});
