// Sidecar control channel: relay-wide room discovery.
//
// A Trussal room name is free-form, so the fleet service cannot know which
// rooms to serve from configuration — that is exactly why the aggregator only
// ever appeared in the one configured room. `?role=control` is how the fleet
// learns which meetings exist: a snapshot of the rooms that already hold
// participants, then an announcement for each subsequent join.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer, CONTROL_TOKEN_HEADER } = require('../latency-instrument/server.js');

// The control token travels in a request HEADER, never the query string: nginx
// logs the full request line, so a token in the URL would be written to the
// video VM's access log on every connect and every 2s reconnect.
function connect(port, { room, role, token } = {}) {
  const query = [
    room != null ? `room=${encodeURIComponent(room)}` : null,
    role ? `role=${role}` : null,
  ].filter(Boolean).join('&');
  const options = token != null ? { headers: { [CONTROL_TOKEN_HEADER]: token } } : undefined;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, options);
    const client = { ws, messages: [], waiters: [] };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      client.messages.push(msg);
      client.waiters = client.waiters.filter(w => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
function waitFor(client, pred, ms = 2000) {
  const hit = client.messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    client.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}
async function hello(client, fields) {
  client.ws.send(JSON.stringify({ type: 'hello', displayName: 'x', ...fields }));
  return waitFor(client, m => m.type === 'roster');
}
const TOKEN = 'test-control-token';

async function withServer(fn, opts = {}) {
  const { wss } = createLatencyServer({ port: 0, controlToken: TOKEN, ...opts });
  await new Promise(r => wss.once('listening', r));
  try {
    await fn(wss.address().port);
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

test('control channel: snapshot of rooms in progress, then an announcement per join', async () => {
  await withServer(async (port) => {
    // A meeting already under way before the watcher connects — the case that
    // matters after a conductor restart or a dropped control socket.
    const alpha = await connect(port, { room: 'alpha' });
    await hello(alpha, { jitsiId: 'ja' });

    const control = await connect(port, { role: 'control', token: TOKEN });
    const snapshot = await waitFor(control, m => m.type === 'rooms');
    assert.deepEqual(snapshot.rooms, ['alpha'], 'rooms already holding people arrive up front');

    // Any room name works — nothing is configured ahead of time.
    const beta = await connect(port, { room: 'not-a-number-at-all' });
    await hello(beta, { jitsiId: 'jb' });
    const announced = await waitFor(control, m => m.type === 'room-active' && m.room === 'not-a-number-at-all');
    assert.equal(announced.room, 'not-a-number-at-all');

    alpha.ws.close(); beta.ws.close(); control.ws.close();
  });
});

test('control channel: announced on every join, so a late watcher still learns the room', async () => {
  await withServer(async (port) => {
    const room = await connect(port, { room: 'gig' });
    await hello(room, { jitsiId: 'j1' });

    // Watcher connects after the first join and gets it from the snapshot…
    const control = await connect(port, { role: 'control', token: TOKEN });
    await waitFor(control, m => m.type === 'rooms' && m.rooms.includes('gig'));

    // …and a second person through the door re-announces it rather than being
    // swallowed as "already active", which is what makes recovery level-triggered.
    const second = await connect(port, { room: 'gig' });
    await hello(second, { jitsiId: 'j2' });
    await waitFor(control, m => m.type === 'room-active' && m.room === 'gig');

    room.ws.close(); second.ws.close(); control.ws.close();
  });
});

// Jitsi's XMPP layer lowercases the MUC room name regardless of URL casing,
// so /sdA and /sda are the same physical meeting to every real participant.
// Before this was normalized here, the sidecar (and everything the fleet
// derives from it) tracked them as two unrelated rooms — two rosters, two
// independently-spawned bot clusters colliding in one real conference.
test('control channel: differently-cased room names are the same room', async () => {
  await withServer(async (port) => {
    const upper = await connect(port, { room: 'sdA' });
    const upperRoster = await hello(upper, { jitsiId: 'j1' });
    assert.equal(upperRoster.you.roomIndex, '0');

    const lower = await connect(port, { room: 'sda' });
    const lowerRoster = await hello(lower, { jitsiId: 'j2' });
    assert.equal(lowerRoster.peers.length, 1, 'sda sees the peer that joined as sdA');
    assert.equal(lowerRoster.peers[0].jitsiId, 'j1');

    const control = await connect(port, { role: 'control', token: TOKEN });
    const snapshot = await waitFor(control, m => m.type === 'rooms');
    assert.deepEqual(snapshot.rooms, ['sda'], 'one canonical room name, not two');

    upper.ws.close(); lower.ws.close(); control.ws.close();
  });
});

test('control channel: a watcher is not a participant — no index, no roster, no broadcast', async () => {
  await withServer(async (port) => {
    const control = await connect(port, { role: 'control', token: TOKEN });
    await waitFor(control, m => m.type === 'rooms');

    const human = await connect(port, { room: 'solo' });
    const roster = await hello(human, { jitsiId: 'jh' });
    assert.equal(roster.you.roomIndex, '0', 'the watcher consumed no room index');
    assert.deepEqual(roster.peers, [], 'the watcher is in nobody’s roster');

    // Room traffic never reaches the control socket: it holds no room membership.
    human.ws.send(JSON.stringify({ type: 'pattern', code: 's("bd")' }));
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!control.messages.some(m => m.type === 'peer-update' || m.type === 'peer-join'),
      'control sees only room lifecycle, not room contents');

    human.ws.close(); control.ws.close();
  });
});

// The control channel is a live directory of every meeting in progress, and
// /ws is proxied to the public internet with no auth of its own (ws-route.conf)
// while a room's NAME is the only thing gating entry (ENABLE_GUESTS). So it
// must be authenticated, and must fail CLOSED — an unauthenticated listing is
// silent disclosure of every private session.
test('control channel: refused without the shared token, and told so', async () => {
  await withServer(async (port) => {
    for (const token of [undefined, '', 'wrong', 'test-control-token-longer']) {
      const attacker = await connect(port, { role: 'control', token });
      const denied = await waitFor(attacker, m => m.type === 'control-denied');
      assert.equal(denied.type, 'control-denied');
      assert.ok(!attacker.messages.some(m => m.type === 'rooms'),
        `no room listing leaked for token ${JSON.stringify(token)}`);
      attacker.ws.close();
    }
  });
});

// The secret must never reach the URL. nginx's default log format records the
// full request line, and this socket reconnects every 2s while the relay is
// down, so a token in the query string would be copied into the video VM's
// access log continuously. Asserted on the wire (the relay only ever sees a
// header) rather than by reading the client, so moving it back to the query
// string fails here instead of leaking quietly.
test('control channel: the token is presented as a header, never in the URL', async () => {
  const seen = [];
  const { wss } = createLatencyServer({ port: 0, controlToken: TOKEN });
  wss.on('connection', (ws, req) => seen.push(req));
  await new Promise(r => wss.once('listening', r));
  try {
    const port = wss.address().port;
    const control = await connect(port, { role: 'control', token: TOKEN });
    await waitFor(control, m => m.type === 'rooms');

    const req = seen.at(-1);
    assert.equal(req.headers[CONTROL_TOKEN_HEADER], TOKEN, 'the relay authenticates off the header');
    assert.ok(!req.url.includes(TOKEN), `the secret must not appear in the request line: ${req.url}`);
    assert.ok(!/token=/.test(req.url), `no token query parameter at all: ${req.url}`);

    control.ws.close();
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('control channel: refused entirely when the relay has no token configured', async () => {
  await withServer(async (port) => {
    const room = await connect(port, { room: 'private-gig' });
    await hello(room, { jitsiId: 'jh' });

    const attacker = await connect(port, { role: 'control', token: TOKEN });
    await waitFor(attacker, m => m.type === 'control-denied');
    assert.ok(!attacker.messages.some(m => m.type === 'rooms'),
      'an unconfigured relay denies discovery rather than serving it openly');

    room.ws.close(); attacker.ws.close();
  }, { controlToken: null });
});

test('control channel: a room holding only fleet connections is not active', async () => {
  await withServer(async (port) => {
    // A fleet/observer connection is not a meeting — a room containing only
    // those is one nobody has joined (the same test session-reset uses).
    const fleet = await connect(port, { room: 'ghost', role: 'fleet' });
    await hello(fleet, { jitsiId: 'fleet-ghost', isFleet: true });

    const control = await connect(port, { role: 'control', token: TOKEN });
    const snapshot = await waitFor(control, m => m.type === 'rooms');
    assert.deepEqual(snapshot.rooms, [], 'no participants means no active room to serve');

    fleet.ws.close(); control.ws.close();
  });
});
