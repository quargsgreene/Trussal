// `# inhabit` against the REAL sidecar relay over real WebSockets: who may
// report the guest → host map, that it reaches everyone (late joiners
// included), that guest/host traffic and the inhabited editor's CRDT doc stay
// between the pair the map joins, and that a guest acts with its host's
// metaprogram permissions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../../latency-instrument/server.js');

const ROOM = 'inhabit-room';

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
          ws,
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
          async received(match) {
            await new Promise((r) => setTimeout(r, 80));
            return inbox.some(match);
          },
          drain() { inbox.length = 0; },
        };
        const welcome = await client.waitFor('welcome');
        client.peerId = welcome.peerId;
        client.send({ type: 'hello', ...hello });
        if (role === 'player') {
          const roster = await client.waitFor('roster');
          client.roster = roster;
          client.roomIndex = roster.you.roomIndex;
          await client.waitFor('inhabit');
        }
        return client;
      },
    });
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

const isInhabit = (map) => (m) => m.type === 'inhabit' && JSON.stringify(m.map) === JSON.stringify(map);

test('the aggregator\'s map reaches the room and every late joiner, and a human cannot override it', async () => {
  await withRelay(async ({ join }) => {
    const a = await join({ jitsiId: 'a', displayName: 'A' });
    const fleet = await join({ jitsiId: 'agg-bus', isFleet: true }, 'fleet');
    fleet.send({ type: 'inhabit', map: { 1: '0', bogus: '0' } });
    await a.waitFor(isInhabit({ 1: '0' }));

    const b = await join({ jitsiId: 'b', displayName: 'B' });
    assert.equal(b.roomIndex, '1');
    // The hello catch-up already carried it (join() consumed that message).
    a.send({ type: 'inhabit', map: {} });
    assert.equal(await b.received(isInhabit({})), false, 'a human report is ignored while an aggregator reports');

    fleet.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    a.send({ type: 'inhabit', map: {} });
    await b.waitFor(isInhabit({}));
  });
});

test('with no aggregator a human may report the map, a bot may not', async () => {
  await withRelay(async ({ join }) => {
    const a = await join({ jitsiId: 'a' });
    const b = await join({ jitsiId: 'b' });
    const bot = await join({ jitsiId: 'bot', isBot: true, ownerIndex: '0' });
    assert.equal(bot.roomIndex, '0a');
    bot.send({ type: 'inhabit', map: { 1: '0' } });
    assert.equal(await a.received((m) => m.type === 'inhabit'), false);
    b.send({ type: 'inhabit', map: { '0a': '1' } });
    await a.waitFor(isInhabit({ '0a': '1' }));
  });
});

test('guest/host messages pass only between the pair, and only in their own direction', async () => {
  await withRelay(async ({ join }) => {
    const host = await join({ jitsiId: 'h' });     // 0
    const guest = await join({ jitsiId: 'g' });    // 1
    const outsider = await join({ jitsiId: 'o' }); // 2
    host.send({ type: 'inhabit', map: { 1: '0' } });
    await guest.waitFor(isInhabit({ 1: '0' }));

    guest.send({ type: 'inhabit-relay', to: host.peerId, kind: 'chat', data: { to: 'x', text: 'hi' } });
    const up = await host.waitFor('inhabit-relay');
    assert.deepEqual({ kind: up.kind, from: up.from, fromIndex: up.fromIndex, data: up.data }, { kind: 'chat', from: guest.peerId, fromIndex: '1', data: { to: 'x', text: 'hi' } });

    host.send({ type: 'inhabit-relay', to: guest.peerId, kind: 'snapshot', data: { displayName: 'H' } });
    assert.equal((await guest.waitFor('inhabit-relay')).kind, 'snapshot');

    guest.send({ type: 'inhabit-relay', to: host.peerId, kind: 'snapshot', data: {} });
    host.send({ type: 'inhabit-relay', to: guest.peerId, kind: 'chat', data: {} });
    outsider.send({ type: 'inhabit-relay', to: host.peerId, kind: 'chat', data: {} });
    assert.equal(await host.received((m) => m.type === 'inhabit-relay'), false);
    assert.equal(await guest.received((m) => m.type === 'inhabit-relay'), false);

    host.send({ type: 'inhabit', map: {} });
    await guest.waitFor(isInhabit({}));
    guest.send({ type: 'inhabit-relay', to: host.peerId, kind: 'join' });
    assert.equal(await host.received((m) => m.type === 'inhabit-relay'), false, 'the channel closes with the inhabitation');
  });
});

