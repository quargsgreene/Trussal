import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService, suffixFor, ordinalForSuffix, AGGREGATOR_BOT_ID, jitsiUrlForRoom } from '../src/orchestrator/fleet-service.js';
import { createAdminServer } from '../src/config-api/server.js';
import { mergeConfig } from '../src/shared/config.js';

function makeFakeRunner() {
  const calls = { started: [], stopped: [] };
  // Ordered log of op boundaries, so tests can assert a start never begins
  // before a preceding stop (for the same botId) has fully finished — the
  // ordering docker-runner.js relies on (start() force-removes any stale
  // container by name before running a fresh one).
  const log = [];
  let stopGate = null; // when set, stop() awaits it before resolving (simulates docker stop -t 15 still in flight)
  return {
    calls, log,
    // Arms a gate that the NEXT stop() call awaits before resolving (simulates
    // `docker stop -t 15` still in flight). Returns the function that releases it.
    holdNextStop() {
      let release;
      stopGate = new Promise((resolve) => { release = resolve; });
      return () => release();
    },
    async start(botId, extraEnv) {
      log.push(`start-begin:${botId}`);
      calls.started.push({ botId, extraEnv });
      log.push(`start-end:${botId}`);
    },
    async stop(botId) {
      log.push(`stop-begin:${botId}`);
      calls.stopped.push(botId);
      if (stopGate) { const gate = stopGate; stopGate = null; await gate; }
      log.push(`stop-end:${botId}`);
    },
  };
}

// The single meeting the single-room tests below drive. Nothing configures it —
// the fleet has no room setting at all — so these tests name it the same way
// production does: by attaching to a room the relay announced.
const ROOM = 'test-room';

async function withFleet(fn, overrides = {}) {
  const runner = makeFakeRunner();
  const sent = [];
  // Fake bus factory, substituted for the whole connector rather than injected
  // per call: the fleet opens its own sockets exactly as in production, and the
  // room connection's outbound traffic (hello + every fleet-status) lands in
  // `sent`. These tests attach ROOM directly rather than going through
  // discovery, which fleet-room-discovery.test.js covers end to end.
  const connectSidecar = (url, handlers) => {
    const conn = { url, send: (m) => sent.push(m), close: () => {} };
    if (handlers.onOpen) handlers.onOpen(conn.send);
    return conn;
  };
  const fleet = new FleetService(
    mergeConfig({
      maxBots: 5, conductorPort: 0, ownerLeaveGraceMs: 30, meetingEndGraceMs: 30,
      ...overrides,
    }),
    // controlToken is a dependency, not a cfg key — it must never be serialized
    // by the admin API. Supplied so start() doesn't warn on every unrelated test.
    { runner, connectSidecar, controlToken: 'test-token' },
  );
  await fleet.start();
  fleet.attachRoom(ROOM);
  try {
    await fn({ fleet, runner, sent });
  } finally {
    await fleet.stop();
  }
}

test('spawn request starts N containers for the owner with BOT_OWNER_INDEX', async () => {
  await withFleet(async ({ fleet, runner, sent }) => {
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'spawn', count: 3, fromIndex: '1' }, ROOM);
    assert.equal(runner.calls.started.length, 3);
    for (const call of runner.calls.started) {
      assert.deepEqual(call.extraEnv, { BOT_OWNER_INDEX: '1', JITSI_URL: `http://localhost/${ROOM}` });
    }
    const bots = fleet.listBots();
    assert.deepEqual(bots.map(b => b.clusterIndex), ['1a', '1b', '1c']);
    assert.deepEqual(bots.map(b => b.ownerIndex), ['1', '1', '1']);
    const status = sent.find(m => m.type === 'fleet-status' && m.action === 'spawn');
    assert.equal(status.spawned, 3);
    assert.equal(status.requested, 3);
    assert.equal(status.reason, undefined);
  });
});

test('ceiling reached mid-spawn → partial fleet with a surfaced reason', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'spawn', count: 4, fromIndex: '0' }, ROOM);
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'spawn', count: 4, fromIndex: '1' }, ROOM);
    assert.equal(fleet.listBots().length, 5); // ceiling maxBots=5
    const partial = sent.filter(m => m.action === 'spawn')[1];
    assert.equal(partial.spawned, 1);
    assert.equal(partial.requested, 4);
    // The ceiling is a VM-wide budget, so the reason must say that rather than
    // implying something is wrong in the requester's own room.
    assert.match(partial.reason, /host ceiling 5 reached/);
    assert.match(partial.reason, /across all rooms/);
  });
});

test("remove: subset by cluster index, only from the requester's own cluster", async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 3, { room: ROOM });   // 1a 1b 1c
    await fleet.spawnCluster('2', 1, { room: ROOM });   // 2a
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'remove', targets: ['1b', '2a'], fromIndex: '1' }, ROOM);
    const left = fleet.listBots().map(b => b.clusterIndex).sort();
    assert.deepEqual(left, ['1a', '1c', '2a'], "2a survives — it isn't owner 1's bot");
    assert.equal(runner.calls.stopped.length, 1);
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'remove', targets: 'all', fromIndex: '1' }, ROOM);
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex), ['2a']);
  });
});

test("removeOne: the × button removes exactly the one targeted bot from the requester's cluster", async () => {
  await withFleet(async ({ fleet, runner, sent }) => {
    await fleet.spawnCluster('1', 3, { room: ROOM });   // 1a 1b 1c
    await fleet.spawnCluster('2', 1, { room: ROOM });   // 2a
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'removeOne', targets: ['1b'], fromIndex: '1' }, ROOM);
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1c', '2a']);
    assert.equal(runner.calls.stopped.length, 1);
    assert.ok(sent.find(m => m.type === 'fleet-status' && m.removed === 1), 'reports the single removal');
  });
});

