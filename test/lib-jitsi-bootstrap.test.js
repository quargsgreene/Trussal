// lib-jitsi-bootstrap is the one place Trussal builds a bare lib-jitsi-meet
// conference and injects it into meeting-adapter. These tests drive it with a
// fake JitsiMeetJS (no network, no browser) and assert the contract the rest of
// the migration depends on: there is no opt-out (every client joins through
// here), a joined conference is injected, the microphone is published through
// the backend-neutral seam, and every failure path clears the injected
// conference rather than leaving it dangling.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectLibJitsiConference, maybeBootstrapLibJitsi } from '../src/lib-jitsi-bootstrap.js';
import { getConference, clearConference } from '../src/meeting-adapter.js';
import { hasPublishedAudioTrack, getPublishedAudioTrack, resetPublishedAudio } from '../src/published-audio.js';

// --- fake JitsiMeetJS -------------------------------------------------------

function fakeJitsiMeetJS({ failConnect = false } = {}) {
  const events = {
    connection: {
      CONNECTION_ESTABLISHED: 'connection.established',
      CONNECTION_FAILED: 'connection.failed',
      CONNECTION_DISCONNECTED: 'connection.disconnected',
    },
    conference: {
      CONFERENCE_JOINED: 'conference.joined',
      CONFERENCE_LEFT: 'conference.left',
    },
  };

  const localTracks = [];
  const jitsiTrack = { kind: 'audio', isAudioTrack: () => true, isVideoTrack: () => false };
  const created = [];

  class FakeConnection {
    constructor() { this._listeners = {}; }
    addEventListener(name, cb) { (this._listeners[name] ||= []).push(cb); }
    _emit(name, arg) { for (const cb of this._listeners[name] || []) cb(arg); }
    connect() {
      setTimeout(() => {
        if (failConnect) this._emit(events.connection.CONNECTION_FAILED, new Error('nope'));
        else this._emit(events.connection.CONNECTION_ESTABLISHED);
      }, 0);
    }
    disconnect() {}
    initJitsiConference(room, options) {
      const conf = {
        // A real JitsiConference parks its XMPP room on `room`; it has no track
        // API, so the publisher must resolve the conference itself, not this.
        room: { name: room, addListener() {}, muteParticipant() {} },
        options,
        getLocalTracks: () => localTracks.slice(),
        getLocalAudioTrack: () => localTracks.find((t) => t.isAudioTrack()) || null,
        addTrack(t) { localTracks.push(t); },
        _displayNames: [],
        setDisplayName(name) { this._displayNames.push(name); },
        _listeners: {},
        addEventListener(name, cb) { (this._listeners[name] ||= []).push(cb); },
        _emit(name) { for (const cb of this._listeners[name] || []) cb(); },
        join() { setTimeout(() => this._emit(events.conference.CONFERENCE_JOINED), 0); },
        isJoined() { return true; },
      };
      return conf;
    }
  }

  return {
    events,
    JitsiConnection: FakeConnection,
    jitsiTrack,
    localTracks,
    created,
    init() {},
    async createLocalTracks(options) {
      created.push(options);
      return [jitsiTrack];
    },
  };
}

function installWindow({ jitsi, config = {}, location = {} } = {}) {
  globalThis.window = {
    config,
    location: { hostname: 'meet.example', search: '', hash: '', pathname: '/', ...location },
  };
  if (jitsi) globalThis.window.JitsiMeetJS = jitsi;
}

const BASE_CONFIG = {
  hosts: { domain: 'meet.example', muc: 'muc.meet.example', focus: 'focus.meet.example' },
  roomName: 'room1',
};

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(predicate, { attempts = 100, intervalMs = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

beforeEach(() => { clearConference(); resetPublishedAudio(); });
afterEach(() => { clearConference(); resetPublishedAudio(); delete globalThis.window; });

// --- no opt-out ------------------------------------------------------------

test('bootstrap: the legacy opt-outs cannot switch lib-jitsi-meet off', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: BASE_CONFIG, location: { search: '?libjitsi=0' } });
  // Left over from the escape hatch the migration dropped. Whatever they are
  // set to, the bot must still join through lib-jitsi-meet.
  globalThis.window.__TRUSSAL_USE_LIB_JITSI = false;
  globalThis.window.__trussalIsBot = true;

  const conf = await maybeBootstrapLibJitsi({ renderPrejoinFn: async () => 'x' });
  assert.ok(conf, 'the bot still joins through lib-jitsi-meet');
  assert.ok(await waitFor(() => getConference() === conf));
});

