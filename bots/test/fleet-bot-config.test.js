import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService } from '../src/orchestrator/fleet-service.js';
import { mergeConfig } from '../src/shared/config.js';

/**
 * End of the botConfig path inside the fleet: a spawn request carries the
 * requester's editor text, and the containers that come up play THAT, shaped by
 * the botConfig(...) it declared — not the fleet-wide random master every
 * cluster used to share.
 *
 * The unit-level matrix lives in cluster-source.test.js; these pin the wiring
 * that gets a performer's code from a bus message into a bot's script.
 */

const ROOM = 'test-room';

function makeFakeRunner() {
  const started = [];
  return {
    started,
    async start(botId, extraEnv) { started.push({ botId, extraEnv }); },
    async stop() {},
  };
}

async function withFleet(fn, overrides = {}) {
  const runner = makeFakeRunner();
  const sent = [];
  const connectSidecar = (url, handlers) => {
    const conn = { url, send: (m) => sent.push(m), close: () => {} };
    if (handlers.onOpen) handlers.onOpen(conn.send);
    return conn;
  };
  const fleet = new FleetService(
    mergeConfig({
      maxBots: 6, conductorPort: 0, ownerLeaveGraceMs: 30, meetingEndGraceMs: 30,
      ...overrides,
    }),
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

const spawn = (fleet, { count, fromIndex, code }) =>
  fleet.handleBusMessage({ type: 'fleet-request', action: 'spawn', count, fromIndex, code }, ROOM);

test('a cluster plays its own human\'s code, not the fleet master', async () => {
  await withFleet(async ({ fleet }) => {
    await spawn(fleet, { count: 2, fromIndex: '1', code: 's("cp:3 rim:7")' });
    for (const bot of fleet.listBots()) {
      assert.match(bot.script.strudel, /cp:3 rim:7/);
    }
  });
});

test('two humans in one room get two different clusters', async () => {
  await withFleet(async ({ fleet }) => {
    await spawn(fleet, { count: 1, fromIndex: '1', code: 's("cp:3")' });
    await spawn(fleet, { count: 1, fromIndex: '2', code: 's("rim:7")' });

    const byOwner = Object.fromEntries(fleet.listBots().map((b) => [b.ownerIndex, b.script.strudel]));
    assert.match(byOwner['1'], /cp:3/);
    assert.match(byOwner['2'], /rim:7/);
    assert.ok(!byOwner['1'].includes('rim:7'), 'one human\'s patch must not leak into another\'s cluster');
  });
});

test('the botConfig declaration shapes the cluster and never reaches the bots', async () => {
  await withFleet(async ({ fleet }) => {
    await spawn(fleet, {
      count: 3, fromIndex: '1',
      code: 'botConfig({ harmony: "+4" })\nnote("c3")',
    });

    const scripts = fleet.listBots().map((b) => b.script.strudel);
    for (const s of scripts) assert.ok(!s.includes('botConfig'), 'the declaration is not played');

    // Cluster member 0 stays at pitch; the rest spread into a voicing.
    assert.ok(!scripts[0].includes('.add(note('), 'the first bot holds the root');
    assert.match(scripts[1], /\.add\(note\(4\)\)/);
    assert.match(scripts[2], /\.add\(note\(8\)\)/);
  });
});

test('a spawn with no code still produces a working cluster', async () => {
  await withFleet(async ({ fleet }) => {
    await spawn(fleet, { count: 2, fromIndex: '1' });
    for (const bot of fleet.listBots()) {
      assert.ok(bot.script.strudel.length > 0, 'falls back to the fleet master');
    }
  });
});

test('a broken botConfig surfaces a reason and still spawns copies', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, {
      count: 2, fromIndex: '1',
      code: 'botConfig({ colorScheme: "greenish" })\ns("cp:3")',
    });

    const reason = sent.find((m) => m.type === 'fleet-status' && m.reason && /colorScheme/.test(m.reason));
    assert.ok(reason, 'the performer must be told their config was rejected');
    assert.equal(fleet.listBots().length, 2, 'a typo costs the config, not the cluster');
    for (const bot of fleet.listBots()) assert.match(bot.script.strudel, /cp:3/);
  });
});

test('the snapshot is per room, so the same index in two rooms stays separate', async () => {
  await withFleet(async ({ fleet }) => {
    const OTHER = 'other-room';
    fleet.attachRoom(OTHER);

    await spawn(fleet, { count: 1, fromIndex: '1', code: 's("cp:3")' });
    await fleet.handleBusMessage(
      { type: 'fleet-request', action: 'spawn', count: 1, fromIndex: '1', code: 's("rim:7")' },
      OTHER,
    );

    const here = fleet.listBots().find((b) => b.room === ROOM);
    const there = fleet.listBots().find((b) => b.room === OTHER);
    assert.match(here.script.strudel, /cp:3/);
    assert.match(there.script.strudel, /rim:7/);
  });
});

test('a bot keeps its snapshot when its author keeps typing', async () => {
  await withFleet(async ({ fleet }) => {
    await spawn(fleet, { count: 1, fromIndex: '1', code: 's("cp:3")' });
    const before = fleet.listBots()[0].script.strudel;

    // A second spawn from the same human re-captures for the NEW bot; the
    // existing one is not rewritten mid-phrase.
    await spawn(fleet, { count: 1, fromIndex: '1', code: 's("rim:7")' });

    const bots = fleet.listBots().sort((a, b) => a.clusterIndex.localeCompare(b.clusterIndex));
    assert.equal(bots[0].script.strudel, before, 'the first bot keeps what it spawned with');
    assert.match(bots[1].script.strudel, /rim:7/, 'the new bot gets the current code');
  });
});
