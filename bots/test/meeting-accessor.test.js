import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageInstallMeetingAccessor, pageConferenceReady } from '../src/bot/page-scripts.js';

/**
 * The page-side halves of the backend seam (window.__trussalConf/__trussalRoom)
 * and the join-wait predicate. Installed at document-start by the bots, they are
 * what lets every page script resolve "the meeting". There is exactly one
 * backend: the lib-jitsi-meet conference the Trussal bundle injects and exposes
 * as __trussalGetConference. The Jitsi web app shell that serves the page never
 * joins, so there is no window.APP conference to reach for.
 *
 * Each case pins one half of the resolution rule against a fresh fake window:
 *  - the bundle's injected conference is the one and only conference;
 *  - with none injected, the accessor returns null;
 *  - __trussalRoom is capability-checked, so a conference's own XMPP `.room`
 *    (no addTrack) never displaces the conference itself.
 */
function withWindow({ bundleConference = null } = {}) {
  globalThis.window = {};
  if (bundleConference) globalThis.window.__trussalGetConference = () => bundleConference;
  pageInstallMeetingAccessor();
  return globalThis.window;
}

test('pageInstallMeetingAccessor: resolves the bundle-injected conference (lib-jitsi backend)', () => {
  const bare = { id: 'bare' };
  const win = withWindow({ bundleConference: bare });
  assert.equal(win.__trussalConf(), bare);
  delete globalThis.window;
});

test('pageInstallMeetingAccessor: returns null before any conference is injected', () => {
  const win = withWindow();
  assert.equal(win.__trussalConf(), null);
  delete globalThis.window;
});

test('pageInstallMeetingAccessor: __trussalRoom picks _room for a conference wrapper', () => {
  const room = { addTrack() {}, getParticipants: () => [] };
  withWindow({ bundleConference: { _room: room } });
  assert.equal(globalThis.window.__trussalRoom(), room);
  delete globalThis.window;
});

test('pageInstallMeetingAccessor: __trussalRoom returns the conference for a bare JitsiConference', () => {
  const bare = { addTrack() {}, getParticipants: () => [] };
  withWindow({ bundleConference: bare });
  assert.equal(globalThis.window.__trussalRoom(), bare);
  delete globalThis.window;
});

test('pageInstallMeetingAccessor: __trussalRoom never prefers a conference\'s XMPP .room', () => {
  const xmppRoom = { getParticipants: () => [] }; // no addTrack/removeTrack
  const bare = { addTrack() {}, room: xmppRoom };
  withWindow({ bundleConference: bare });
  assert.equal(globalThis.window.__trussalRoom(), bare);
  delete globalThis.window;
});

test('pageInstallMeetingAccessor: is idempotent per document', () => {
  withWindow({ bundleConference: { addTrack() {} } });
  globalThis.window.__trussalConf = 'patched'; // a sentinel a second install must not overwrite
  pageInstallMeetingAccessor();
  assert.equal(globalThis.window.__trussalConf, 'patched', 'a second install must not clobber the first');
  delete globalThis.window;
});

test('pageConferenceReady: true once the lib-jitsi conference has joined', () => {
  globalThis.window = { __trussalGetConference: () => ({ isJoined: () => true }) };
  assert.equal(pageConferenceReady(), true);
  delete globalThis.window;
});

test('pageConferenceReady: false before the conference is up', () => {
  globalThis.window = {};
  assert.equal(pageConferenceReady(), false);
  delete globalThis.window;
});