// --- connect / join --------------------------------------------------------

test('bootstrap: joins, injects the conference, and publishes the mic', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: BASE_CONFIG });

  const conf = await connectLibJitsiConference();
  assert.ok(conf, 'a conference object is returned');
  assert.equal(conf.room.name, 'room1');

  assert.ok(await waitFor(() => getConference() === conf), 'the conference is injected on join');
  assert.ok(await waitFor(() => hasPublishedAudioTrack()), 'the microphone is published on join');
  assert.equal(getPublishedAudioTrack(), jitsi.jitsiTrack);
  assert.deepEqual(jitsi.created, [{ devices: ['audio'] }], 'only the mic was created');
});

test('bootstrap: startWithAudioMuted leaves the microphone unpublished', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: { ...BASE_CONFIG, startWithAudioMuted: true } });

  const conf = await connectLibJitsiConference();
  assert.ok(await waitFor(() => getConference() === conf));
  await delay(30);
  assert.equal(hasPublishedAudioTrack(), false);
  assert.deepEqual(jitsi.created, []);
});

test('bootstrap: startWithVideoMuted is forwarded to the conference', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: { ...BASE_CONFIG, startWithVideoMuted: true } });
  const conf = await connectLibJitsiConference();
  assert.equal(conf.options.startWithVideoMuted, true);
  // The join handler's mic publish is fire-and-forget; let it settle so it
  // cannot leak into the next test's module state.
  assert.ok(await waitFor(() => getConference() === conf));
  await waitFor(() => hasPublishedAudioTrack());
});

test('bootstrap: resolves the room from the URL path, lowercased like the sidecar', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({
    jitsi,
    config: { hosts: BASE_CONFIG.hosts, startWithAudioMuted: true },
    location: { pathname: '/MyRoom' },
  });
  const conf = await connectLibJitsiConference();
  assert.equal(conf.room.name, 'myroom');
});

test('bootstrap: an explicit room override wins over the URL path', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({
    jitsi,
    config: { hosts: BASE_CONFIG.hosts, startWithAudioMuted: true },
    location: { pathname: '/from-path' },
  });
  const conf = await connectLibJitsiConference({ room: 'explicit' });
  assert.equal(conf.room.name, 'explicit');
});

// --- failure paths ---------------------------------------------------------

test('bootstrap: missing domain/room returns null without connecting', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: {}, location: { hostname: '', search: '', hash: '' } });
  assert.equal(await connectLibJitsiConference(), null);
  assert.equal(getConference(), null);
  assert.deepEqual(jitsi.created, []);
});

test('bootstrap: a failed connection returns null and injects nothing', async () => {
  const jitsi = fakeJitsiMeetJS({ failConnect: true });
  installWindow({ jitsi, config: BASE_CONFIG });
  assert.equal(await connectLibJitsiConference(), null);
  assert.equal(getConference(), null);
  assert.equal(hasPublishedAudioTrack(), false);
});

// --- display name ----------------------------------------------------------

test('bootstrap: sets the display name on the conference once joined', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: BASE_CONFIG });
  const conf = await connectLibJitsiConference({ displayName: 'Ada Lovelace' });
  assert.ok(await waitFor(() => conf._displayNames.includes('Ada Lovelace')));
});

test('bootstrap: a blank display name is trimmed away and never sent', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: BASE_CONFIG });
  const conf = await connectLibJitsiConference({ displayName: '   ' });
  assert.ok(await waitFor(() => getConference() === conf));
  await delay(20);
  assert.deepEqual(conf._displayNames, []);
});

