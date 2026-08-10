import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FleetService } from '../src/orchestrator/fleet-service.js';
import { mergeConfig } from '../src/shared/config.js';

/**
 * `retroactive`. By default a bot plays what its author was playing when it
 * spawned; `retroactive: true` makes a later edit reach the bots already
 * running — but only at each one's NEXT TURN, never mid-phrase.
 *
 * The turn signal is the aggregator's `nc-active` broadcast, which is the only
 * statement on the bus about whose token is streaming. These tests drive that
 * message directly, exactly as the aggregator does.
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
  // The human must be in the roster shadow: peer-update carries only a peerId,
  // and the fleet resolves it to a room index through that roster.
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

const spawn = (fleet, code, count = 2) =>
  fleet.handleBusMessage(
    { type: 'fleet-request', action: 'spawn', count, fromIndex: HUMAN.index, code },
    ROOM,
  );

const edit = (fleet, code) =>
  fleet.handleBusMessage(
    { type: 'peer-update', peerId: HUMAN.peerId, patch: { pattern: code } },
    ROOM,
  );

const turn = (fleet, token) =>
  fleet.handleBusMessage({ type: 'nc-active', token, index: 0, kind: 'bot' }, ROOM);

// Bots must be in the roster shadow to be driven — the fleet targets a peerId.
async function joinBots(fleet) {
  for (const bot of fleet.listBots()) {
    await fleet.handleBusMessage(
      { type: 'peer-join', peer: { peerId: `peer-${bot.clusterIndex}`, roomIndex: bot.clusterIndex, isBot: true } },
      ROOM,
    );
  }
}

const drives = (sent) => sent.filter((m) => m.type === 'remote-control' && m.action === 'pattern');

test('without retroactive, an edit never reaches a running bot', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 's("cp:3")');
    await joinBots(fleet);
    const before = fleet.listBots().map((b) => b.script.strudel);

    await edit(fleet, 's("rim:7")');
    await turn(fleet, '1a');
    await turn(fleet, '1b');

    assert.deepEqual(fleet.listBots().map((b) => b.script.strudel), before);
    assert.equal(drives(sent).length, 0, 'nothing should be driven');
  });
});

test('retroactive:true re-latches each bot at its own next turn', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")');
    await joinBots(fleet);

    await edit(fleet, 'botConfig({ retroactive: true })\ns("rim:7")');

    // Nothing changes until a turn actually comes round.
    assert.equal(drives(sent).length, 0, 'no bot is rewritten mid-phrase');

    await turn(fleet, '1a');
    assert.equal(drives(sent).length, 1);
    assert.match(drives(sent)[0].code, /rim:7/);
    assert.equal(drives(sent)[0].targetPeerId, 'peer-1a');

    // The other bot is still waiting for its own turn.
    assert.match(fleet.listBots().find((b) => b.clusterIndex === '1b').script.strudel, /cp:3/);

    await turn(fleet, '1b');
    assert.equal(drives(sent).length, 2);
    assert.match(drives(sent)[1].code, /rim:7/);
  });
});

test('a turn re-latches once, not on every announcement', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")');
    await joinBots(fleet);
    await edit(fleet, 'botConfig({ retroactive: true })\ns("rim:7")');

    await turn(fleet, '1a');
    await turn(fleet, '1a');
    await turn(fleet, '1a');

    assert.equal(drives(sent).length, 1, 'the aggregator re-announces; that is not a new edit');
  });
});

test('turning retroactive on is itself an edit that takes effect', async () => {
  await withFleet(async ({ fleet, sent }) => {
    // Spawned WITHOUT retroactive.
    await spawn(fleet, 's("cp:3")');
    await joinBots(fleet);

    // The edit that introduces retroactive must be governed by the new config,
    // not the one the cluster was built with.
    await edit(fleet, 'botConfig({ retroactive: true })\ns("rim:7")');
    await turn(fleet, '1a');

    assert.equal(drives(sent).length, 1);
    assert.match(drives(sent)[0].code, /rim:7/);
  });
});

test('the re-latched code carries the hydra preamble as an editor block', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")');
    await joinBots(fleet);
    await edit(fleet, [
      'botConfig({ retroactive: true })',
      'await initHydra()',
      'noise(3).out(o0)',
      '',
      's("rim:7")',
    ].join('\n'));
    await turn(fleet, '1a');

    const code = drives(sent)[0].code;
    assert.match(code, /^await initHydra\(\)/, 'the preamble leads, as the page rule requires');
    assert.match(code, /\n\n/, 'and the blank line that ends it survives');
    assert.match(code, /rim:7/);
    assert.ok(!code.includes('botConfig'), 'the declaration is not part of what plays');
  });
});

test('a broken edit leaves the running cluster alone', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")');
    await joinBots(fleet);

    await edit(fleet, 'botConfig({ retroactive: true, harmony: "sideways" })\ns("rim:7")');
    await turn(fleet, '1a');

    assert.equal(drives(sent).length, 0, 'an unparseable config must not re-latch');
    assert.match(fleet.listBots()[0].script.strudel, /cp:3/);
  });
});

test('a broken edit is reported, not silently ignored', async () => {
  // Without this, a botConfig() typo (e.g. an unrecognized property name)
  // looks exactly like "my edit had no effect" or "reverted" — the studio's
  // only feedback is a fleet-status broadcast, and the retroactive edit path
  // used to skip it entirely (only the spawn path reported parse errors).
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")');
    await joinBots(fleet);

    await edit(fleet, 'botConfig({ parrotText: true })\ns("rim:7")');

    const errors = sent.filter((m) => m.type === 'fleet-status' && m.action === 'config-error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].ownerIndex, HUMAN.index);
    assert.match(errors[0].reason, /parrotText is not a known property/);
  });
});

test('a broken edit is reported even without retroactive set', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 's("cp:3")');
    await joinBots(fleet);

    await edit(fleet, 'botConfig({ cssParrot: "yes" })\ns("rim:7")');

    const errors = sent.filter((m) => m.type === 'fleet-status' && m.action === 'config-error');
    assert.equal(errors.length, 1, 'the same typo would silently produce a copy-cluster at the next spawn otherwise');
  });
});

test('one human\'s retroactive edit does not touch another\'s cluster', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await fleet.handleBusMessage(
      { type: 'peer-join', peer: { peerId: 'peer-other', roomIndex: '2', isBot: false } },
      ROOM,
    );
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")', 1);
    await fleet.handleBusMessage(
      { type: 'fleet-request', action: 'spawn', count: 1, fromIndex: '2', code: 's("hh*4")' },
      ROOM,
    );
    await joinBots(fleet);

    await edit(fleet, 'botConfig({ retroactive: true })\ns("rim:7")');
    await turn(fleet, '1a');
    await turn(fleet, '2a');

    assert.equal(drives(sent).length, 1, 'only the editing human\'s bot is driven');
    assert.equal(drives(sent)[0].targetPeerId, 'peer-1a');
  });
});

test('an edit from a bot is ignored', async () => {
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")');
    await joinBots(fleet);

    await fleet.handleBusMessage(
      { type: 'peer-update', peerId: 'peer-1a', patch: { pattern: 'botConfig({ retroactive: true })\ns("nope")' } },
      ROOM,
    );
    await turn(fleet, '1a');

    assert.equal(drives(sent).length, 0, 'a bot cannot re-source its own cluster');
  });
});

test('a direct edit to one bot cancels its stale queued relatch, without touching its sibling', async () => {
  // Reproduces "eval button still reverts the code": an operator pastes new
  // code straight into one bot's own tile (a peer-update for THAT bot's own
  // peerId — what the server broadcasts back after a studio remote-control
  // edit, or after #relatchToken's own send). If a retroactive edit from
  // earlier in the session already queued a relatch for that same bot
  // (pendingRelatch, not yet consumed because its ring turn hadn't come up),
  // the queued relatch must not survive to clobber the fresh, more-recent
  // state on the bot's next turn.
  await withFleet(async ({ fleet, sent }) => {
    await spawn(fleet, 'botConfig({ retroactive: true })\ns("cp:3")');
    await joinBots(fleet);

    await edit(fleet, 'botConfig({ retroactive: true })\ns("rim:7")'); // queues 1a AND 1b

    // The operator directly pastes into 1a's own tile and evals — the server
    // round-trips this back as a peer-update for peer-1a.
    await fleet.handleBusMessage(
      { type: 'peer-update', peerId: 'peer-1a', patch: { pattern: 's("hh*8")' } },
      ROOM,
    );

    await turn(fleet, '1a');
    assert.equal(drives(sent).length, 0,
      'the stale queued relatch for 1a must not fire and overwrite the manual edit');

    // 1b's queued relatch was untouched by an edit that only named 1a.
    await turn(fleet, '1b');
    assert.equal(drives(sent).length, 1);
    assert.equal(drives(sent)[0].targetPeerId, 'peer-1b');
    assert.match(drives(sent)[0].code, /rim:7/);
  });
});