test("removeOne: a target in another owner's cluster removes nothing (owner-scoped)", async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 1, { room: ROOM });   // 1a
    await fleet.spawnCluster('2', 1, { room: ROOM });   // 2a
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'removeOne', targets: ['2a'], fromIndex: '1' }, ROOM);
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '2a'], "2a survives — not owner 1's");
    assert.equal(runner.calls.stopped.length, 0);
  });
});

test('removeOne: an unmatched target is a no-op, not a crash', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 2, { room: ROOM });   // 1a 1b
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'removeOne', targets: ['1z'], fromIndex: '1' }, ROOM);
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1b']);
    assert.equal(runner.calls.stopped.length, 0);
  });
});

test('cluster suffixes gap-refill: a removed suffix is reused by the next spawn', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 3, { room: ROOM });           // 1a 1b 1c
    await fleet.removeCluster('1', ['1b'], { room: ROOM });     // frees the middle suffix 'b'
    await fleet.spawnCluster('1', 1, { room: ROOM });           // refills the hole → 1b, not 1d
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1b', '1c']);
  });
});

test('a fully-emptied cluster restarts its suffix sequence (1a again after removeCluster all)', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 2, { room: ROOM });            // 1a 1b
    await fleet.removeCluster('1', 'all', { room: ROOM });       // cluster emptied → ordinal resets
    await fleet.spawnCluster('1', 2, { room: ROOM });            // restarts at 1a,1b, not 1c,1d
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1b']);
  });
});

test('owner leaves → cluster torn down after the grace period; return cancels it', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'pk', roomIndex: '9', isBot: false } }, ROOM);
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'p1', roomIndex: '1', isBot: false } }, ROOM);
    await fleet.spawnCluster('1', 2, { room: ROOM });
    // Owner leaves, then returns before the grace expires → cluster survives.
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'p1' }, ROOM);
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'p1b', roomIndex: '1', isBot: false } }, ROOM);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fleet.listBots().length, 2, 'returning owner keeps the cluster');
    // Owner leaves for good.
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'p1b' }, ROOM);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fleet.listBots().length, 0, 'cluster left after the threshold');
  });
});

test('last human gone → full teardown after meetingEndGraceMs (XMPP constraints)', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    await fleet.spawnCluster('0', 2, { room: ROOM });
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'b1', roomIndex: '0a', isBot: true } }, ROOM);
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' }, ROOM);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fleet.listBots().length, 0);
    assert.ok(sent.some(m => m.action === 'teardown' && /meeting ended/.test(m.reason)));
  });
});

test('health policy preserved: eval-error bot is replaced, keeping its owner', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 4, { room: ROOM });
    // Fleet of 4 metrics, one erroring — shouldReplace fires on errors alone.
    for (const b of fleet.listBots()) {
      fleet.metrics.set(b.botId, {
        botId: b.botId, latencyMs: 50, ramBytes: 100e6, fps: 30,
        errors: b.clusterIndex === '1b' ? ['SyntaxError: boom'] : []
      });
    }
    runner.calls.started.length = 0;
    await fleet.healthTick();
    assert.equal(runner.calls.started.length, 1, 'replacement started');
    assert.deepEqual(runner.calls.started[0].extraEnv, { BOT_OWNER_INDEX: '1', JITSI_URL: `http://localhost/${ROOM}` });
    assert.equal(fleet.listBots().length, 4);
  });
});

test('HTTP contract preserved: /assignment/:botId and POST /metrics', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('0', 1, { room: ROOM });
    const [bot] = fleet.listBots();
    const base = `http://127.0.0.1:${fleet.port}`;
    const a = await fetch(`${base}/assignment/${bot.botId}`);
    assert.equal(a.status, 200);
    const body = await a.json();
    assert.ok(body.script.strudel);
    assert.equal(body.botCount, 1);

    const m = await fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.botId, latencyMs: 42, ramBytes: 1e6, fps: 30 })
    });
    assert.equal(m.status, 200);
    assert.equal(fleet.listBots()[0].lastMetrics.latencyMs, 42);
    assert.equal((await fetch(`${base}/assignment/999`)).status, 404);
  });
});

test('admin API verbatim on the fleet: /api/bots and /api/config keep serving mcp-observer', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 2, { room: ROOM });
    const admin = createAdminServer(fleet);
    await new Promise(r => admin.listen(0, r));
    const base = `http://127.0.0.1:${admin.address().port}`;
    try {
      const bots = await (await fetch(`${base}/api/bots`)).json();
      assert.equal(bots.length, 2);
      assert.ok(bots[0].name, 'breed name');
      assert.ok(bots[0].script.strudel, 'exact strudel code');
      assert.equal(bots[0].clusterIndex, '1a');

      const cfg = await (await fetch(`${base}/api/config`)).json();
      assert.equal(cfg.maxBots, 5);

      // Ceiling change through the admin API shrinks the fleet.
      const post = await fetch(`${base}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxBots: 1 })
      });
      assert.equal(post.status, 200);
      assert.equal(fleet.listBots().length, 1);

      const bad = await fetch(`${base}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bogusKey: 1 })
      });
      assert.equal(bad.status, 400);
    } finally {
      admin.close();
    }
  });
});

