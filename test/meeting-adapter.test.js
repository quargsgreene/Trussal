import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getConference,
  setConference,
  clearConference,
  hasInjectedConference,
  getMeetingRoom,
  isInMeeting,
} from '../src/meeting-adapter.js';

// With the Jitsi web app shell gone, the injected conference is the only
// authority for "in a meeting": there is no large-video element and no
// premeeting-screen DOM to fall back to.

afterEach(() => { clearConference(); });

test('meeting-adapter: no conference by default in Node', () => {
  clearConference();
  assert.equal(getConference(), null);
  assert.equal(hasInjectedConference(), false);
});

test('meeting-adapter: setConference injects a handle and takes precedence', () => {
  const fake = { id: 'lib-jitsi-1' };
  setConference(fake);
  assert.equal(getConference(), fake);
  assert.equal(hasInjectedConference(), true);
  clearConference();
  assert.equal(getConference(), null);
});

test('meeting-adapter: setConference(null) clears the injected handle', () => {
  setConference({ id: 'x' });
  setConference(null);
  assert.equal(getConference(), null);
  assert.equal(hasInjectedConference(), false);
  clearConference();
});

// --- isInMeeting -----------------------------------------------------------

test('isInMeeting: false with no conference', () => {
  clearConference();
  assert.equal(isInMeeting(), false);
});

test('isInMeeting: true once the injected conference reports joined', () => {
  setConference({ isJoined: () => true });
  assert.equal(isInMeeting(), true);
});

test('isInMeeting: true for a bare lib-jitsi conference (joined via _room)', () => {
  setConference({ _room: { isJoined: () => true } });
  assert.equal(isInMeeting(), true);
});

test('isInMeeting: an unjoined conference is not a meeting', () => {
  setConference({ isJoined: () => false });
  assert.equal(isInMeeting(), false);
});

test('isInMeeting: a conference whose isJoined throws is not a meeting', () => {
  setConference({ isJoined: () => { throw new Error('boom'); } });
  assert.equal(isInMeeting(), false);
});

test('meeting-adapter: getMeetingRoom resolves the track-owning object', () => {
  // Jitsi web wrapper: _room holds the lib-jitsi JitsiConference (addTrack).
  const webRoom = { addTrack: () => {} };
  setConference({ _room: webRoom });
  assert.equal(getMeetingRoom(), webRoom);

  // Bare lib-jitsi conference: IS the track-owning object itself.
  const bare = { addTrack: () => {} };
  setConference(bare);
  assert.equal(getMeetingRoom(), bare);

  // A conference whose own `.room` is its XMPP room (no track API) must not
  // win over the conference.
  setConference({ addTrack: () => {}, room: { getParticipants: () => [] } });
  assert.equal(getMeetingRoom(), getConference());
});

test('meeting-adapter: getMeetingRoom falls back to the conference when nothing has a track API', () => {
  const wrapper = { _room: { getParticipants: () => [] } };
  setConference(wrapper);
  assert.equal(getMeetingRoom(), wrapper._room);

  clearConference();
  assert.equal(getMeetingRoom(), null);
});

test('meeting-adapter: getMeetingRoom takes an explicit conference argument', () => {
  const room = { addTrack: () => {} };
  assert.equal(getMeetingRoom({ _room: room }), room);
});