test('an inhabited editor\'s doc is shared by the host and its guests only, and kept for late arrivals', async () => {
  await withRelay(async ({ join }) => {
    const host = await join({ jitsiId: 'h' });     // 0
    const g1 = await join({ jitsiId: 'g1' });      // 1
    const outsider = await join({ jitsiId: 'o' }); // 2
    const bot = await join({ jitsiId: 'bot', isBot: true, ownerIndex: '0' }); // 0a
    host.send({ type: 'inhabit', map: { 1: '0', '0a': '0' } });
    await g1.waitFor(isInhabit({ 1: '0', '0a': '0' }));

    host.send({ type: 'editor-crdt-update', host: '0', update: 'U1' });
    g1.send({ type: 'editor-crdt-update', host: '0', update: 'U2' });
    assert.equal((await g1.waitFor('editor-crdt-update')).update, 'U1');
    const fromGuest = await host.waitFor('editor-crdt-update');
    assert.deepEqual({ update: fromGuest.update, authorIndex: fromGuest.authorIndex }, { update: 'U2', authorIndex: '1' });
    assert.equal((await bot.waitFor((m) => m.type === 'editor-crdt-update' && m.update === 'U2')).host, '0', 'a bot guest is in the doc too');
    assert.equal(await outsider.received((m) => m.type === 'editor-crdt-update'), false);

    outsider.send({ type: 'editor-crdt-update', host: '0', update: 'EVIL' });
    assert.equal(await host.received((m) => m.update === 'EVIL'), false);

    g1.send({ type: 'editor-crdt-sync', host: '0' });
    assert.deepEqual((await g1.waitFor('editor-crdt-state')).updates, ['U1', 'U2']);
    outsider.send({ type: 'editor-crdt-sync', host: '0' });
    assert.equal(await outsider.received((m) => m.type === 'editor-crdt-state'), false);

    host.send({ type: 'editor-crdt-update', host: '0', update: 'SNAP', snapshot: true });
    await g1.waitFor((m) => m.update === 'SNAP');
    host.send({ type: 'editor-crdt-sync', host: '0' });
    assert.deepEqual((await host.waitFor('editor-crdt-state')).updates, ['SNAP']);
  });
});

test('a guest acts with its host\'s metaprogram permissions while inside it', async () => {
  await withRelay(async ({ join }) => {
    const human = await join({ jitsiId: 'h' }); // 0
    const watcher = await join({ jitsiId: 'w' }); // 1
    const bot = await join({ jitsiId: 'bot', isBot: true, ownerIndex: '0' }); // 0a

    // A bot on its own may not edit the metaprogram.
    bot.send({ type: 'crdt-update', update: 'BOT1', channel: 'metaprogram' });
    assert.equal(await watcher.received((m) => m.type === 'crdt-update' && m.update === 'BOT1'), false);

    // Inside a human, it may; and a human inside the bot may not.
    human.send({ type: 'inhabit', map: { '0a': '0', 1: '0a' } });
    const patches = [];
    for (let i = 0; i < 2; i++) patches.push(await human.waitFor((m) => m.type === 'peer-update' && 'canEditMetaprogram' in m.patch));
    const byPeer = Object.fromEntries(patches.map((m) => [m.peerId, m.patch.canEditMetaprogram]));
    assert.deepEqual(byPeer, { [bot.peerId]: true, [watcher.peerId]: false });

    bot.send({ type: 'crdt-update', update: 'BOT2', channel: 'metaprogram' });
    await watcher.waitFor((m) => m.type === 'crdt-update' && m.update === 'BOT2');
    watcher.send({ type: 'crdt-update', update: 'W1', channel: 'metaprogram' });
    assert.equal(await human.received((m) => m.type === 'crdt-update' && m.update === 'W1'), false);

    // Leaving gives each its own permissions back.
    human.send({ type: 'inhabit', map: {} });
    await human.waitFor((m) => m.type === 'peer-update' && m.peerId === watcher.peerId && m.patch.canEditMetaprogram === true);
    watcher.send({ type: 'crdt-update', update: 'W2', channel: 'metaprogram' });
    await human.waitFor((m) => m.type === 'crdt-update' && m.update === 'W2');
  });
});