test('aggregator: spawns once when a human is present, excluded from clusters/ceiling', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h2', roomIndex: '1', isBot: false } }, ROOM);

    const aggStarts = runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID);
    assert.equal(aggStarts.length, 1, 'exactly one aggregator for the room');
    assert.deepEqual(aggStarts[0].extraEnv, { BOT_ROLE: 'aggregator', JITSI_URL: `http://localhost/${ROOM}` });
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);

    // Filling clusters to the ceiling doesn't count or disturb the aggregator.
    await fleet.spawnCluster('0', 5, { room: ROOM }); // maxBots = 5
    assert.equal(fleet.listBots().length, 5, 'ceiling intact — aggregator not among clusters');
    assert.ok(fleet.listBots().every((b) => b.botId !== AGGREGATOR_BOT_ID));
  });
});

test('aggregator: torn down when the last human leaves (meeting end)', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);

    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' }, ROOM);
    await new Promise((r) => setTimeout(r, 60)); // meetingEndGraceMs = 30
    assert.equal(fleet.aggregatorStatus(ROOM).running, false, 'aggregator leaves with the meeting');
    assert.ok(runner.calls.stopped.includes(AGGREGATOR_BOT_ID));
  });
});

test('aggregator: a rejoin during in-flight teardown waits for the stop instead of racing it (no ghost)', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);

    // Arm the gate before the leave so the meeting-end timer's runner.stop()
    // call — like a real `docker stop -t 15` — is still in flight when the
    // rejoin lands.
    const releaseStop = runner.holdNextStop();
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' }, ROOM);
    await new Promise((r) => setTimeout(r, 60)); // meetingEndGraceMs = 30: teardown fires, stop() blocks on the gate

    // The rejoin lands squarely inside the still-open graceful stop.
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    releaseStop();
    await new Promise((r) => setTimeout(r, 20)); // let both queued ops drain

    const events = runner.log.filter((e) => e.endsWith(`:${AGGREGATOR_BOT_ID}`));
    const stopEndIdx = events.indexOf(`stop-end:${AGGREGATOR_BOT_ID}`);
    const rejoinStartIdx = events.lastIndexOf(`start-begin:${AGGREGATOR_BOT_ID}`);
    assert.notEqual(stopEndIdx, -1);
    assert.notEqual(rejoinStartIdx, -1);
    assert.ok(
      rejoinStartIdx > stopEndIdx,
      `rejoin's start (index ${rejoinStartIdx}) must not begin before the in-flight stop finishes ` +
      `(index ${stopEndIdx}) — starting first races runner.start()'s stale-container removal ` +
      `against the still-leaving old aggregator and leaves a ghost: ${events.join(', ')}`,
    );
    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'the rejoin still ends up with a running aggregator');
  });
});

// The aggregator has no health-replace path (its metrics are deliberately
// kept out of the shouldReplace fleet — see the role-tagged-metrics test
// below), so nothing but an explicit #stopAggregator() call ever clears
// aggregatorRunning. If the container dies on its own — e.g. it lost the
// sidecar's aggregator-claim race on a rejoin and self-exited cleanly — the
// flag was staying stuck true forever, and every future #ensureAggregator
// call (a human reusing the same room URL) would silently no-op, even though
// no aggregator actually existed anymore.
test('aggregator: a dead aggregator (metrics gone silent) is reaped and respawned while a human is present', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1);

    // No metrics ever arrive — models the container self-exiting right after
    // "starting" from fleet-service's point of view (runner.start() itself
    // succeeded; the process inside died moments later).
    await new Promise((r) => setTimeout(r, 70)); // past aggregatorStartupGraceMs(30) + aggregatorStaleMs(30)
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'reaped, then immediately respawned since the human is still here');
    const starts = runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID);
    assert.equal(starts.length, 2, 'the dead aggregator was reaped and a fresh one started in its place');
    assert.ok(runner.calls.stopped.includes(AGGREGATOR_BOT_ID), 'the dead container is cleaned up too, not just forgotten');
  }, { aggregatorStartupGraceMs: 30, aggregatorStaleMs: 30 });
});

test('aggregator: a live aggregator posting metrics on schedule is never reaped', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = () => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5 }),
    });

    await new Promise((r) => setTimeout(r, 40)); // past aggregatorStartupGraceMs(30)
    await postMetrics();
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'not reaped — it just reported');
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1, 'never respawned');

    await new Promise((r) => setTimeout(r, 20)); // still within aggregatorStaleMs(30) of the last report
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'still not reaped — recent enough report');
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1);
  }, { aggregatorStartupGraceMs: 30, aggregatorStaleMs: 30 });
});

test('aggregator: a dead aggregator is reaped but NOT respawned once no human is present', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);

    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' }, ROOM);
    // meetingEndGraceMs is set far longer than this test's wait, so the
    // NORMAL meeting-end teardown (covered elsewhere) cannot be what stops
    // the aggregator here — only #reapDeadAggregator's own staleness check
    // can, isolating the "no human present" branch of the reap path itself.
    await new Promise((r) => setTimeout(r, 70)); // past aggregatorStartupGraceMs(30) + aggregatorStaleMs(30)
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus(ROOM).running, false, 'reaped');
    assert.equal(
      runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1,
      'not respawned — no human is present to want one',
    );
  }, { aggregatorStartupGraceMs: 30, aggregatorStaleMs: 30, meetingEndGraceMs: 5000 });
});

