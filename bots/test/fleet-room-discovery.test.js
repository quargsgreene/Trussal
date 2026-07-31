// End-to-end room discovery: the REAL sidecar relay + the REAL FleetService
// over real WebSockets, with only the container runner faked.
//
// This is the regression that matters for "the aggregator only appears when the
// meeting is called 0": the fleet used to open a single bus connection for its
// configured room, so a human anywhere else was never seen and no aggregator
// was ever started for them. Here the fleet is given the DEFAULT config (whose
// no room setting at all) and humans join rooms with arbitrary names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import { FleetService, makeWsSidecarConnector, AGGREGATOR_BOT_ID } from '../src/orchestrator/fleet-service.js';
import { mergeConfig } from '../src/shared/config.js';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../../latency-instrument/server.js');

function makeFakeRunner() {
  const started = [];
  const stopped = [];
  return {
    started, stopped,
    async start(botId, extraEnv) { started.push({ botId, extraEnv }); },
    async stop(botId) { stopped.push(botId); },
  };
}

// A human browser joining a room, as peer-state.js does.
function joinRoom(port, room, jitsiId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${encodeURIComponent(room)}&role=player`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', jitsiId, displayName: jitsiId }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

// Poll rather than sleep a fixed span: the path under test crosses two real
// sockets (human → relay → control channel → room bus → fleet), so any single
// fixed wait is either flaky or needlessly slow.
async function until(pred, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = pred();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const CONTROL_TOKEN = 'e2e-control-token';

async function withStack(fn, overrides = {}) {
  const { wss } = createLatencyServer({ port: 0, controlToken: CONTROL_TOKEN });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const runner = makeFakeRunner();
  const fleet = new FleetService(
    mergeConfig({
      conductorPort: 0,
      sidecarWsUrl: `ws://127.0.0.1:${port}/ws`,
      jitsiUrl: 'http://localhost/0',
      ...overrides,
    }),
    { runner, connectSidecar: makeWsSidecarConnector(WebSocket), controlToken: CONTROL_TOKEN },
  );
  await fleet.start();
  const sockets = [];
  try {
    await fn({ port, fleet, runner, join: async (room, id) => { sockets.push(await joinRoom(port, room, id)); } });
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    await fleet.stop();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

test('a human in a room that is not "0" gets an aggregator, pointed at their room', async () => {
  await withStack(async ({ fleet, runner, join }) => {
    await join('friday-jam', 'human-1');

    const agg = await until(() => runner.started.find((c) => c.extraEnv.BOT_ROLE === 'aggregator'));
    assert.equal(agg.extraEnv.JITSI_URL, 'http://localhost/friday-jam',
      'the container joins the human’s room, not some configured default');
    assert.equal(agg.botId, AGGREGATOR_BOT_ID);
    assert.equal(fleet.aggregatorStatus('friday-jam').running, true);
    // The configured fallback room has no meeting and must not have spawned one.
    assert.equal(fleet.aggregatorStatus('0').running, false);
  });
});

test('two rooms live at once each get their own aggregator', async () => {
  await withStack(async ({ fleet, runner, join }) => {
    await join('room-alpha', 'human-a');
    await join('room-beta', 'human-b');

    const aggs = await until(() => {
      const found = runner.started.filter((c) => c.extraEnv.BOT_ROLE === 'aggregator');
      return found.length === 2 ? found : null;
    });
    assert.deepEqual(aggs.map((a) => a.extraEnv.JITSI_URL).sort(),
      ['http://localhost/room-alpha', 'http://localhost/room-beta']);
    assert.equal(new Set(aggs.map((a) => a.botId)).size, 2,
      'distinct container ids — trussal-bot-<id> names must not collide');
    assert.equal(fleet.aggregatorStatus('room-alpha').running, true);
    assert.equal(fleet.aggregatorStatus('room-beta').running, true);
  });
});

test('a room opened after the fleet is already running is picked up too', async () => {
  await withStack(async ({ fleet, runner, join }) => {
    await join('first', 'human-1');
    await until(() => runner.started.some((c) => c.extraEnv.JITSI_URL === 'http://localhost/first'));

    // Nothing re-reads configuration here: the relay announces the new room on
    // the control channel the moment someone joins it.
    await join('opened-later', 'human-2');
    await until(() => runner.started.some((c) => c.extraEnv.JITSI_URL === 'http://localhost/opened-later'));
    assert.equal(fleet.aggregatorStatus('opened-later').running, true);
  });
});

test('a spawn request from a non-"0" room starts that room’s bots', async () => {
  await withStack(async ({ fleet, runner, join, port }) => {
    const ws = await joinRoom(port, 'gig-night', 'human-1');
    try {
      await until(() => runner.started.some((c) => c.extraEnv.BOT_ROLE === 'aggregator'));
      ws.send(JSON.stringify({ type: 'fleet-request', action: 'spawn', count: 2 }));

      const players = await until(() => {
        const found = runner.started.filter((c) => c.extraEnv.BOT_OWNER_INDEX != null);
        return found.length === 2 ? found : null;
      });
      for (const p of players) assert.equal(p.extraEnv.JITSI_URL, 'http://localhost/gig-night');
      assert.deepEqual(fleet.listBots().map((b) => b.room), ['gig-night', 'gig-night']);
    } finally {
      ws.close();
    }
  });
});

test('the meeting ending in one room does not disturb another that is still going', async () => {
  await withStack(async ({ fleet, runner, port }) => {
    const staying = await joinRoom(port, 'staying', 'human-s');
    const leaving = await joinRoom(port, 'leaving', 'human-l');
    await until(() => runner.started.filter((c) => c.extraEnv.BOT_ROLE === 'aggregator').length === 2);

    leaving.close();
    await until(() => fleet.aggregatorStatus('leaving').running === false);
    assert.equal(fleet.aggregatorStatus('staying').running, true,
      'the other meeting keeps its aggregator');

    staying.close();
  }, { meetingEndGraceMs: 30 });
});
