import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService } from '../src/orchestrator/fleet-service.js';
import { mergeConfig } from '../src/shared/config.js';
import { absoluteSampleUrls } from '../src/shared/sample-urls.js';

/**
 * `samples: true` end to end inside the fleet: bytes arrive over the bus,
 * land in the store, and come back out in the assignment a bot fetches.
 */

const ROOM = 'gig';

async function withFleet(fn) {
  const runner = { started: [], async start(botId, env) { this.started.push({ botId, env }); }, async stop() {} };
  const sent = [];
  const connectSidecar = (url, handlers) => {
    const conn = { url, send: (m) => sent.push(m), close: () => {} };
    if (handlers.onOpen) handlers.onOpen(conn.send);
    return conn;
  };
  const fleet = new FleetService(
    mergeConfig({ maxBots: 4, conductorPort: 0, ownerLeaveGraceMs: 30, meetingEndGraceMs: 30 }),
    { runner, connectSidecar, controlToken: 'test-token' },
  );
  await fleet.start();
  fleet.attachRoom(ROOM);
  try {
    await fn({ fleet, sent });
  } finally {
    await fleet.stop();
  }
}

const sendSample = (fleet, { fromIndex = '1', bank, name, data }) =>
  fleet.handleBusMessage({ type: 'sample-file', fromIndex, bank, name, data }, ROOM);

const b64 = (s) => Buffer.from(s).toString('base64');

test('samples sent before a spawn appear in the bot\'s assignment', async () => {
  await withFleet(async ({ fleet }) => {
    await sendSample(fleet, { bank: 'mykit', name: 'kick.wav', data: b64('RIFFkick') });
    await sendSample(fleet, { bank: 'mykit', name: 'snare.wav', data: b64('RIFFsnare') });
    await fleet.handleBusMessage(
      { type: 'fleet-request', action: 'spawn', count: 1, fromIndex: '1', code: 'botConfig({ samples: true })\ns("mykit")' },
      ROOM,
    );

    const bot = fleet.listBots()[0];
    const manifest = fleet.samples.manifestFor(bot.room, bot.ownerIndex);
    assert.deepEqual(Object.keys(manifest), ['mykit']);
    assert.equal(manifest.mykit.length, 2);
    assert.match(manifest.mykit[0], /\/samples\/gig\/1\/mykit\/kick\.wav$/);
  });
});

test('a rejected sample is reported to the performer, not dropped silently', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await sendSample(fleet, { bank: 'mykit', name: 'notes.txt', data: b64('hello') });
    const status = sent.find((m) => m.type === 'fleet-status' && m.action === 'samples');
    assert.ok(status, 'the studio must be told');
    assert.match(status.reason, /not an audio file/);
    assert.equal(status.ownerIndex, '1');
  });
});

test('one performer\'s library is not visible to another\'s bots', async () => {
  await withFleet(async ({ fleet }) => {
    await sendSample(fleet, { fromIndex: '1', bank: 'mine', name: 'a.wav', data: b64('A') });
    await fleet.handleBusMessage(
      { type: 'fleet-request', action: 'spawn', count: 1, fromIndex: '2', code: 's("bd")' },
      ROOM,
    );
    const other = fleet.listBots().find((b) => b.ownerIndex === '2');
    assert.deepEqual(fleet.samples.manifestFor(other.room, other.ownerIndex), {});
  });
});

test('the assignment endpoint serves the manifest and the bytes', async () => {
  await withFleet(async ({ fleet }) => {
    await sendSample(fleet, { bank: 'mykit', name: 'kick.wav', data: b64('RIFFkick') });
    await fleet.handleBusMessage(
      { type: 'fleet-request', action: 'spawn', count: 1, fromIndex: '1', code: 'botConfig({ samples: true })\ns("mykit")' },
      ROOM,
    );
    const bot = fleet.listBots()[0];
    const base = `http://127.0.0.1:${fleet.port}`;

    const assignment = await fetch(`${base}/assignment/${bot.botId}`).then((r) => r.json());
    assert.ok(assignment.samples.mykit, 'the assignment carries the manifest');

    const urls = absoluteSampleUrls(assignment.samples, base);
    const res = await fetch(urls.mykit[0]);
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'RIFFkick');
  });
});

test('an unknown sample path 404s rather than escaping the store', async () => {
  await withFleet(async ({ fleet }) => {
    const base = `http://127.0.0.1:${fleet.port}`;
    assert.equal((await fetch(`${base}/samples/gig/1/nope/none.wav`)).status, 404);
    assert.equal((await fetch(`${base}/samples/gig/1/..%2f..%2fetc/passwd`)).status, 404);
  });
});

test('absoluteSampleUrls resolves paths and leaves absolute URLs alone', () => {
  assert.deepEqual(
    absoluteSampleUrls({ k: ['/samples/a/1/k/x.wav'] }, 'http://localhost:7700'),
    { k: ['http://localhost:7700/samples/a/1/k/x.wav'] },
  );
  assert.deepEqual(
    absoluteSampleUrls({ k: ['http://elsewhere/x.wav'] }, 'http://localhost:7700'),
    { k: ['http://elsewhere/x.wav'] },
  );
  assert.deepEqual(absoluteSampleUrls(null, 'http://x'), {});
});