// The live incident this covers: a moderator's "End meeting for all" destroys
// the room; the aggregator's peer-state WS closes correctly (its process
// never dies, never stops reporting metrics), but nothing tells its own
// Jitsi session to leave/rejoin. A human rejoining fast enough (inside
// meetingEndGraceMs) cancels the normal teardown before it can free the
// container, leaving it orphaned — alive, healthy by every OTHER signal,
// permanently useless. aggregatorStaleMs is set effectively unreachable here
// so only the jitsiJoined-based check can be what reaps it.
test('aggregator: sustained jitsiJoined:false (conference orphaned) is reaped and respawned, even with metrics still arriving on schedule', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = (jitsiJoined) => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5, diag: { jitsiJoined } }),
    });

    await new Promise((r) => setTimeout(r, 30)); // past aggregatorStartupGraceMs(20)
    await postMetrics(false);
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'not yet — jitsiJoinGraceMs(80) hasn\'t elapsed since start');

    await new Promise((r) => setTimeout(r, 60));
    await postMetrics(false);
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'reaped, then immediately respawned since the human is still here');
    assert.equal(
      runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 2,
      'the orphaned aggregator was reaped and a fresh one started in its place',
    );
  }, { aggregatorStartupGraceMs: 20, aggregatorStaleMs: 10000, jitsiJoinGraceMs: 80 });
});

test('aggregator: a momentary jitsiJoined:false blip does not trigger a reap', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = (jitsiJoined) => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5, diag: { jitsiJoined } }),
    });

    await new Promise((r) => setTimeout(r, 25)); // past aggregatorStartupGraceMs(20)
    await postMetrics(true); // confirmed joined — resets the orphan clock
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);

    await new Promise((r) => setTimeout(r, 30)); // a blip: well under jitsiJoinGraceMs(80) since the last confirmed join
    await postMetrics(false);
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'a single blip does not reap a healthy aggregator');
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1, 'never respawned');
  }, { aggregatorStartupGraceMs: 20, aggregatorStaleMs: 10000, jitsiJoinGraceMs: 80 });
});

// The player-bot counterpart: shouldReplace has no signal for "process fine,
// Jitsi conference gone" at all (it only looks at errors/latency/ram), so a
// bot orphaned the same way the aggregator was would otherwise run forever
// producing sound nobody hears.
test('player bot: orphaned from its Jitsi conference (sustained jitsiJoined:false) is replaced', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 1, { room: ROOM });
    const [bot] = fleet.listBots();
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = (jitsiJoined) => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.botId, latencyMs: 5, ramBytes: 1e6, fps: 30, errors: [], diag: { jitsiJoined } }),
    });
    runner.calls.started.length = 0; // isolate replacement starts from the initial spawn

    await new Promise((r) => setTimeout(r, 25));
    await postMetrics(false);
    await fleet.healthTick();
    assert.equal(runner.calls.started.length, 0, 'not yet — jitsiJoinGraceMs(80) hasn\'t elapsed since it started');

    await new Promise((r) => setTimeout(r, 60));
    await postMetrics(false);
    await fleet.healthTick();

    assert.equal(runner.calls.started.length, 1, 'the orphaned bot was replaced');
    assert.deepEqual(runner.calls.started[0].extraEnv, { BOT_OWNER_INDEX: '1', JITSI_URL: `http://localhost/${ROOM}` });
    assert.equal(fleet.listBots().length, 1, 'still exactly one bot for owner 1 — same slot, fresh container');
  }, { jitsiJoinGraceMs: 80 });
});

test('player bot: a momentary jitsiJoined:false blip does not trigger a replace', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 1, { room: ROOM });
    const [bot] = fleet.listBots();
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = (jitsiJoined) => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.botId, latencyMs: 5, ramBytes: 1e6, fps: 30, errors: [], diag: { jitsiJoined } }),
    });
    runner.calls.started.length = 0;

    await new Promise((r) => setTimeout(r, 25));
    await postMetrics(true); // confirmed joined — resets the orphan clock
    await fleet.healthTick();
    assert.equal(runner.calls.started.length, 0);

    await new Promise((r) => setTimeout(r, 30)); // a blip: well under jitsiJoinGraceMs(80) since the last confirmed join
    await postMetrics(false);
    await fleet.healthTick();

    assert.equal(runner.calls.started.length, 0, 'a single blip does not replace a healthy bot');
  }, { jitsiJoinGraceMs: 80 });
});

// The exact live report: aggregator now respawns correctly on a fresh join,
// but bots from the old (destroyed) meeting kept running and even got
// auto-respawned in place by the orphan-detection fix above — a new meeting
// should start with NO bots; they must be spawned fresh by the human. The
// sidecar's session-reset (only-fleet-left) fires for the OLD meeting before
// the human's fast rejoin lands under a fresh identity, exactly matching what
// was observed live.
test('session-reset clears old bots and the old aggregator, even when a fast rejoin already re-registered a human present', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h1', roomIndex: '0', isBot: false } }, ROOM);
    await fleet.spawnCluster('0', 2, { room: ROOM });
    assert.equal(fleet.listBots().length, 2);
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);
    runner.calls.started.length = 0; // isolate what happens after the reset

    // The old meeting ends: human leaves, then — before our own
    // meetingEndGraceMs timer could fire — the sidecar's session-reset
    // arrives (the room went fleet-only), and only then does the human's
    // fast rejoin land under a fresh identity.
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h1' }, ROOM);
    await fleet.handleBusMessage({ type: 'session-reset' }, ROOM);
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h2', roomIndex: '0', isBot: false } }, ROOM);

    assert.equal(fleet.listBots().length, 0, 'old bots gone — a new meeting starts with none, must be spawned fresh');
    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'a fresh aggregator DOES spawn for the rejoined human');
    assert.equal(
      runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1,
      'exactly one fresh aggregator start, not a leftover from before the reset',
    );
  });
});

