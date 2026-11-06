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
import { keepMatchingStatements } from '../src/silent-voice-core.js';

// The path of a remote peer excluded in aggregator mode: its audio is dropped
// but its poll must still reach the room. A blank line in the JSON is not a
// paragraph break; split there, the kept half is a syntax error.
test('keepMatchingStatements keeps a poll() whole when its JSON holds a blank line', () => {
  const literal = '{\n  "question": "Which?",\n\n  "options": ["A", "B"]\n}';
  const poll = `$: poll(\`${literal}\`)`;
  assert.equal(keepMatchingStatements(`$: s("bd")\n\n${poll}`, POLL_CALL_RE), poll);

  const { code, atoms } = rewritePollCalls(poll);
  assert.equal(code, '$: poll("pl0")\n._pollRender()');
  assert.equal(parsePollLiteral(atoms.pl0.text).question, 'Which?');
});

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
