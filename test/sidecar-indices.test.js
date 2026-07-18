// Integration: the sidecar assigns sequential, immutable, never-reused room
// indices at hello, and cluster suffixes for owned bots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../latency-instrument/server.js');
const { AGGREGATOR_ROOM_INDEX } = require('../latency-instrument/room-indices.js');

function connect(port, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}&role=player`);
    const client = { ws, messages: [], waiters: [] };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      client.messages.push(msg);
      client.waiters = client.waiters.filter(w => {
        if (w.pred(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

function waitFor(client, pred, ms = 2000) {
  const hit = client.messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
    client.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

async function hello(client, fields) {
  client.ws.send(JSON.stringify({ type: 'hello', displayName: 'x', ...fields }));
  const roster = await waitFor(client, m => m.type === 'roster');
  return roster.you;
}

async function withServer(fn) {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  try {
    await fn(wss.address().port);
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

function closed(client) {
  return new Promise(r => { client.ws.on('close', r); client.ws.close(); });
}

test('join order assigns 0,1,2; a rejoiner gets a fresh index (never reused)', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'idx1');
    const b = await connect(port, 'idx1');
    const c = await connect(port, 'idx1');
    assert.equal((await hello(a, { jitsiId: 'ja' })).roomIndex, '0');
    assert.equal((await hello(b, { jitsiId: 'jb' })).roomIndex, '1');
    assert.equal((await hello(c, { jitsiId: 'jc' })).roomIndex, '2');

    // b leaves; everyone is told; b rejoins with a fresh Jitsi id.
    const leavePromise = waitFor(a, m => m.type === 'peer-leave');
    await closed(b);
    await leavePromise;

    const b2 = await connect(port, 'idx1');
    assert.equal((await hello(b2, { jitsiId: 'jb-rejoined' })).roomIndex, '3');
    a.ws.close(); c.ws.close(); b2.ws.close();
  });
});

test('a rejoiner carrying its stableId reclaims its old index (identity-stable)', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'sid1');
    const b = await connect(port, 'sid1');
    const c = await connect(port, 'sid1');
    assert.equal((await hello(a, { jitsiId: 'ja', stableId: 'A' })).roomIndex, '0');
    assert.equal((await hello(b, { jitsiId: 'jb', stableId: 'B' })).roomIndex, '1');
    assert.equal((await hello(c, { jitsiId: 'jc', stableId: 'C' })).roomIndex, '2');

    // b leaves and rejoins with a FRESH jitsiId (as a genuine rejoin does) but
    // its persistent stableId.
    const leavePromise = waitFor(a, m => m.type === 'peer-leave');
    await closed(b);
    await leavePromise;

    const b2 = await connect(port, 'sid1');
    // Reclaims '1', not a fresh '3' — folds straight back into its old slot.
    assert.equal((await hello(b2, { jitsiId: 'jb-rejoined', stableId: 'B' })).roomIndex, '1');

    // The reclaim consumed no integer: a genuinely new participant still gets '3'.
    const d = await connect(port, 'sid1');
    assert.equal((await hello(d, { jitsiId: 'jd', stableId: 'D' })).roomIndex, '3');
    a.ws.close(); c.ws.close(); b2.ws.close(); d.ws.close();
  });
});

test('two live peers sharing a stableId do not collide (incognito tabs share localStorage)', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'sidshare');
    const aYou = await hello(a, { jitsiId: 'ja', stableId: 'SHARED' });
    assert.equal(aYou.roomIndex, '0');

    // A second peer with the SAME stableId while the first is still present must
    // get a FRESH index, not reclaim the occupied '0'.
    const b = await connect(port, 'sidshare');
    assert.equal((await hello(b, { jitsiId: 'jb', stableId: 'SHARED' })).roomIndex, '1',
      'a shared stableId must not reclaim an index a live peer still holds');

    // The original holder keeps the reclaim: it leaves, freeing '0', then a later
    // SHARED hello lands back on '0'.
    const gone = waitFor(b, m => m.type === 'peer-leave' && m.peerId === aYou.peerId);
    await closed(a);
    await gone;
    const a2 = await connect(port, 'sidshare');
    assert.equal((await hello(a2, { jitsiId: 'ja2', stableId: 'SHARED' })).roomIndex, '0',
      'once free, the remembered index is reclaimable again');
    b.ws.close(); a2.ws.close();
  });
});

test('a rejoiner without a stableId still gets a fresh index (no false reclaim)', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'sid1b');
    const b = await connect(port, 'sid1b');
    assert.equal((await hello(a, { jitsiId: 'ja', stableId: 'A' })).roomIndex, '0');
    assert.equal((await hello(b, { jitsiId: 'jb' })).roomIndex, '1'); // no stableId

    const leavePromise = waitFor(a, m => m.type === 'peer-leave');
    await closed(b);
    await leavePromise;

    // b rejoins WITHOUT a stableId (storage blocked): fresh index, never reused.
    const b2 = await connect(port, 'sid1b');
    assert.equal((await hello(b2, { jitsiId: 'jb-rejoined' })).roomIndex, '2');
    a.ws.close(); b2.ws.close();
  });
});

test('the aggregator is never reclaimed by stableId (always the reserved index)', async () => {
  await withServer(async (port) => {
    const human = await connect(port, 'sid2');
    assert.equal((await hello(human, { jitsiId: 'h', stableId: 'H' })).roomIndex, '0');

    const agg = await connect(port, 'sid2');
    assert.equal(
      (await hello(agg, { jitsiId: 'agg', isBot: true, isAggregator: true, stableId: 'AGG' })).roomIndex,
      AGGREGATOR_ROOM_INDEX,
    );

    // The aggregator consumed no integer and was not remembered under 'AGG':
    // the next human is '1'.
    const second = await connect(port, 'sid2');
    assert.equal((await hello(second, { jitsiId: 'h2', stableId: 'H2' })).roomIndex, '1');
    human.ws.close(); agg.ws.close(); second.ws.close();
  });
});

test('reconnect with the same jitsiId keeps the index (immutable for the meeting)', async () => {
  await withServer(async (port) => {
    const keeper = await connect(port, 'idx2'); // keeps the room alive
    await hello(keeper, { jitsiId: 'keeper' });
    const a = await connect(port, 'idx2');
    assert.equal((await hello(a, { jitsiId: 'same-jid' })).roomIndex, '1');

    // New socket, same Jitsi identity (stale-eviction path).
    const a2 = await connect(port, 'idx2');
    assert.equal((await hello(a2, { jitsiId: 'same-jid' })).roomIndex, '1');
    keeper.ws.close(); a.ws.close(); a2.ws.close();
  });
});

test('owned bots get cluster suffixes in spawn order; humans interleave untouched', async () => {
  await withServer(async (port) => {
    const owner = await connect(port, 'idx3');
    assert.equal((await hello(owner, { jitsiId: 'h0' })).roomIndex, '0');
    const owner1 = await connect(port, 'idx3');
    assert.equal((await hello(owner1, { jitsiId: 'h1' })).roomIndex, '1');

    // Batch append for owner 1: 1a, 1b, 1c.
    for (const expected of ['1a', '1b', '1c']) {
      const bot = await connect(port, 'idx3');
      const you = await hello(bot, { jitsiId: `bot-${expected}`, isBot: true, ownerIndex: '1' });
      assert.equal(you.roomIndex, expected);
    }

    // Owner 0 spawns one: independent counter.
    const bot0 = await connect(port, 'idx3');
    assert.equal((await hello(bot0, { jitsiId: 'bot-0a', isBot: true, ownerIndex: '0' })).roomIndex, '0a');

    // A bot with no owner is a plain room entrant with the next integer.
    const stray = await connect(port, 'idx3');
    assert.equal((await hello(stray, { jitsiId: 'stray', isBot: true })).roomIndex, '2');

    // roster/peer-join broadcasts carry the index.
    const late = await connect(port, 'idx3');
    const rosterYou = await hello(late, { jitsiId: 'late' });
    assert.equal(rosterYou.roomIndex, '3');
    const roster = late.messages.find(m => m.type === 'roster');
    const indices = roster.peers.map(p => p.roomIndex).sort();
    assert.deepEqual(indices, ['0', '0a', '1', '1a', '1b', '1c', '2']);
  });
});

test("an owner's last bot leaving restarts its cluster suffix; a partial cluster keeps climbing", async () => {
  await withServer(async (port) => {
    const owner = await connect(port, 'sidbot'); // stays, so the room/meta survive
    assert.equal((await hello(owner, { jitsiId: 'h0', stableId: 'H0' })).roomIndex, '0');

    const b1 = await connect(port, 'sidbot');
    const b1You = await hello(b1, { jitsiId: 'b1', isBot: true, ownerIndex: '0' });
    assert.equal(b1You.roomIndex, '0a');
    const b2 = await connect(port, 'sidbot');
    const b2You = await hello(b2, { jitsiId: 'b2', isBot: true, ownerIndex: '0' });
    assert.equal(b2You.roomIndex, '0b');

    // One bot leaves — 0b survives, so the sequence is NOT reset (a new bot must
    // not collide with the survivor).
    const gone1 = waitFor(owner, m => m.type === 'peer-leave' && m.peerId === b1You.peerId);
    await closed(b1);
    await gone1;
    const b3 = await connect(port, 'sidbot');
    const b3You = await hello(b3, { jitsiId: 'b3', isBot: true, ownerIndex: '0' });
    assert.equal(b3You.roomIndex, '0c', 'a partial cluster keeps climbing past the survivor');

    // Now every one of owner 0's bots leaves (the owner stays) — the counter resets.
    const gone2 = waitFor(owner, m => m.type === 'peer-leave' && m.peerId === b2You.peerId);
    await closed(b2); await gone2;
    const gone3 = waitFor(owner, m => m.type === 'peer-leave' && m.peerId === b3You.peerId);
    await closed(b3); await gone3;

    const b4 = await connect(port, 'sidbot');
    assert.equal((await hello(b4, { jitsiId: 'b4', isBot: true, ownerIndex: '0' })).roomIndex, '0a',
      "an emptied cluster restarts at 'a'");
    owner.ws.close(); b4.ws.close();
  });
});

test('isAggregator propagates through you/peer-join/roster; normal peers stay false', async () => {
  await withServer(async (port) => {
    // A normal human joins first.
    const human = await connect(port, 'agg1');
    const humanYou = await hello(human, { jitsiId: 'human' });
    assert.equal(humanYou.isAggregator, false, 'a plain peer is not an aggregator');

    // The aggregator bot joins (also a bot). Its own view reflects the flag,
    // and the human is told via peer-join.
    const joinPromise = waitFor(human, m => m.type === 'peer-join');
    const agg = await connect(port, 'agg1');
    const aggYou = await hello(agg, { jitsiId: 'agg', isBot: true, isAggregator: true });
    assert.equal(aggYou.isAggregator, true, 'the aggregator sees isAggregator on its own record');

    const join = await joinPromise;
    assert.equal(join.peer.jitsiId, 'agg');
    assert.equal(join.peer.isAggregator, true, 'peers learn the aggregator via peer-join');

    // A late joiner's roster distinguishes the aggregator from the human.
    const late = await connect(port, 'agg1');
    await hello(late, { jitsiId: 'late' });
    const roster = late.messages.find(m => m.type === 'roster');
    const byJid = Object.fromEntries(roster.peers.map(p => [p.jitsiId, p.isAggregator]));
    assert.equal(byJid.agg, true, 'roster marks the aggregator');
    assert.equal(byJid.human, false, 'roster leaves normal peers unmarked');

    human.ws.close(); agg.ws.close(); late.ws.close();
  });
});

test('the aggregator takes the reserved index and consumes no integer', async () => {
  await withServer(async (port) => {
    const human = await connect(port, 'idx6');
    assert.equal((await hello(human, { jitsiId: 'h0' })).roomIndex, '0');

    const agg = await connect(port, 'idx6');
    const aggYou = await hello(agg, { jitsiId: 'agg', isBot: true, isAggregator: true });
    assert.equal(aggYou.roomIndex, AGGREGATOR_ROOM_INDEX, 'aggregator gets the reserved index');

    // The human who joins AFTER the aggregator gets the next integer — the
    // aggregator did not burn one, so `$ participants <1>` addresses them.
    const second = await connect(port, 'idx6');
    assert.equal((await hello(second, { jitsiId: 'h1' })).roomIndex, '1');

    human.ws.close(); agg.ws.close(); second.ws.close();
  });
});

test('empty room resets counters (a new meeting starts at 0)', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'idx4');
    assert.equal((await hello(a, { jitsiId: 'j1' })).roomIndex, '0');
    await closed(a);
    // Poll until the server has processed the close and reset the room.
    let idx = null;
    for (let i = 0; i < 20; i++) {
      const b = await connect(port, 'idx4');
      idx = (await hello(b, { jitsiId: `j2-${i}` })).roomIndex;
      await closed(b);
      if (idx === '0') break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(idx, '0');
  });
});