test('roster reconcile heals a missed leave → meeting-end teardown still fires', async () => {
  await withFleet(async ({ fleet, runner, sent }) => {
    // Human joins; aggregator spawns.
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    assert.equal(fleet.aggregatorStatus(ROOM).running, true);
    // The human left while our bus socket was down, so we never saw peer-leave.
    // On reconnect the sidecar replays the authoritative roster — now humanless.
    await fleet.handleBusMessage({ type: 'roster', peers: [] }, ROOM);
    await new Promise((resolve) => setTimeout(resolve, 60)); // meetingEndGraceMs = 30
    assert.equal(fleet.aggregatorStatus(ROOM).running, false, 'reconcile armed the teardown');
    assert.ok(runner.calls.stopped.includes(AGGREGATOR_BOT_ID));
    assert.ok(sent.some((status) => status.action === 'teardown' && /meeting ended/.test(status.reason)));
  });
});

test('roster reconcile keeps a still-present human → no teardown', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);
    // Reconnect roster still lists the human (fresh peerId, same room index).
    await fleet.handleBusMessage({ type: 'roster', peers: [{ peerId: 'h2', roomIndex: '0', isBot: false }] }, ROOM);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'human still present → aggregator stays');
  });
});

test('roster reconcile drops a departed owner’s cluster while the meeting continues', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'a', roomIndex: '0', isBot: false } }, ROOM);
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'b', roomIndex: '1', isBot: false } }, ROOM);
    await fleet.spawnCluster('0', 1, { room: ROOM }); // owner 0 has a bot
    // Reconnect roster: owner 0 is gone, owner 1 is still here.
    await fleet.handleBusMessage({ type: 'roster', peers: [{ peerId: 'b', roomIndex: '1', isBot: false }] }, ROOM);
    await new Promise((resolve) => setTimeout(resolve, 60)); // ownerLeaveGraceMs = 30
    assert.equal(fleet.listBots().length, 0, 'departed owner’s cluster torn down');
    assert.equal(fleet.aggregatorStatus(ROOM).running, true, 'meeting continues — owner 1 present');
  });
});

test('aggregator: role-tagged metrics are recorded but kept out of the health map', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 1, { room: ROOM });
    const [bot] = fleet.listBots();
    const base = `http://127.0.0.1:${fleet.port}`;
    // A human gives this room an aggregator, so AGGREGATOR_BOT_ID is a claimed
    // container id: samples are attributed to the room that owns the id, and an
    // unclaimed one belongs to a container already reaped.
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } }, ROOM);

    await fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5 }),
    });
    assert.equal(fleet.aggregatorStatus(ROOM).metrics.role, 'aggregator');
    assert.equal(fleet.metrics.has(AGGREGATOR_BOT_ID), false, 'aggregator sample stays out of the health map');

    // A normal player metric still lands in the health map as before.
    await fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.botId, fps: 30, ramBytes: 1e6, latencyMs: 7 }),
    });
    assert.equal(fleet.metrics.get(bot.botId).latencyMs, 7);
  });
});

// --- multi-room: an aggregator for whatever room people actually opened -----
// The fleet used to join one configured room's bus, so a human in any other
// room was never seen and never got an aggregator. These pin the replacement:
// rooms are discovered over the control channel, and every room served runs its
// own aggregator, pointed at that room through JITSI_URL.

test('jitsiUrlForRoom swaps the room segment the bundle and bots key on', () => {
  assert.equal(jitsiUrlForRoom('http://localhost/0', 'myroom'), 'http://localhost/myroom');
  assert.equal(jitsiUrlForRoom('https://trussal.com/0', '0'), 'https://trussal.com/0');
  // A base URL carrying a path prefix keeps it; only the last segment is the room.
  assert.equal(jitsiUrlForRoom('https://host/jitsi/0', 'gig'), 'https://host/jitsi/gig');
  // No path at all — the room is simply appended rather than replacing nothing.
  assert.equal(jitsiUrlForRoom('https://host', 'gig'), 'https://host/gig');
  // A trailing slash means "mount point", not "room": the prefix must survive.
  // Eating it would point every bot outside the Jitsi mount, at a 404.
  assert.equal(jitsiUrlForRoom('https://host/jitsi/', 'gig'), 'https://host/jitsi/gig');
  assert.equal(jitsiUrlForRoom('https://host/', 'gig'), 'https://host/gig');
  // Unparseable config is left exactly as the operator set it, not mangled.
  assert.equal(jitsiUrlForRoom('not a url', 'gig'), 'not a url');
});

// Jitsi's XMPP layer lowercases the MUC room name regardless of URL casing,
// so /sdA and /sda are the same physical meeting. The sidecar normalizes for
// this too (server.js), but requireRoom lowercases independently — every
// entry point that names a room funnels through it, so this is the fleet's
// own backstop against ever minting two `this.rooms` entries for one meeting.
test('attachRoom normalizes case, so a differently-cased announcement joins the same room', async () => {
  await withDiscoveringFleet(async ({ fleet, bus }) => {
    fleet.attachRoom('sdA');
    fleet.attachRoom('sda');
    assert.equal(bus.conns.filter((c) => c.url.includes('role=fleet')).length, 1,
      'one fleet bus for the meeting, not two');
    assert.deepEqual(fleet.roomsStatus().map((s) => s.room), ['sda']);
  });
});

