// Walkie Talkie Mode against the REAL sidecar relay over real WebSockets: a
// walkie participant has left as far as ordinary participants (and the
// aggregator) can tell, stays visible to other walkie peers and to a
// `seesWalkie` bus connection (the fleet service), and comes back with a
// fresh peer-join when the mode is turned off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../../latency-instrument/server.js');

const ROOM = 'walkie-room';

async function withRelay(fn) {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const sockets = [];
  try {
    await fn({
      async join(hello, role = 'player') {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${ROOM}&role=${role}`);
        const inbox = [];
        const waiters = [];
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          const w = waiters.find((x) => x.match(msg));
          if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else inbox.push(msg);
        });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        sockets.push(ws);
        const client = {
          inbox,
          send: (msg) => ws.send(JSON.stringify(msg)),
          waitFor(match, timeoutMs = 2000) {
            const pred = typeof match === 'string' ? (m) => m.type === match : match;
            const i = inbox.findIndex(pred);
            if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`no matching message within ${timeoutMs}ms`)), timeoutMs);
              waiters.push({ match: pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
            });
          },
          // Let in-flight relay traffic land, then report whether anything
          // matching arrived.
          async received(match) {
            await new Promise((r) => setTimeout(r, 80));
            return inbox.some(match);
          },
        };
        const welcome = await client.waitFor('welcome');
        client.peerId = welcome.peerId;
        client.send({ type: 'hello', ...hello });
        if (role === 'player') await client.waitFor('roster');
        return client;
      },
    });
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

test('turning walkie on reads as a leave to ordinary peers, not to the fleet or other walkie peers', async () => {
  await withRelay(async ({ join }) => {
    const fleet = await join({ jitsiId: 'fleet', isFleet: true, seesWalkie: true }, 'fleet');
    const plain = await join({ jitsiId: 'j-plain', stableId: 's-plain' });
    const other = await join({ jitsiId: 'j-other', stableId: 's-other', walkie: true });
    const me = await join({ jitsiId: 'j-me', stableId: 's-me' });

    me.send({ type: 'walkie', on: true });
    const left = await plain.waitFor((m) => m.type === 'peer-leave' && m.peerId === me.peerId);
    assert.ok(left);
    const notice = await fleet.waitFor('peer-walkie');
    assert.deepEqual([notice.peerId, notice.on], [me.peerId, true]);
    assert.equal(await other.received((m) => m.type === 'peer-leave' && m.peerId === me.peerId), false);
    assert.equal(await fleet.received((m) => m.type === 'peer-leave' && m.peerId === me.peerId), false);

    // Everyone hears who is away — that is how the plain peer hides the tile.
    const roster = await plain.waitFor((m) => m.type === 'walkie-roster' && m.peers.length === 2);
    assert.deepEqual(roster.peers.map((p) => p.jitsiId).sort(), ['j-me', 'j-other']);
  });
});

test("a walkie peer's updates stop at the walkie group; the metaprogram still syncs", async () => {
  await withRelay(async ({ join }) => {
    const fleet = await join({ jitsiId: 'fleet', isFleet: true, seesWalkie: true }, 'fleet');
    const plain = await join({ jitsiId: 'j-plain', stableId: 's-plain' });
    const other = await join({ jitsiId: 'j-other', stableId: 's-other', walkie: true });
    const me = await join({ jitsiId: 'j-me', stableId: 's-me', walkie: true });

    me.send({ type: 'pattern', code: 'personal editor\ns("bd")' });
    await other.waitFor((m) => m.type === 'peer-update' && m.peerId === me.peerId);
    await fleet.waitFor((m) => m.type === 'peer-update' && m.peerId === me.peerId);
    assert.equal(await plain.received((m) => m.type === 'peer-update' && m.peerId === me.peerId), false);

    me.send({ type: 'crdt-update', update: 'AAA=' });
    assert.ok(await plain.waitFor('crdt-update'));
  });
});

test('a late joiner never sees a walkie peer in its roster', async () => {
  await withRelay(async ({ join }) => {
    const me = await join({ jitsiId: 'j-me', stableId: 's-me', walkie: true });
    const plain = await join({ jitsiId: 'j-plain', stableId: 's-plain' });
    // join() already consumed the roster; re-hello to read a fresh one.
    plain.send({ type: 'hello', jitsiId: 'j-plain', stableId: 's-plain' });
    const roster = await plain.waitFor('roster');
    assert.ok(!roster.peers.some((p) => p.peerId === me.peerId));
    const away = await plain.waitFor('walkie-roster');
    assert.deepEqual(away.peers.map((p) => p.jitsiId), ['j-me']);
  });
});

test('turning walkie off brings the peer back with a fresh peer-join', async () => {
  await withRelay(async ({ join }) => {
    const plain = await join({ jitsiId: 'j-plain', stableId: 's-plain' });
    const me = await join({ jitsiId: 'j-me', stableId: 's-me', walkie: true });
    me.send({ type: 'walkie', on: false });
    const back = await plain.waitFor((m) => m.type === 'peer-join' && m.peer.peerId === me.peerId);
    assert.equal(back.peer.walkie, false);
  });
});

test('signalling is relayed point to point, and only between walkie peers', async () => {
  await withRelay(async ({ join }) => {
    const plain = await join({ jitsiId: 'j-plain', stableId: 's-plain' });
    const a = await join({ jitsiId: 'j-a', stableId: 's-a', walkie: true });
    const b = await join({ jitsiId: 'j-b', stableId: 's-b', walkie: true });

    a.send({ type: 'walkie-signal', to: b.peerId, data: { description: { type: 'offer', sdp: 'x' } } });
    const got = await b.waitFor('walkie-signal');
    assert.equal(got.from, a.peerId);
    assert.equal(got.data.description.type, 'offer');

    // A non-walkie peer can neither send nor be sent signalling.
    plain.send({ type: 'walkie-signal', to: b.peerId, data: {} });
    a.send({ type: 'walkie-signal', to: plain.peerId, data: {} });
    assert.equal(await b.received((m) => m.type === 'walkie-signal'), false);
    assert.equal(await plain.received((m) => m.type === 'walkie-signal'), false);
  });
});

test('a room where every human is in walkie mode is not reset', async () => {
  await withRelay(async ({ join }) => {
    const fleet = await join({ jitsiId: 'fleet', isFleet: true, seesWalkie: true }, 'fleet');
    const me = await join({ jitsiId: 'j-me', stableId: 's-me' });
    me.send({ type: 'walkie', on: true });
    await fleet.waitFor('peer-walkie');
    assert.equal(await fleet.received((m) => m.type === 'session-reset'), false);
  });
});
