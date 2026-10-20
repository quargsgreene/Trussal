// The aggregator claim gate, against the REAL sidecar relay over real
// WebSockets.
//
// Two aggregators in one room each solo the other and tap + re-emit the
// other's master, so both mixes feed back and mute each other — so exactly one
// aggregator may ever hold a room. These tests pin the protocol that enforces
// it, in the shapes the reported duplicate bug actually took: a probe socket
// dropping and reconnecting mid-meeting (new peerId), the aggregator's own
// page living on a separate socket from its probe, a room emptied and
// re-populated, and a bot that stops (release) or dies (lease expiry).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../../latency-instrument/server.js');

// Short enough that lease-expiry tests run in well under a second; long
// enough that "still held" assertions can't race a lease that expired
// mid-assertion.
const LEASE_MS = 400;

async function withRelay(fn) {
  const { wss } = createLatencyServer({ port: 0, aggregatorClaimLeaseMs: LEASE_MS });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const sockets = [];
  try {
    await fn({
      port,
      // A raw relay connection. `path` lets tests join as the aggregator's
      // page (`?role=player`) rather than as a bare claim probe.
      async connect(path = '') {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${path}`);
        const inbox = [];
        const waiters = [];
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          const w = waiters.find((x) => x.type === msg.type);
          if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
          else inbox.push(msg);
        });
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        sockets.push(ws);
        return {
          ws,
          send: (msg) => ws.send(JSON.stringify(msg)),
          // Wait for one message of the given type, matching against messages
          // that already arrived too — every exchange here is small, so a
          // per-type inbox beats racing 'message' against slow assertions.
          async waitFor(type, timeoutMs = 2000) {
            const i = inbox.findIndex((m) => m.type === type);
            if (i >= 0) return inbox.splice(i, 1)[0];
            const got = new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error(`no '${type}' message within ${timeoutMs}ms`)), timeoutMs);
              waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
            });
            return got;
          },
          claim(token) {
            this.send({ type: 'aggregator-claim', token });
            return this.waitFor('aggregator-claim-result');
          },
        };
      },
    });
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

test('the first claim wins the room; a rival token is denied with the lease remaining', async () => {
  await withRelay(async ({ connect }) => {
    const a = await connect();
    const b = await connect();

    const first = await a.claim('token-a');
    assert.equal(first.granted, true);
    assert.equal(first.leaseMs, LEASE_MS);

    const rival = await b.claim('token-b');
    assert.equal(rival.granted, false,
      'a second aggregator must never be admitted to a held room');
    assert.ok(rival.heldForMs > 0 && rival.heldForMs <= LEASE_MS,
      `the denial carries the holder's remaining lease, got ${rival.heldForMs}`);
  });
});

test('a dropped probe does not free the slot: the lease outlives the socket', async () => {
  await withRelay(async ({ connect }) => {
    const probe = await connect();
    assert.equal((await probe.claim('token-a')).granted, true);

    // The socket blip: the probe's connection dies WITHOUT an explicit
    // release. The old bug freed the claim here, opening a window for a
    // second aggregator to walk in mid-meeting.
    probe.ws.close();
    await new Promise((r) => setTimeout(r, 50));

    const rival = await connect();
    const denied = await rival.claim('token-b');
    assert.equal(denied.granted, false,
      'a reconnect gap must not open the room to a rival');
    assert.ok(denied.heldForMs > 0, 'the holder’s lease is what is denying, not a roster race');

    // …and the SAME token re-holds on a fresh connection, as the real bot's
    // reconnect does (new peerId, same claim token).
    const reheld = await rival.claim('token-a');
    assert.equal(reheld.granted, true,
      'the original holder re-claiming over a new socket is a reconnect, not a rival');
    assert.equal(reheld.heldForMs, 0);
  });
});

test('the same token re-holds even while its own aggregator is rostered', async () => {
  // THE regression that made the duplicate bug sticky: the aggregator's page
  // (role=player socket) is in the roster announcing isAggregator, while its
  // probe reconnects from a different socket. The roster check used to see the
  // page's record as a rival and DENY the re-claim — the bot ignored the
  // denial, so the slot sat unheld for the whole meeting.
  await withRelay(async ({ connect }) => {
    const probe = await connect();
    assert.equal((await probe.claim('token-a')).granted, true);

    // The aggregator's page joins the meeting, carrying the claim token.
    const page = await connect('?role=player');
    page.send({ type: 'hello', jitsiId: 'agg-page', displayName: 'Agg', isAggregator: true, claimToken: 'token-a' });
    const roster = await page.waitFor('roster');
    assert.equal(roster.you.isAggregator, true, 'the holder’s own page is a normal aggregator participant');

    // Probe drops and reconnects (fresh socket → fresh peerId) while the page
    // is still rostered: the claim must re-hold, not be denied by our own page.
    probe.ws.close();
    const probe2 = await connect();
    const reheld = await probe2.claim('token-a');
    assert.equal(reheld.granted, true,
      'a record carrying OUR token is us, not a rival — the re-claim must re-hold');

    // Let the (renewed) lease lapse while the page is still rostered: the
    // only thing that can shut a rival out now is the roster record — the
    // aggregator joined, so the room stays held even with no live lease.
    await new Promise((r) => setTimeout(r, LEASE_MS + 100));
    const rival = await connect();
    const denied = await rival.claim('token-b');
    assert.equal(denied.granted, false);
    assert.equal(denied.heldForMs, 0,
      'denied by an already-joined aggregator (no live lease), which is the stronger gate');
  });
});

test('an aggregator page with no valid claim is refused at hello and made invisible', async () => {
  await withRelay(async ({ connect }) => {
    const probe = await connect();
    assert.equal((await probe.claim('token-a')).granted, true);

    // A watcher human, to see what the room does (and does not) announce.
    const human = await connect('?role=player');
    human.send({ type: 'hello', jitsiId: 'human-1', displayName: 'Human' });
    await human.waitFor('roster');

    // A duplicate aggregator — a fleet that lost its state, or a bot whose
    // claim expired between claim and join — announces isAggregator without
    // the holder's token. The pre-join claim can't see all of those cases;
    // this is the last line of defence.
    const dup = await connect('?role=player');
    dup.send({ type: 'hello', jitsiId: 'agg-dup', displayName: 'Dup', isAggregator: true });
    const refused = await dup.waitFor('aggregator-slot-taken');
    assert.ok(refused.heldForMs > 0, 'it is told why, including how long the slot is held');

    const roster = await dup.waitFor('roster');
    assert.equal(roster.you.isAggregator, false,
      'the duplicate never becomes an aggregator participant');
    assert.equal(roster.you.roomIndex, null,
      'it takes no room index — invisible, so it can never be tapped or feed back');

    // And the room never hears about it.
    const announced = new Promise((resolve) => human.ws.once('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'peer-join' && m.peer?.jitsiId === 'agg-dup') resolve(m);
    }));
    const raced = await Promise.race([
      announced.then(() => 'announced'),
      new Promise((r) => setTimeout(() => r('silent'), 150)),
    ]);
    assert.equal(raced, 'silent', 'no peer-join is broadcast for a refused aggregator');
  });
});