// Fake sidecar connector: records every URL the fleet opens and lets a test
// deliver messages on it, standing in for the relay.
function makeFakeConnector() {
  const conns = [];
  const connectSidecar = (url, handlers) => {
    const conn = {
      url, handlers, sent: [], closed: false,
      send: (m) => conn.sent.push(m),
      close: () => { conn.closed = true; },
      deliver: (msg) => handlers.onMessage(msg),
    };
    conns.push(conn);
    if (handlers.onOpen) handlers.onOpen(conn.send);
    return conn;
  };
  const roomConn = (room) => conns.find((c) => c.url.includes(`room=${encodeURIComponent(room)}`));
  return { conns, connectSidecar, roomConn, control: () => conns.find((c) => c.url.includes('role=control')) };
}

async function withDiscoveringFleet(fn, overrides = {}) {
  const runner = makeFakeRunner();
  const bus = makeFakeConnector();
  const fleet = new FleetService(
    mergeConfig({ maxBots: 5, conductorPort: 0, ownerLeaveGraceMs: 30, meetingEndGraceMs: 30, ...overrides }),
    { runner, connectSidecar: bus.connectSidecar },
  );
  await fleet.start();
  try {
    await fn({ fleet, runner, bus });
  } finally {
    await fleet.stop();
  }
}

test('a room announced on the control channel is served, whatever it is called', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    const control = bus.control();
    assert.ok(control, 'the fleet opens a relay-wide control connection, not a per-room one');

    await control.handlers.onMessage({ type: 'room-active', room: 'saturday-night' });
    const room = bus.roomConn('saturday-night');
    assert.ok(room, 'the announced room gets its own bus connection');
    assert.match(room.url, /role=fleet/);
    assert.deepEqual(room.sent[0], {
      type: 'hello', jitsiId: 'fleet-saturday-night', displayName: 'fleet-service', isFleet: true,
    });

    // A human in that room is what calls for an aggregator.
    await room.deliver({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    const agg = runner.calls.started.find((c) => c.extraEnv.BOT_ROLE === 'aggregator');
    assert.ok(agg, 'an aggregator spawned for a room that is not "0"');
    assert.equal(agg.extraEnv.JITSI_URL, 'http://localhost/saturday-night',
      'and it is pointed at that room — the bot derives its Jitsi/sidecar/O2 URLs from this');
    assert.equal(fleet.aggregatorStatus('saturday-night').running, true);
  });
});

test('the initial room snapshot adopts meetings already in progress', async () => {
  await withDiscoveringFleet(async ({ runner, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['alpha', 'beta'] });
    assert.ok(bus.roomConn('alpha') && bus.roomConn('beta'), 'both in-progress rooms are served');

    // Re-announcing an already-served room must not open a second socket.
    const before = bus.conns.length;
    await bus.control().handlers.onMessage({ type: 'room-active', room: 'alpha' });
    assert.equal(bus.conns.length, before, 'attachRoom is idempotent');

    await bus.roomConn('alpha').deliver({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    assert.equal(runner.calls.started.filter((c) => c.extraEnv.BOT_ROLE === 'aggregator').length, 1);
  });
});

test('concurrent rooms each get their own aggregator, on distinct container ids', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['one', 'two'] });
    await bus.roomConn('one').deliver({ type: 'peer-join', peer: { peerId: 'h1', roomIndex: '0', isBot: false } });
    await bus.roomConn('two').deliver({ type: 'peer-join', peer: { peerId: 'h2', roomIndex: '0', isBot: false } });

    const aggs = runner.calls.started.filter((c) => c.extraEnv.BOT_ROLE === 'aggregator');
    assert.equal(aggs.length, 2, 'one aggregator per meeting');
    assert.deepEqual(aggs.map((a) => a.extraEnv.JITSI_URL).sort(),
      ['http://localhost/one', 'http://localhost/two']);
    // Container names are trussal-bot-<id>, so two live aggregators sharing an
    // id would collide and the second `docker run` would clobber the first.
    assert.equal(new Set(aggs.map((a) => a.botId)).size, 2, 'distinct container ids');
    assert.ok(aggs.some((a) => a.botId === AGGREGATOR_BOT_ID), 'the first room keeps the familiar id');

    assert.equal(fleet.aggregatorStatus('one').running, true);
    assert.equal(fleet.aggregatorStatus('two').running, true);
  });
});

test('multi-shard: a control connection per shard, and either shard can announce a room', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    const controls = bus.conns.filter((c) => c.url.includes('role=control'));
    assert.equal(controls.length, 2, 'one ?role=control connection per shard sidecar');
    assert.deepEqual(controls.map((c) => c.url).sort(),
      ['ws://s1.rack/ws?role=control', 'ws://s2.rack/ws?role=control']);

    // s1 announces one room, s2 announces another — the fleet serves both.
    await controls[0].handlers.onMessage({ type: 'room-active', room: 'on-s1' });
    await controls[1].handlers.onMessage({ type: 'rooms', rooms: ['on-s2'] });
    assert.deepEqual(fleet.roomsStatus().map((s) => s.room).sort(), ['on-s1', 'on-s2']);

    // Per-room ?role=fleet connections still go to the one sidecarWsUrl (the
    // edge LB), which routes them by ?room=.
    for (const room of ['on-s1', 'on-s2']) {
      assert.match(bus.roomConn(room).url, /^ws:\/\/edge\/ws\?room=/);
    }
  }, { sidecarWsUrl: 'ws://edge/ws', sidecarControlUrls: ['ws://s1.rack/ws', 'ws://s2.rack/ws'] });
});

