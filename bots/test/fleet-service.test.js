import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService, suffixFor, ordinalForSuffix, AGGREGATOR_BOT_ID } from '../src/orchestrator/fleet-service.js';
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

async function withFleet(fn, overrides = {}) {
  const runner = makeFakeRunner();
  const sent = [];
  const fleet = new FleetService(
    mergeConfig({ maxBots: 5, conductorPort: 0, ownerLeaveGraceMs: 30, meetingEndGraceMs: 30, ...overrides }),
    { runner },
  );
  // Fake bus: capture outbound fleet-status without a real socket.
  fleet.sidecar = { send: (m) => sent.push(m), close: () => {} };
  await fleet.start();
  try {
    await fn({ fleet, runner, sent });
  } finally {
    await fleet.stop();
  }
}

test('spawn request starts N containers for the owner with BOT_OWNER_INDEX', async () => {
  await withFleet(async ({ fleet, runner, sent }) => {
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'spawn', count: 3, fromIndex: '1' });
    assert.equal(runner.calls.started.length, 3);
    for (const call of runner.calls.started) {
      assert.deepEqual(call.extraEnv, { BOT_OWNER_INDEX: '1' });
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
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'spawn', count: 4, fromIndex: '0' });
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'spawn', count: 4, fromIndex: '1' });
    assert.equal(fleet.listBots().length, 5); // ceiling maxBots=5
    const partial = sent.filter(m => m.action === 'spawn')[1];
    assert.equal(partial.spawned, 1);
    assert.equal(partial.requested, 4);
    assert.match(partial.reason, /health ceiling 5/);
  });
});

test("remove: subset by cluster index, only from the requester's own cluster", async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 3);   // 1a 1b 1c
    await fleet.spawnCluster('2', 1);   // 2a
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'remove', targets: ['1b', '2a'], fromIndex: '1' });
    const left = fleet.listBots().map(b => b.clusterIndex).sort();
    assert.deepEqual(left, ['1a', '1c', '2a'], "2a survives — it isn't owner 1's bot");
    assert.equal(runner.calls.stopped.length, 1);
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'remove', targets: 'all', fromIndex: '1' });
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex), ['2a']);
  });
});

test("removeOne: the × button removes exactly the one targeted bot from the requester's cluster", async () => {
  await withFleet(async ({ fleet, runner, sent }) => {
    await fleet.spawnCluster('1', 3);   // 1a 1b 1c
    await fleet.spawnCluster('2', 1);   // 2a
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'removeOne', target: '1b', fromIndex: '1' });
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1c', '2a']);
    assert.equal(runner.calls.stopped.length, 1);
    assert.ok(sent.find(m => m.type === 'fleet-status' && m.removed === 1), 'reports the single removal');
  });
});

test("removeOne: a target in another owner's cluster removes nothing (owner-scoped)", async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 1);   // 1a
    await fleet.spawnCluster('2', 1);   // 2a
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'removeOne', target: '2a', fromIndex: '1' });
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '2a'], "2a survives — not owner 1's");
    assert.equal(runner.calls.stopped.length, 0);
  });
});

test('removeOne: an unmatched target is a no-op, not a crash', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 2);   // 1a 1b
    await fleet.handleBusMessage({ type: 'fleet-request', action: 'removeOne', target: '1z', fromIndex: '1' });
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1b']);
    assert.equal(runner.calls.stopped.length, 0);
  });
});

test('cluster suffixes gap-refill: a removed suffix is reused by the next spawn', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 3);           // 1a 1b 1c
    await fleet.removeCluster('1', ['1b']);     // frees the middle suffix 'b'
    await fleet.spawnCluster('1', 1);           // refills the hole → 1b, not 1d
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1b', '1c']);
  });
});

