import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService } from '../src/orchestrator/fleet-service.js';
import { mergeConfig } from '../src/shared/config.js';

/**
 * A bot copying a preamble that reads an External Source (s0-s3) has nothing
 * to show without its own video tile live — unlike a regular bot, whose
 * point is its audio, this bot's whole point is the blitted video. It should
 * publish automatically on join rather than needing an operator to remember a
 * manual per-bot 'vid' click, since the owner's own equivalent (running Hydra
 * locally) never required one either.
 */

const ROOM = 'test-room';
const HUMAN = { index: '1', peerId: 'peer-human' };

async function withFleet(fn) {
  const runner = { started: [], async start(botId, env) { this.started.push({ botId, env }); }, async stop() {} };
  const sent = [];
  const connectSidecar = (url, handlers) => {
    const conn = { url, send: (m) => sent.push(m), close: () => {} };
    if (handlers.onOpen) handlers.onOpen(conn.send);
    return conn;
  };
  const fleet = new FleetService(
    mergeConfig({ maxBots: 6, conductorPort: 0, ownerLeaveGraceMs: 30, meetingEndGraceMs: 30 }),
    { runner, connectSidecar, controlToken: 'test-token' },
  );
  await fleet.start();
  fleet.attachRoom(ROOM);
  await fleet.handleBusMessage(
    { type: 'peer-join', peer: { peerId: HUMAN.peerId, roomIndex: HUMAN.index, isBot: false } },
    ROOM,
  );
  try {
    await fn({ fleet, sent, runner });
  } finally {
    await fleet.stop();
  }
}

const spawn = (fleet, code, count = 1) =>
  fleet.handleBusMessage(
    { type: 'fleet-request', action: 'spawn', count, fromIndex: HUMAN.index, code },
    ROOM,
  );

async function joinBots(fleet) {
  for (const bot of fleet.listBots()) {
    await fleet.handleBusMessage(
      { type: 'peer-join', peer: { peerId: `peer-${bot.clusterIndex}`, roomIndex: bot.clusterIndex, isBot: true } },
      ROOM,
    );
  }
}

const videoOnMessages = (sent) =>
  sent.filter((m) => m.type === 'remote-control' && m.action === 'video');

test('a bot copying External Source code auto-publishes video on join', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'await initHydra()\nsrc(s0).out()');
    await joinBots(fleet);

    const videoMsgs = videoOnMessages(sent);
    assert.equal(videoMsgs.length, 1);
    assert.deepEqual(videoMsgs[0], {
      type: 'remote-control', targetPeerId: 'peer-1a', action: 'video', videoOn: true,
    });
  });
});

test('a regular (non-External-Source) bot stays dark on join, as before', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 's("cp:3")');
    await joinBots(fleet);

    assert.equal(videoOnMessages(sent).length, 0);
  });
});

test('a Hydra bot that never reads an External Source stays dark too', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'await initHydra()\nnoise(3).out(o0)');
    await joinBots(fleet);

    assert.equal(videoOnMessages(sent).length, 0);
  });
});

test('the human joining never triggers an auto video-on', async () => {
  await withFleet(async ({ sent }) => {
    // withFleet itself already joined HUMAN — assert nothing was sent for them.
    assert.equal(videoOnMessages(sent).length, 0);
  });
});