test('multi-shard: stop() closes every shard control connection', async () => {
  const runner = makeFakeRunner();
  const bus = makeFakeConnector();
  const fleet = new FleetService(
    mergeConfig({ maxBots: 5, conductorPort: 0, sidecarControlUrls: ['ws://s1/ws', 'ws://s2/ws'] }),
    { runner, connectSidecar: bus.connectSidecar },
  );
  await fleet.start();
  await fleet.stop();
  const controls = bus.conns.filter((c) => c.url.includes('role=control'));
  assert.equal(controls.length, 2);
  assert.ok(controls.every((c) => c.closed), 'both shard control connections closed');
});

test('one room ending leaves the other room’s aggregator and bots alone', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['staying', 'leaving'] });
    for (const room of ['staying', 'leaving']) {
      await bus.roomConn(room).deliver({ type: 'peer-join', peer: { peerId: `h-${room}`, roomIndex: '0', isBot: false } });
      await fleet.spawnCluster('0', 1, { room });
    }
    assert.equal(fleet.listBots().length, 2);

    // Owner index '0' exists in BOTH meetings — a teardown must not reach across.
    await bus.roomConn('leaving').deliver({ type: 'session-reset' });

    assert.deepEqual(fleet.listBots().map((b) => b.room), ['staying']);
    assert.equal(fleet.aggregatorStatus('staying').running, true, 'the other meeting is untouched');
    assert.equal(fleet.aggregatorStatus('leaving').running, false);
    assert.ok(runner.calls.stopped.length >= 2, 'the ended room stopped its own bot and aggregator');
  });
});

test('a spawn request is served in the room it came from', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['here', 'there'] });
    await bus.roomConn('here').deliver({ type: 'fleet-request', action: 'spawn', count: 2, fromIndex: '1' });

    const players = runner.calls.started.filter((c) => c.extraEnv.BOT_OWNER_INDEX === '1');
    assert.equal(players.length, 2);
    for (const p of players) assert.equal(p.extraEnv.JITSI_URL, 'http://localhost/here');
    assert.deepEqual(fleet.listBots().map((b) => b.room), ['here', 'here']);
    // The status goes back to the requesting room's bus, not some other room's.
    assert.ok(bus.roomConn('here').sent.some((m) => m.type === 'fleet-status' && m.spawned === 2));
    assert.ok(!bus.roomConn('there').sent.some((m) => m.type === 'fleet-status'));
  });
});

test('cluster suffixes are per room: the same owner index spawns 1a in each', async () => {
  await withDiscoveringFleet(async ({ fleet, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['r1', 'r2'] });
    await fleet.spawnCluster('1', 1, { room: 'r1' });
    await fleet.spawnCluster('1', 1, { room: 'r2' });
    // The sidecar assigns suffixes per room, so the fleet's mirror must too —
    // otherwise the fleet thinks r2's bot is '1b' while the relay calls it '1a'.
    assert.deepEqual(fleet.listBots().map((b) => b.clusterIndex), ['1a', '1a']);

    await fleet.removeCluster('1', 'all', { room: 'r1' });
    assert.deepEqual(fleet.listBots().map((b) => ({ room: b.room, idx: b.clusterIndex })),
      [{ room: 'r2', idx: '1a' }], "removing one room's cluster leaves the other's");
  });
});

test('a rejoin during a meeting-end teardown keeps the room served', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    await bus.control().handlers.onMessage({ type: 'room-active', room: 'flaky' });
    const room = bus.roomConn('flaky');
    await room.deliver({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });

    // Teardown begins with the aggregator's stop still in flight; the human
    // returns before it settles.
    const release = runner.holdNextStop();
    await room.deliver({ type: 'peer-leave', peerId: 'h' });
    await new Promise((r) => setTimeout(r, 60));   // meetingEndGraceMs = 30
    await room.deliver({ type: 'peer-join', peer: { peerId: 'h2', roomIndex: '0', isBot: false } });
    release();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(fleet.aggregatorStatus('flaky').running, true, 'the returning human still has an aggregator');
    assert.equal(room.closed, false, 'the room bus was not dropped out from under the live meeting');
  });
});

// --- cross-room isolation hazards -------------------------------------------
// Everything below is a way one meeting could reach into another once the
// service went multi-room. Each is cheap to get wrong and silent in production.

test('an aggregator container id stays claimed while its container is stopping', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    await bus.control().handlers.onMessage({ type: 'room-active', room: 'ending' });
    await bus.roomConn('ending').deliver({ type: 'peer-join', peer: { peerId: 'h1', roomIndex: '0', isBot: false } });
    const claimed = fleet.roomsStatus().find((r) => r.room === 'ending').aggregatorId;

    // What the fleet believes is claimed at the moment `docker stop` is running.
    // Aggregator queues are per room, so another room's #ensureAggregator can
    // run right here; #allocateAggregatorId hands out any id no room claims and
    // runner.start() begins with `docker rm -f <name>`, so an id released before
    // the container is gone gets the dying container SIGKILLed mid-leave().
    let claimedDuringStop = null;
    const realStop = runner.stop.bind(runner);
    runner.stop = async (botId) => {
      claimedDuringStop = fleet.roomsStatus().map((r) => r.aggregatorId);
      return realStop(botId);
    };

    await bus.roomConn('ending').deliver({ type: 'session-reset' });

    assert.ok(claimedDuringStop, 'the aggregator was never stopped');
    assert.ok(claimedDuringStop.includes(claimed),
      'the id was released before the container was gone — another room could claim and kill it');
  });
});

