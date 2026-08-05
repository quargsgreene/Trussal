import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService } from '../src/orchestrator/fleet-service.js';
import { mergeConfig } from '../src/shared/config.js';

/**
 * `botConfig({ mcp: "<prompt>" })` inside the fleet: the prompt is composed
 * BEFORE any container starts, the composed code becomes the cluster's master
 * (so every other property still shapes it), and a failure degrades to the
 * performer's own code rather than blocking the spawn.
 */

const ROOM = 'gig';

async function withFleet(compose, fn) {
  const runner = { started: [], async start(botId, env) { this.started.push({ botId, env }); }, async stop() {} };
  const sent = [];
  const connectSidecar = (url, handlers) => {
    const conn = { url, send: (m) => sent.push(m), close: () => {} };
    if (handlers.onOpen) handlers.onOpen(conn.send);
    return conn;
  };
  const fleet = new FleetService(
    mergeConfig({ maxBots: 4, conductorPort: 0, ownerLeaveGraceMs: 30, meetingEndGraceMs: 30 }),
    { runner, connectSidecar, controlToken: 'test-token', compose },
  );
  await fleet.start();
  fleet.attachRoom(ROOM);
  try {
    await fn({ fleet, sent, runner });
  } finally {
    await fleet.stop();
  }
}

const spawn = (fleet, code, count = 2) =>
  fleet.handleBusMessage(
    { type: 'fleet-request', action: 'spawn', count, fromIndex: '1', code },
    ROOM,
  );

test('an mcp prompt composes the cluster\'s code', async () => {
  const seen = [];
  const compose = async (req) => {
    seen.push(req);
    return { ok: true, source: 'claude', script: { strudel: 's("cp:9")', hydra: '' } };
  };

  await withFleet(compose, async ({ fleet }) => {
    await spawn(fleet, 'botConfig({ mcp: "spooky drones" })\ns("bd sd")');

    assert.equal(seen.length, 1, 'composed once for the cluster, not once per bot');
    assert.equal(seen[0].prompt, 'spooky drones');
    assert.match(seen[0].master.strudel, /bd sd/, 'the performer\'s code goes in as context');

    for (const bot of fleet.listBots()) assert.match(bot.script.strudel, /cp:9/);
  });
});

test('composition finishes before any container starts', async () => {
  const order = [];
  const compose = async () => {
    order.push('compose');
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, source: 'claude', script: { strudel: 's("cp:9")', hydra: '' } };
  };

  await withFleet(compose, async ({ fleet, runner }) => {
    const originalStart = runner.start.bind(runner);
    runner.start = async (...args) => { order.push('start'); return originalStart(...args); };

    await spawn(fleet, 'botConfig({ mcp: "x" })\ns("bd")', 1);
    assert.deepEqual(order, ['compose', 'start']);
  });
});

test('other properties still shape the composed code', async () => {
  const compose = async () => ({ ok: true, source: 'claude', script: { strudel: 'note("c3").cutoff(400)', hydra: '' } });

  await withFleet(compose, async ({ fleet }) => {
    await spawn(fleet, 'botConfig({ mcp: "x", harmony: "+5", paramFactor: 2 })\ns("bd")', 2);
    const bots = fleet.listBots().sort((a, b) => a.clusterIndex.localeCompare(b.clusterIndex));

    assert.match(bots[0].script.strudel, /cutoff\(800\)/, 'paramFactor applies to composed code');
    assert.match(bots[1].script.strudel, /\.add\(note\(5\)\)/, 'harmony spreads the cluster');
  });
});

test('a failed composition degrades to the performer\'s code and says so', async () => {
  const compose = async () => ({ ok: false, source: 'palette', script: null, error: 'both models refused' });

  await withFleet(compose, async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ mcp: "x" })\ns("cp:3")', 1);

    const status = sent.find((m) => m.type === 'fleet-status' && /palette/.test(m.reason ?? ''));
    assert.ok(status, 'the performer must learn their prompt did not land');
    assert.match(status.reason, /both models refused/);
    assert.match(fleet.listBots()[0].script.strudel, /cp:3/, 'the cluster still plays something');
  });
});

test('a throwing composer does not block the spawn', async () => {
  const compose = async () => { throw new Error('connection reset'); };

  await withFleet(compose, async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ mcp: "x" })\ns("cp:3")', 1);
    assert.equal(fleet.listBots().length, 1);
    assert.ok(sent.some((m) => /connection reset/.test(m.reason ?? '')));
  });
});

test('no mcp prompt means the composer is never called', async () => {
  let called = 0;
  const compose = async () => { called++; return { ok: true, script: { strudel: 's("x")', hydra: '' } }; };

  await withFleet(compose, async ({ fleet }) => {
    await spawn(fleet, 's("bd sd")', 1);
    assert.equal(called, 0);
  });
});

test('a fleet with no composer treats mcp as a no-op, not an error', async () => {
  await withFleet(null, async ({ fleet }) => {
    await spawn(fleet, 'botConfig({ mcp: "x" })\ns("cp:3")', 1);
    assert.equal(fleet.listBots().length, 1);
    assert.match(fleet.listBots()[0].script.strudel, /cp:3/);
  });
});
