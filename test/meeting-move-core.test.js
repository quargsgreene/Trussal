import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEETING_CALL_RE,
  SETTLE_MS,
  parseMeetingLiteral,
  validateMeetingLiteral,
  rewriteMeetingCalls,
  meetingUrl,
  planMeetingMove,
  matchHome,
  isNewer,
} from '../src/meeting-move-core.js';
import { skipPrejoin } from '../src/skip-prejoin.js';
import { rewriteBreakoutCalls } from '../src/breakout-core.js';

// --- literals ----------------------------------------------------------------

test('validateMeetingLiteral lowercases the meeting and normalizes participants', () => {
  const spec = validateMeetingLiteral({ name: ' Jam2 ', participants: ['0', 1, '0'] });
  assert.deepEqual(spec, { name: 'jam2', participants: ['0', '1'] });
});

test('validateMeetingLiteral rejects a name that is not a URL path segment', () => {
  assert.throws(() => validateMeetingLiteral({ name: 'a b' }), /not a meeting name/);
  assert.throws(() => validateMeetingLiteral({ name: 'a/b' }), /not a meeting name/);
  assert.throws(() => validateMeetingLiteral({}), /name/);
});

test('a pattern of meeting names is accepted whole and checked once minted', () => {
  assert.equal(validateMeetingLiteral({ name: '<Jam2 main>' }).name, '<Jam2 main>');
});

test('parseMeetingLiteral surfaces a JSON error', () => {
  assert.throws(() => parseMeetingLiteral('{name: x}'), /meeting\(\): not valid JSON/);
});

// --- rewriting ---------------------------------------------------------------

test('MEETING_CALL_RE matches meeting() but not a longer name', () => {
  assert.equal(MEETING_CALL_RE.test('$: meeting({"name":"x"})'), true);
  assert.equal(MEETING_CALL_RE.test('$: s("bd").premeeting()'), false);
});

test('rewriteMeetingCalls mints one token per meeting and attaches its renderer', () => {
  const { code, atoms } = rewriteMeetingCalls('$: meeting({"name":"<Jam2 main ~>", "participants": ["1"]}).slow(2)', { peer: 'p' });
  assert.equal(code, '$: meeting("<mt0 mt1 ~>").slow(2)\n._mtRender()');
  assert.deepEqual(parseMeetingLiteral(atoms.mt0.text), { name: 'jam2', participants: ['1'] });
  assert.deepEqual(parseMeetingLiteral(atoms.mt1.text), { name: 'main', participants: ['1'] });
  assert.equal(atoms.mt0.peer, 'p');
});

test('breakout and meeting rewrites leave each other alone', () => {
  const src = '$: breakout({"name":"r"})\n\n$: meeting({"name":"m"})';
  assert.match(rewriteBreakoutCalls(src).code, /meeting\(\{"name":"m"\}\)/);
  assert.match(rewriteMeetingCalls(src).code, /breakout\(\{"name":"r"\}\)/);
});

// --- URLs --------------------------------------------------------------------

test('skipPrejoin turns the prejoin screen off and keeps other overrides', () => {
  assert.equal(skipPrejoin('https://x.org/jam1'), 'https://x.org/jam1#config.prejoinConfig.enabled=false');
  assert.equal(
    skipPrejoin('https://x.org/jam1#config.prejoinConfig.enabled=true&config.startWithAudioMuted=true'),
    'https://x.org/jam1#config.startWithAudioMuted=true&config.prejoinConfig.enabled=false',
  );
});

test('meetingUrl swaps the last path segment, keeps query and hash, skips prejoin', () => {
  assert.equal(
    meetingUrl('https://x.org/app/Jam1?lang=en#config.startWithVideoMuted=true', 'jam2'),
    'https://x.org/app/jam2?lang=en#config.startWithVideoMuted=true&config.prejoinConfig.enabled=false',
  );
  assert.equal(meetingUrl('https://x.org/', 'jam2'), 'https://x.org/jam2#config.prejoinConfig.enabled=false');
  assert.equal(
    meetingUrl('https://x.org/jam1#config.prejoinConfig.enabled=true', 'jam2'),
    'https://x.org/jam2#config.prejoinConfig.enabled=false',
  );
});

