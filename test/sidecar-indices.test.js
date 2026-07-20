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

test('two connections sharing a stableId are one identity: the later takes over the index', async () => {
  await withServer(async (port) => {
    // A keeper holds the room open and observes membership changes.
    const keeper = await connect(port, 'sidshare');
    await hello(keeper, { jitsiId: 'keeper', stableId: 'KEEP' });

    const a = await connect(port, 'sidshare');
    const aYou = await hello(a, { jitsiId: 'ja', stableId: 'SHARED' });
    assert.equal(aYou.roomIndex, '1');

    // Same stableId again while `a`'s socket is still present (the leave→rejoin
    // race): one identity, so the later connection EVICTS `a` (keeper is told it
    // left) and takes over index '1'. We no longer treat a shared stableId as two
    // distinct people, so it never falls through to a fresh, unlisted index.
    const gone = waitFor(keeper, m => m.type === 'peer-leave' && m.peerId === aYou.peerId);
    const b = await connect(port, 'sidshare');
    assert.equal((await hello(b, { jitsiId: 'jb', stableId: 'SHARED' })).roomIndex, '1',
      'the later same-identity connection reclaims the index rather than colliding');
    await gone;

    keeper.ws.close(); a.ws.close(); b.ws.close();
  });
});

test('an owner rejoins to its index while its bots are present and its old record lingers', async () => {
  await withServer(async (port) => {
    const keeper = await connect(port, 'rejoinbots');
    await hello(keeper, { jitsiId: 'keeper', stableId: 'K' }); // index 0, holds the room open
    const owner = await connect(port, 'rejoinbots');
    const ownerYou = await hello(owner, { jitsiId: 'o1', stableId: 'OWNER' });
    assert.equal(ownerYou.roomIndex, '1');

    // Owner 1's cluster is up.
    const b1 = await connect(port, 'rejoinbots');
    assert.equal((await hello(b1, { jitsiId: 'b1', isBot: true, ownerIndex: '1' })).roomIndex, '1a');
    const b2 = await connect(port, 'rejoinbots');
    assert.equal((await hello(b2, { jitsiId: 'b2', isBot: true, ownerIndex: '1' })).roomIndex, '1b');

    // Owner rejoins with a FRESH jitsiId but the same stableId, WITHOUT closing
    // the old socket first (the real leave→rejoin race). It must reclaim '1': its
    // bots (1a/1b) don't hold '1', and its own lingering record is evicted. This
    // is the invariant — the human's index and its bots' prefix stay matched.
    const ownerGone = waitFor(keeper, m => m.type === 'peer-leave' && m.peerId === ownerYou.peerId);
    const owner2 = await connect(port, 'rejoinbots');
    assert.equal((await hello(owner2, { jitsiId: 'o1-rejoined', stableId: 'OWNER' })).roomIndex, '1',
      'reclaims its index; bots stay 1a/1b and the prefix still matches');
    await ownerGone;

    keeper.ws.close(); owner.ws.close(); b1.ws.close(); b2.ws.close(); owner2.ws.close();
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

test('a freed bot suffix gap-refills; an emptied cluster restarts at a', async () => {
  await withServer(async (port) => {
    const owner = await connect(port, 'sidbot'); // stays, so the room/meta survive
    assert.equal((await hello(owner, { jitsiId: 'h0', stableId: 'H0' })).roomIndex, '0');

    const b1 = await connect(port, 'sidbot');
    const b1You = await hello(b1, { jitsiId: 'b1', isBot: true, ownerIndex: '0' });
    assert.equal(b1You.roomIndex, '0a');
    const b2 = await connect(port, 'sidbot');
    const b2You = await hello(b2, { jitsiId: 'b2', isBot: true, ownerIndex: '0' });
    assert.equal(b2You.roomIndex, '0b');
    const b3 = await connect(port, 'sidbot');
    const b3You = await hello(b3, { jitsiId: 'b3', isBot: true, ownerIndex: '0' });
    assert.equal(b3You.roomIndex, '0c');

    // The MIDDLE bot leaves — suffix 'b' becomes the lowest free ordinal, so the
    // next spawn REFILLS it rather than climbing to 0d (bot suffixes gap-refill;
    // human indices still never reuse).
    const gone2 = waitFor(owner, m => m.type === 'peer-leave' && m.peerId === b2You.peerId);
    await closed(b2); await gone2;
    const b4 = await connect(port, 'sidbot');
    const b4You = await hello(b4, { jitsiId: 'b4', isBot: true, ownerIndex: '0' });
    assert.equal(b4You.roomIndex, '0b', 'a freed middle suffix is refilled, not climbed past');

    // Every one of owner 0's bots leaves (the owner stays) — with nothing left to
    // occupy a suffix, the next spawn starts back at 'a'.
    for (const [sock, you] of [[b1, b1You], [b3, b3You], [b4, b4You]]) {
      const gone = waitFor(owner, m => m.type === 'peer-leave' && m.peerId === you.peerId);
      await closed(sock); await gone;
    }
    const b5 = await connect(port, 'sidbot');
    assert.equal((await hello(b5, { jitsiId: 'b5', isBot: true, ownerIndex: '0' })).roomIndex, '0a',
      'an emptied cluster restarts at a');
    owner.ws.close(); b5.ws.close();
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