test('an explicit release frees the slot at once — and only for the holder', async () => {
  await withRelay(async ({ connect }) => {
    const a = await connect();
    assert.equal((await a.claim('token-a')).granted, true);

    // A late release from a bot that already lost the slot must not free
    // whoever holds it now.
    const stale = await connect();
    stale.send({ type: 'aggregator-claim-release', token: 'token-gone' });
    await new Promise((r) => setTimeout(r, 30));
    const rival = await connect();
    assert.equal((await rival.claim('token-b')).granted, false,
      'a non-holder’s release frees nothing');

    a.send({ type: 'aggregator-claim-release', token: 'token-a' });
    await new Promise((r) => setTimeout(r, 30));
    const admitted = await rival.claim('token-b');
    assert.equal(admitted.granted, true, 'the holder’s release admits a replacement immediately');
  });
});

test('a claimant that dies without releasing holds the slot only for its lease', async () => {
  await withRelay(async ({ connect }) => {
    const a = await connect();
    assert.equal((await a.claim('token-a')).granted, true);
    a.ws.close(); // dies — no release

    const b = await connect();
    const deniedEarly = await b.claim('token-b');
    assert.equal(deniedEarly.granted, false, 'still inside the lease');

    await new Promise((r) => setTimeout(r, LEASE_MS + 100));
    const admitted = await b.claim('token-b');
    assert.equal(admitted.granted, true,
      'an abandoned claim expires, so a dead aggregator never wedges the room');
  });
});