// --- planning ----------------------------------------------------------------

const NOW = 1_000_000;
const req = (name, participants, origin = 'jam1', at = 100) => ({ spec: { name, participants }, origin, at });

test('a participant named from its own meeting moves and remembers it as home', () => {
  const plan = planMeetingMove(req('jam2', ['1']), { meeting: 'jam1', token: '1' }, NOW);
  assert.equal(plan.move, 'jam2');
  assert.deepEqual(plan.home, { meeting: 'jam1', token: '1' });
});

test('a participant not named, or named from another meeting, stays put silently', () => {
  assert.deepEqual(planMeetingMove(req('jam2', ['0']), { meeting: 'jam1', token: '1' }, NOW), { move: null, home: null, retryAt: null, why: null });
  assert.equal(planMeetingMove(req('jam2', ['1'], 'other'), { meeting: 'jam1', token: '1' }, NOW).move, null);
});

test('"main" brings a moved participant home by its home token', () => {
  const self = { meeting: 'jam2', token: '4', home: { meeting: 'jam1', token: '1' }, arrivedAt: NOW - SETTLE_MS };
  const plan = planMeetingMove(req('main', ['1']), self, NOW);
  assert.equal(plan.move, 'jam1');
  assert.deepEqual(plan.home, { meeting: 'jam1', token: '1' });
  // Its token in jam2 means nothing to jam1's patterns.
  assert.equal(planMeetingMove(req('main', ['4']), self, NOW).move, null);
});

test('already there, exempt, or still settling in: no move', () => {
  const base = { meeting: 'jam1', token: '1' };
  assert.equal(planMeetingMove(req('main', ['1']), base, NOW).why, 'already there');
  assert.equal(planMeetingMove(req('jam2', ['1']), { ...base, exempt: true }, NOW).why, 'pressed the panic button');
});

test('a request arriving while settling in is held until the settle time, not dropped', () => {
  const plan = planMeetingMove(req('jam2', ['1']), { meeting: 'jam1', token: '1', arrivedAt: NOW - 1000 }, NOW);
  assert.equal(plan.move, null);
  assert.equal(plan.why, 'still settling in');
  assert.equal(plan.retryAt, NOW - 1000 + SETTLE_MS);
});

// --- conflicting assignments -------------------------------------------------

test('isNewer compares sidecar stamps, and anything stamped beats no stamp', () => {
  assert.equal(isNewer({ at: 5 }, { at: 4 }), true);
  assert.equal(isNewer({ at: 4 }, { at: 4 }), false);
  assert.equal(isNewer({ at: 3 }, 4), false);
  assert.equal(isNewer({ at: 3 }, null), true);
  assert.equal(isNewer({}, null), false);
});

test('a request no newer than the last one obeyed is superseded', () => {
  const self = { meeting: 'jam2', token: '4', home: { meeting: 'jam1', token: '1' }, lastAt: 200 };
  assert.equal(planMeetingMove(req('main', ['1'], 'jam1', 150), self, NOW).why, 'superseded by a newer request');
  assert.equal(planMeetingMove(req('main', ['1'], 'jam1', 200), self, NOW).why, 'superseded by a newer request');
  assert.equal(planMeetingMove(req('main', ['1'], 'jam1', 201), self, NOW).move, 'jam1');
});

test('matchHome: the same participant named from two meetings, by a different token in each', () => {
  const self = { meeting: 'jam2', token: '4', home: { meeting: 'jam1', token: '1' } };
  assert.deepEqual(matchHome(req('jam3', ['1'], 'jam1'), self), { meeting: 'jam1', token: '1' });
  assert.deepEqual(matchHome(req('jam5', ['4'], 'jam2'), self), { meeting: 'jam2', token: '4' });
  assert.equal(matchHome(req('jam5', ['1'], 'jam2'), self), null);
});

test('a move requested from the meeting it is in now replaces its home', () => {
  const self = { meeting: 'jam2', token: '4', home: { meeting: 'jam1', token: '1' } };
  const plan = planMeetingMove(req('jam3', ['4'], 'jam2'), self, NOW);
  assert.equal(plan.move, 'jam3');
  assert.deepEqual(plan.home, { meeting: 'jam2', token: '4' });
});