test('a fully-emptied cluster restarts its suffix sequence (1a again after removeCluster all)', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 2);            // 1a 1b
    await fleet.removeCluster('1', 'all');       // cluster emptied → ordinal resets
    await fleet.spawnCluster('1', 2);            // restarts at 1a,1b, not 1c,1d
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1a', '1b']);
  });
});

test('owner leaves → cluster torn down after the grace period; return cancels it', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'pk', roomIndex: '9', isBot: false } });
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'p1', roomIndex: '1', isBot: false } });
    await fleet.spawnCluster('1', 2);
    // Owner leaves, then returns before the grace expires → cluster survives.
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'p1' });
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'p1b', roomIndex: '1', isBot: false } });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fleet.listBots().length, 2, 'returning owner keeps the cluster');
    // Owner leaves for good.
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'p1b' });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fleet.listBots().length, 0, 'cluster left after the threshold');
  });
});

test('last human gone → full teardown after meetingEndGraceMs (XMPP constraints)', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    await fleet.spawnCluster('0', 2);
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'b1', roomIndex: '0a', isBot: true } });
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fleet.listBots().length, 0);
    assert.ok(sent.some(m => m.action === 'teardown' && /meeting ended/.test(m.reason)));
  });
});

test('health policy preserved: eval-error bot is replaced, keeping its owner', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 4);
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
    assert.deepEqual(runner.calls.started[0].extraEnv, { BOT_OWNER_INDEX: '1' });
    assert.equal(fleet.listBots().length, 4);
  });
});

test('HTTP contract preserved: /assignment/:botId and POST /metrics', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('0', 1);
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
    await fleet.spawnCluster('1', 2);
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
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h2', roomIndex: '1', isBot: false } });

    const aggStarts = runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID);
    assert.equal(aggStarts.length, 1, 'exactly one aggregator for the room');
    assert.deepEqual(aggStarts[0].extraEnv, { BOT_ROLE: 'aggregator' });
    assert.equal(fleet.aggregatorStatus().running, true);

    // Filling clusters to the ceiling doesn't count or disturb the aggregator.
    await fleet.spawnCluster('0', 5); // maxBots = 5
    assert.equal(fleet.listBots().length, 5, 'ceiling intact — aggregator not among clusters');
    assert.ok(fleet.listBots().every((b) => b.botId !== AGGREGATOR_BOT_ID));
  });
});

test('aggregator: torn down when the last human leaves (meeting end)', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    assert.equal(fleet.aggregatorStatus().running, true);

    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' });
    await new Promise((r) => setTimeout(r, 60)); // meetingEndGraceMs = 30
    assert.equal(fleet.aggregatorStatus().running, false, 'aggregator leaves with the meeting');
    assert.ok(runner.calls.stopped.includes(AGGREGATOR_BOT_ID));
  });
});

test('aggregator: a rejoin during in-flight teardown waits for the stop instead of racing it (no ghost)', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    assert.equal(fleet.aggregatorStatus().running, true);

    // Arm the gate before the leave so the meeting-end timer's runner.stop()
    // call — like a real `docker stop -t 15` — is still in flight when the
    // rejoin lands.
    const releaseStop = runner.holdNextStop();
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' });
    await new Promise((r) => setTimeout(r, 60)); // meetingEndGraceMs = 30: teardown fires, stop() blocks on the gate

    // The rejoin lands squarely inside the still-open graceful stop.
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
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
    assert.equal(fleet.aggregatorStatus().running, true, 'the rejoin still ends up with a running aggregator');
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
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    assert.equal(fleet.aggregatorStatus().running, true);
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1);

    // No metrics ever arrive — models the container self-exiting right after
    // "starting" from fleet-service's point of view (runner.start() itself
    // succeeded; the process inside died moments later).
    await new Promise((r) => setTimeout(r, 70)); // past aggregatorStartupGraceMs(30) + aggregatorStaleMs(30)
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus().running, true, 'reaped, then immediately respawned since the human is still here');
    const starts = runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID);
    assert.equal(starts.length, 2, 'the dead aggregator was reaped and a fresh one started in its place');
    assert.ok(runner.calls.stopped.includes(AGGREGATOR_BOT_ID), 'the dead container is cleaned up too, not just forgotten');
  }, { aggregatorStartupGraceMs: 30, aggregatorStaleMs: 30 });
});