test('a guest may run a human host\'s editor, and nothing else of the host\'s', async () => {
  await withRelay(async ({ join }) => {
    const host = await join({ jitsiId: 'h' });     // 0
    const guest = await join({ jitsiId: 'g' });    // 1
    const outsider = await join({ jitsiId: 'o' }); // 2
    host.send({ type: 'inhabit', map: { 1: '0' } });
    await guest.waitFor(isInhabit({ 1: '0' }));

    guest.send({ type: 'remote-control', targetPeerId: host.peerId, action: 'pattern', code: "'personal editor'\ns('bd')" });
    assert.equal((await host.waitFor('remote-control')).code, "'personal editor'\ns('bd')");

    guest.send({ type: 'remote-control', targetPeerId: host.peerId, action: 'mute', muted: true });
    outsider.send({ type: 'remote-control', targetPeerId: host.peerId, action: 'pattern', code: 'x' });
    assert.equal(await host.received((m) => m.type === 'remote-control'), false);
  });
});

// --- permissionsConfig ---------------------------------------------------------

test('a host\'s allowInhabitFrom takes refused guests out of the map, and letting them in again restores them', async () => {
  await withRelay(async ({ join }) => {
    const host = await join({ jitsiId: 'h' });    // 0
    const g1 = await join({ jitsiId: 'g1' });     // 1
    const g2 = await join({ jitsiId: 'g2' });     // 2
    host.send({ type: 'permissions-config', config: { allowInhabitFrom: ['2'], allowClipping: true } });
    const seen = await g1.waitFor((m) => m.type === 'peer-update' && m.peerId === host.peerId && m.patch.permissionsConfig);
    assert.deepEqual(seen.patch.permissionsConfig, { allowInhabitFrom: ['2'], allowClipping: true });

    host.send({ type: 'inhabit', map: { 1: '0', 2: '0' } });
    await g2.waitFor(isInhabit({ 2: '0' }));
    g1.send({ type: 'editor-crdt-update', host: '0', update: 'REFUSED' });
    g1.send({ type: 'inhabit-relay', to: host.peerId, kind: 'join' });
    assert.equal(await host.received((m) => m.update === 'REFUSED' || m.type === 'inhabit-relay'), false,
      'a refused guest reaches nothing of the host');

    host.send({ type: 'permissions-config', config: { allowInhabitFrom: 'none' } });
    await g2.waitFor(isInhabit({}));
    host.send({ type: 'permissions-config', config: { allowInhabitFrom: 'all' } });
    await g2.waitFor(isInhabit({ 1: '0', 2: '0' }), 2000);
  });
});

test('a config carried on the hello applies from the first moment, and the room sees it', async () => {
  await withRelay(async ({ join }) => {
    const a = await join({ jitsiId: 'a' });       // 0
    a.send({ type: 'inhabit', map: { 0: '1' } }); // 0 inside 1, before 1 exists
    await a.waitFor(isInhabit({ 0: '1' }));
    const config = { allowInhabitFrom: 'none', allowClipping: false };
    await join({ jitsiId: 'b', permissionsConfig: config }); // 1
    await a.waitFor(isInhabit({}));
    const joined = await a.waitFor('peer-join');
    assert.deepEqual(joined.peer.permissionsConfig, config);

    // A late joiner reads it off the roster; a participant who never
    // declared one shows the defaults.
    const c = await join({ jitsiId: 'c' });
    const byIndex = Object.fromEntries(c.roster.peers.map((p) => [p.roomIndex, p.permissionsConfig]));
    assert.deepEqual(byIndex, { 0: { allowInhabitFrom: 'all', allowClipping: true }, 1: config });
  });
});

test('the reporting aggregator always hears the map in force back', async () => {
  await withRelay(async ({ join }) => {
    await join({ jitsiId: 'h', permissionsConfig: { allowInhabitFrom: 'none' } }); // 0
    await join({ jitsiId: 'g' });                                                   // 1
    const fleet = await join({ jitsiId: 'agg-bus', isFleet: true }, 'fleet');
    fleet.send({ type: 'inhabit', map: { 1: '0' } });
    await fleet.waitFor(isInhabit({}));
  });
});