test('a torn-down room’s pending timers cannot reach the meeting that reuses the name', async () => {
  await withDiscoveringFleet(async ({ fleet, runner, bus }) => {
    await bus.control().handlers.onMessage({ type: 'room-active', room: 'recycled' });
    const room = bus.roomConn('recycled');
    await room.deliver({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '1', isBot: false } });
    await fleet.spawnCluster('1', 1, { room: 'recycled' });

    // peer-leave arms both countdowns; session-reset then tears the room down
    // and detaches it while those timers are still pending.
    await room.deliver({ type: 'peer-leave', peerId: 'h' });
    await room.deliver({ type: 'session-reset' });

    // The name is reused by a new meeting straight away.
    await bus.control().handlers.onMessage({ type: 'room-active', room: 'recycled' });
    const fresh = bus.roomConn('recycled');
    await fresh.deliver({ type: 'peer-join', peer: { peerId: 'h2', roomIndex: '1', isBot: false } });
    await fleet.spawnCluster('1', 1, { room: 'recycled' });

    // Well past both ownerLeaveGraceMs and meetingEndGraceMs (30ms each here).
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fleet.aggregatorStatus('recycled').running, true,
      'a stale meeting-end timer killed the new meeting’s aggregator');
    assert.equal(fleet.listBots().length, 1, 'a stale owner timer removed the new meeting’s cluster');
    assert.ok(!runner.calls.stopped.includes(fleet.listBots()[0].botId));
  });
});

test('session-reset clears a stale roster shadow instead of trusting it', async () => {
  await withDiscoveringFleet(async ({ fleet, bus }) => {
    await bus.control().handlers.onMessage({ type: 'room-active', room: 'blipped' });
    const room = bus.roomConn('blipped');
    await room.deliver({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });

    // The relay says the room is empty, but our shadow still lists the human
    // (the missed-peer-leave case this branch exists for). Trusting the shadow
    // would keep the room attached forever with a countdown that never arms.
    await room.deliver({ type: 'session-reset' });

    assert.equal(fleet.aggregatorStatus('blipped').running, false);
    assert.ok(!fleet.roomsStatus().some((r) => r.room === 'blipped'),
      'the room was released, not pinned by a ghost participant');
  });
});

test('generated scripts are scoped to their own room’s bot count', async () => {
  await withDiscoveringFleet(async ({ fleet, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['small', 'big'] });
    await fleet.spawnCluster('0', 1, { room: 'small' });

    // Same bot, same id, before and after an unrelated meeting fills up.
    // applyConfig({}) changes nothing but forces a redistribute, which is what
    // regenerates every script.
    const soloId = fleet.listBots().find((b) => b.room === 'small').botId;
    await fleet.applyConfig({});
    const alone = fleet.bots.get(soloId).script;

    await fleet.spawnCluster('0', 3, { room: 'big' });
    await fleet.applyConfig({});
    const withNeighbours = fleet.bots.get(soloId).script;

    // botCount drives frequency-band width, the stereoTiles composite grid and
    // gain staging. The solo room still holds exactly one bot, so nothing about
    // its pattern may change because a different meeting grew.
    assert.deepEqual(withNeighbours, alone,
      'the 3-bot meeting next door rewrote the solo room’s pattern');
  });
});

test('a ceiling shrink tells every room it took bots from', async () => {
  await withDiscoveringFleet(async ({ fleet, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['quiet', 'busy'] });
    await fleet.spawnCluster('0', 1, { room: 'quiet' });
    await fleet.spawnCluster('0', 3, { room: 'busy' });

    // One overloaded bot drags the VM-wide ceiling down; #shrinkTo takes the
    // newest bots, which belong to whichever room spawned last.
    for (const b of fleet.listBots()) {
      fleet.metrics.set(b.botId, { botId: b.botId, latencyMs: 20, ramBytes: 5000e6, fps: 30, errors: [] });
    }
    await fleet.healthTick();

    const removed = bus.roomConn('busy').sent.filter((m) => m.type === 'fleet-status' && m.action === 'remove');
    assert.ok(removed.length > 0, 'the room whose bots were taken was never told');
    assert.match(removed[0].reason, /host ceiling/);
  }, { maxBots: 4 });
});

test('spawn status reports the requesting room’s own cluster size', async () => {
  await withDiscoveringFleet(async ({ fleet, bus }) => {
    await bus.control().handlers.onMessage({ type: 'rooms', rooms: ['mine', 'theirs'] });
    await fleet.spawnCluster('0', 3, { room: 'theirs' });
    await bus.roomConn('mine').deliver({ type: 'fleet-request', action: 'spawn', count: 1, fromIndex: '0' });

    const status = bus.roomConn('mine').sent.find((m) => m.type === 'fleet-status' && m.action === 'spawn');
    assert.equal(status.fleetSize, 1, 'a room must not be shown other meetings’ bot counts');
  });
});

test('suffixFor matches the shared index grammar', () => {
  assert.equal(suffixFor(0), 'a');
  assert.equal(suffixFor(25), 'z');
  assert.equal(suffixFor(26), 'za');
  assert.equal(suffixFor(27), 'zb');
  assert.equal(suffixFor(52), 'zza');
});

test('ordinalForSuffix inverts suffixFor (used to gap-refill from live suffixes)', () => {
  for (const ordinal of [0, 1, 25, 26, 27, 52, 53, 100]) {
    assert.equal(ordinalForSuffix(suffixFor(ordinal)), ordinal);
  }
});
