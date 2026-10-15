import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageInstallMeetingAccessor, pageConferenceReady } from '../src/bot/page-scripts.js';

/**
 * The page-side halves of the backend seam (window.__trussalConf/__trussalRoom)
 * and the join-wait predicate. Installed at document-start by the bots, they are
 * what lets every page script resolve "the meeting" without reaching for
 * window.APP — so the same scripts survive a swap to a bare lib-jitsi-meet
 * deployment, which never defines window.APP at all.
 *
 * Each case pins one half of the resolution rule against a fresh fake window:
 *  - the bundle's injected conference (exposed as __trussalGetConference) wins;
 *  - window.APP.conference is the fallback for the Jitsi web backend;
 *  - __trussalRoom is capability-checked, so a conference's own XMPP `.room`
 *    (no addTrack) never displaces the conference itself.
 */
function withWindow({ bundleConference = null, app = undefined } = {}) {
  globalThis.window = {};
  if (bundleConference) globalThis.window.__trussalGetConference = () => bundleConference;
  if (app !== undefined) globalThis.APP = app; else delete globalThis.APP;
  pageInstallMeetingAccessor();
  return globalThis.window;
}

test('pageInstallMeetingAccessor: prefers the bundle-injected conference (lib-jitsi backend)', () => {
  const win = withWindow({ bundleConference: { id: 'bare' }, app: { conference: { id: 'web' } } });
  assert.equal(win.__trussalConf(), globalThis.window.__trussalGetConference());
  delete globalThis.window;
  delete globalThis.APP;
});

test('pageInstallMeetingAccessor: falls back to window.APP.conference (Jitsi web backend)', () => {
  const webConf = { _room: {} };
  withWindow({ app: { conference: webConf } });
  assert.equal(globalThis.window.__trussalConf(), webConf);
  delete globalThis.window;
  delete globalThis.APP;
});

test('pageInstallMeetingAccessor: __trussalRoom picks _room for a Jitsi web wrapper', () => {
  const room = { addTrack() {}, getParticipants: () => [] };
  withWindow({ app: { conference: { _room: room } } });
  assert.equal(globalThis.window.__trussalRoom(), room);
  delete globalThis.window;
  delete globalThis.APP;
});

test('pageInstallMeetingAccessor: __trussalRoom returns the conference for a bare JitsiConference', () => {
  const bare = { addTrack() {}, getParticipants: () => [] };
  withWindow({ bundleConference: bare });
  assert.equal(globalThis.window.__trussalRoom(), bare);
  delete globalThis.window;
  delete globalThis.APP;
});

test('pageInstallMeetingAccessor: __trussalRoom never prefers a conference\'s XMPP .room', () => {
  const xmppRoom = { getParticipants: () => [] }; // no addTrack/removeTrack
  const bare = { addTrack() {}, room: xmppRoom };
  withWindow({ bundleConference: bare });
  assert.equal(globalThis.window.__trussalRoom(), bare);
  delete globalThis.window;
  delete globalThis.APP;
});

test('pageInstallMeetingAccessor: is idempotent per document', () => {
  withWindow({ app: { conference: {} } });
  globalThis.window.__trussalConf = 'patched'; // a sentinel a second install must not overwrite
  pageInstallMeetingAccessor();
  assert.equal(globalThis.window.__trussalConf, 'patched', 'a second install must not clobber the first');
  delete globalThis.window;
  delete globalThis.APP;
});

test('pageConferenceReady: true once the Jitsi web app has settled', () => {
  globalThis.window = {};
  globalThis.APP = {};
  assert.equal(pageConferenceReady(), true);
  delete globalThis.window;
  delete globalThis.APP;
});

test('pageConferenceReady: true once a bare lib-jitsi conference has joined', () => {
  globalThis.window = { __trussalGetConference: () => ({ isJoined: () => true }) };
  delete globalThis.APP;
  assert.equal(pageConferenceReady(), true);
  delete globalThis.window;
});

test('pageConferenceReady: false before either backend is up', () => {
  globalThis.window = {};
  delete globalThis.APP;
  assert.equal(pageConferenceReady(), false);
  delete globalThis.window;
});
