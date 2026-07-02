import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService, suffixFor } from '../src/orchestrator/fleet-service.js';
import { createAdminServer } from '../src/config-api/server.js';
import { mergeConfig } from '../src/shared/config.js';

function makeFakeRunner() {
  const calls = { started: [], stopped: [] };
  return {
    calls,
    async start(botId, extraEnv) { calls.started.push({ botId, extraEnv }); },
    async stop(botId) { calls.stopped.push(botId); },
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

test('cluster ordinals never reuse letters (respawn after removal continues the sequence)', async () => {
  await withFleet(async ({ fleet }) => {
    await fleet.spawnCluster('1', 2);           // 1a 1b
    await fleet.removeCluster('1', ['1a']);
    await fleet.spawnCluster('1', 1);           // next is 1c, never 1a again
    assert.deepEqual(fleet.listBots().map(b => b.clusterIndex).sort(), ['1b', '1c']);
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

test('suffixFor matches the shared index grammar', () => {
  assert.equal(suffixFor(0), 'a');
  assert.equal(suffixFor(25), 'z');
  assert.equal(suffixFor(26), 'za');
  assert.equal(suffixFor(27), 'zb');
  assert.equal(suffixFor(52), 'zza');
});
