import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getConference,
  setConference,
  clearConference,
  hasInjectedConference,
  isInMeeting,
} from '../src/meeting-adapter.js';

// A document just rich enough for isInMeeting()'s DOM fallback.
function installDocument({ welcome = false, welcomeOverlay = false, premeeting = false, largeVideo = null } = {}) {
  const els = {};
  if (welcomeOverlay) els['trussal-welcome-overlay'] = {};
  if (largeVideo) els['largeVideoContainer'] = { getBoundingClientRect: () => largeVideo };
  globalThis.document = {
    body: { classList: { contains: (c) => c === 'welcome-page' && welcome } },
    getElementById: (id) => els[id] || null,
    querySelector: () => (premeeting ? {} : null),
  };
}

afterEach(() => { clearConference(); delete globalThis.document; });

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

test('isInMeeting: false with no conference and no DOM', () => {
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

test('isInMeeting: conference is authoritative over a stray pre-meeting screen', () => {
  setConference({ isJoined: () => true });
  installDocument({ premeeting: true });
  assert.equal(isInMeeting(), true);
});

test('isInMeeting: an unjoined conference falls back to the Jitsi large video', () => {
  setConference({ isJoined: () => false });
  installDocument({ largeVideo: { width: 100, height: 100 } });
  assert.equal(isInMeeting(), true);
});

test('isInMeeting: a zero-sized large video is not a meeting', () => {
  clearConference();
  installDocument({ largeVideo: { width: 0, height: 0 } });
  assert.equal(isInMeeting(), false);
});

test('isInMeeting: the welcome overlay means not in a meeting', () => {
  clearConference();
  installDocument({ welcomeOverlay: true, largeVideo: { width: 100, height: 100 } });
  assert.equal(isInMeeting(), false);
});

test('isInMeeting: a pre-meeting screen (prejoin/lobby) means not in a meeting', () => {
  clearConference();
  installDocument({ premeeting: true, largeVideo: { width: 100, height: 100 } });
  assert.equal(isInMeeting(), false);
});

test('isInMeeting: the welcome page body class means not in a meeting', () => {
  clearConference();
  installDocument({ welcome: true, largeVideo: { width: 100, height: 100 } });
  assert.equal(isInMeeting(), false);
});

test('isInMeeting: a conference whose isJoined throws degrades to the DOM', () => {
  setConference({ isJoined: () => { throw new Error('boom'); } });
  installDocument({ largeVideo: { width: 100, height: 100 } });
  assert.equal(isInMeeting(), true);
});