test('aggregator: a live aggregator posting metrics on schedule is never reaped', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = () => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5 }),
    });

    await new Promise((r) => setTimeout(r, 40)); // past aggregatorStartupGraceMs(30)
    await postMetrics();
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus().running, true, 'not reaped — it just reported');
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1, 'never respawned');

    await new Promise((r) => setTimeout(r, 20)); // still within aggregatorStaleMs(30) of the last report
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus().running, true, 'still not reaped — recent enough report');
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1);
  }, { aggregatorStartupGraceMs: 30, aggregatorStaleMs: 30 });
});

test('aggregator: a dead aggregator is reaped but NOT respawned once no human is present', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    assert.equal(fleet.aggregatorStatus().running, true);

    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h' });
    // meetingEndGraceMs is set far longer than this test's wait, so the
    // NORMAL meeting-end teardown (covered elsewhere) cannot be what stops
    // the aggregator here — only #reapDeadAggregator's own staleness check
    // can, isolating the "no human present" branch of the reap path itself.
    await new Promise((r) => setTimeout(r, 70)); // past aggregatorStartupGraceMs(30) + aggregatorStaleMs(30)
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus().running, false, 'reaped');
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
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = (jitsiJoined) => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5, diag: { jitsiJoined } }),
    });

    await new Promise((r) => setTimeout(r, 30)); // past aggregatorStartupGraceMs(20)
    await postMetrics(false);
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus().running, true, 'not yet — jitsiJoinGraceMs(80) hasn\'t elapsed since start');

    await new Promise((r) => setTimeout(r, 60));
    await postMetrics(false);
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus().running, true, 'reaped, then immediately respawned since the human is still here');
    assert.equal(
      runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 2,
      'the orphaned aggregator was reaped and a fresh one started in its place',
    );
  }, { aggregatorStartupGraceMs: 20, aggregatorStaleMs: 10000, jitsiJoinGraceMs: 80 });
});

test('aggregator: a momentary jitsiJoined:false blip does not trigger a reap', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    const base = `http://127.0.0.1:${fleet.port}`;
    const postMetrics = (jitsiJoined) => fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5, diag: { jitsiJoined } }),
    });

    await new Promise((r) => setTimeout(r, 25)); // past aggregatorStartupGraceMs(20)
    await postMetrics(true); // confirmed joined — resets the orphan clock
    await fleet.healthTick();
    assert.equal(fleet.aggregatorStatus().running, true);

    await new Promise((r) => setTimeout(r, 30)); // a blip: well under jitsiJoinGraceMs(80) since the last confirmed join
    await postMetrics(false);
    await fleet.healthTick();

    assert.equal(fleet.aggregatorStatus().running, true, 'a single blip does not reap a healthy aggregator');
    assert.equal(runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1, 'never respawned');
  }, { aggregatorStartupGraceMs: 20, aggregatorStaleMs: 10000, jitsiJoinGraceMs: 80 });
});

// The player-bot counterpart: shouldReplace has no signal for "process fine,
// Jitsi conference gone" at all (it only looks at errors/latency/ram), so a
// bot orphaned the same way the aggregator was would otherwise run forever
// producing sound nobody hears.
test('player bot: orphaned from its Jitsi conference (sustained jitsiJoined:false) is replaced', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 1);
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
    assert.deepEqual(runner.calls.started[0].extraEnv, { BOT_OWNER_INDEX: '1' });
    assert.equal(fleet.listBots().length, 1, 'still exactly one bot for owner 1 — same slot, fresh container');
  }, { jitsiJoinGraceMs: 80 });
});