test('bootstrap: without a prejoin name, the meeting URL names the participant', async () => {
  const jitsi = fakeJitsiMeetJS();
  // jitsiRoomUrl writes the name quoted in the fragment: userInfo.displayName="…"
  installWindow({
    jitsi,
    config: BASE_CONFIG,
    location: { hash: '#config.startWithAudioMuted=false&userInfo.displayName="Ada%20Lovelace"' },
  });
  const conf = await connectLibJitsiConference();
  assert.ok(await waitFor(() => conf._displayNames.includes('Ada Lovelace')));
});

test('bootstrap: an explicit (blank) prejoin name suppresses the URL fallback', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({
    jitsi,
    config: BASE_CONFIG,
    location: { hash: '#userInfo.displayName="Ada"' },
  });
  const conf = await connectLibJitsiConference({ displayName: '   ' });
  assert.ok(await waitFor(() => getConference() === conf));
  await delay(20);
  assert.deepEqual(conf._displayNames, [], "the human's prejoin choice wins over the URL");
});

// --- prejoin handoff -------------------------------------------------------

test('maybeBootstrapLibJitsi: renders the prejoin and connects with the chosen name', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: BASE_CONFIG });

  let renderedWith = null;
  const conf = await maybeBootstrapLibJitsi({
    renderPrejoinFn: async (opts) => { renderedWith = opts; return 'Grace Hopper'; },
  });

  assert.deepEqual(renderedWith, { room: 'room1' }, 'the prejoin is handed the room');
  assert.ok(conf, 'a conference is started on submit');
  assert.ok(await waitFor(() => getConference() === conf));
  assert.ok(await waitFor(() => conf._displayNames.includes('Grace Hopper')));
});

test('maybeBootstrapLibJitsi: does nothing on a page with no room (welcome page)', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: { hosts: BASE_CONFIG.hosts }, location: { pathname: '/', hash: '' } });

  let rendered = false;
  const result = await maybeBootstrapLibJitsi({
    renderPrejoinFn: async () => { rendered = true; return 'x'; },
  });

  assert.equal(result, null);
  assert.equal(rendered, false, 'no prejoin is rendered before a room is chosen');
  assert.equal(getConference(), null);
});

test('maybeBootstrapLibJitsi: a bot skips the prejoin and joins with the URL name', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({
    jitsi,
    config: BASE_CONFIG,
    location: { hash: '#userInfo.displayName="Bloodhound"' },
  });
  globalThis.window.__trussalIsBot = true;

  let rendered = false;
  const conf = await maybeBootstrapLibJitsi({
    renderPrejoinFn: async () => { rendered = true; return 'x'; },
  });

  assert.equal(rendered, false, 'the prejoin is never shown to a bot');
  assert.ok(conf);
  assert.ok(await waitFor(() => getConference() === conf));
  assert.ok(await waitFor(() => conf._displayNames.includes('Bloodhound')), 'the bot keeps its breed identity under lib-jitsi-meet');
});

test('maybeBootstrapLibJitsi: the aggregator skips the prejoin too', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: BASE_CONFIG });
  globalThis.window.__trussalIsAggregator = true;

  let rendered = false;
  const conf = await maybeBootstrapLibJitsi({
    renderPrejoinFn: async () => { rendered = true; return 'x'; },
  });

  assert.equal(rendered, false);
  assert.ok(conf);
  assert.ok(await waitFor(() => getConference() === conf));
});

test('maybeBootstrapLibJitsi: a failing prejoin still joins, without a display name', async () => {
  const jitsi = fakeJitsiMeetJS();
  installWindow({ jitsi, config: BASE_CONFIG });

  const conf = await maybeBootstrapLibJitsi({
    renderPrejoinFn: async () => { throw new Error('boom'); },
  });

  assert.ok(conf, 'a broken prejoin must not strand the join');
  assert.ok(await waitFor(() => getConference() === conf));
  await delay(20);
  assert.deepEqual(conf._displayNames, []);
});