test('player bot: a momentary jitsiJoined:false blip does not trigger a replace', async () => {
  await withFleet(async ({ fleet, runner }) => {
    await fleet.spawnCluster('1', 1);
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
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h1', roomIndex: '0', isBot: false } });
    await fleet.spawnCluster('0', 2);
    assert.equal(fleet.listBots().length, 2);
    assert.equal(fleet.aggregatorStatus().running, true);
    runner.calls.started.length = 0; // isolate what happens after the reset

    // The old meeting ends: human leaves, then — before our own
    // meetingEndGraceMs timer could fire — the sidecar's session-reset
    // arrives (the room went fleet-only), and only then does the human's
    // fast rejoin land under a fresh identity.
    await fleet.handleBusMessage({ type: 'peer-leave', peerId: 'h1' });
    await fleet.handleBusMessage({ type: 'session-reset' });
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h2', roomIndex: '0', isBot: false } });

    assert.equal(fleet.listBots().length, 0, 'old bots gone — a new meeting starts with none, must be spawned fresh');
    assert.equal(fleet.aggregatorStatus().running, true, 'a fresh aggregator DOES spawn for the rejoined human');
    assert.equal(
      runner.calls.started.filter((c) => c.botId === AGGREGATOR_BOT_ID).length, 1,
      'exactly one fresh aggregator start, not a leftover from before the reset',
    );
  });
});

test('roster reconcile heals a missed leave → meeting-end teardown still fires', async () => {
  await withFleet(async ({ fleet, runner, sent }) => {
    // Human joins; aggregator spawns.
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    assert.equal(fleet.aggregatorStatus().running, true);
    // The human left while our bus socket was down, so we never saw peer-leave.
    // On reconnect the sidecar replays the authoritative roster — now humanless.
    await fleet.handleBusMessage({ type: 'roster', peers: [] });
    await new Promise((resolve) => setTimeout(resolve, 60)); // meetingEndGraceMs = 30
    assert.equal(fleet.aggregatorStatus().running, false, 'reconcile armed the teardown');
    assert.ok(runner.calls.stopped.includes(AGGREGATOR_BOT_ID));
    assert.ok(sent.some((status) => status.action === 'teardown' && /meeting ended/.test(status.reason)));
  });
});

test('roster reconcile keeps a still-present human → no teardown', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'h', roomIndex: '0', isBot: false } });
    // Reconnect roster still lists the human (fresh peerId, same room index).
    await fleet.handleBusMessage({ type: 'roster', peers: [{ peerId: 'h2', roomIndex: '0', isBot: false }] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fleet.aggregatorStatus().running, true, 'human still present → aggregator stays');
  });
});

test('roster reconcile drops a departed owner’s cluster while the meeting continues', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'a', roomIndex: '0', isBot: false } });
    await fleet.handleBusMessage({ type: 'peer-join', peer: { peerId: 'b', roomIndex: '1', isBot: false } });
    await fleet.spawnCluster('0', 1); // owner 0 has a bot
    // Reconnect roster: owner 0 is gone, owner 1 is still here.
    await fleet.handleBusMessage({ type: 'roster', peers: [{ peerId: 'b', roomIndex: '1', isBot: false }] });
    await new Promise((resolve) => setTimeout(resolve, 60)); // ownerLeaveGraceMs = 30
    assert.equal(fleet.listBots().length, 0, 'departed owner’s cluster torn down');
    assert.equal(fleet.aggregatorStatus().running, true, 'meeting continues — owner 1 present');
  });
});

test('aggregator: role-tagged metrics are recorded but kept out of the health map', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 1);
    const [bot] = fleet.listBots();
    const base = `http://127.0.0.1:${fleet.port}`;

    await fetch(`${base}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: AGGREGATOR_BOT_ID, role: 'aggregator', fps: 30, ramBytes: 1e6, latencyMs: 5 }),
    });
    assert.equal(fleet.aggregatorStatus().metrics.role, 'aggregator');
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
