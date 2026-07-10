import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RingBuffer } from '../src/bot/ring-buffer.js';
import { AggregatorBot } from '../src/bot/aggregator-bot.js';

// --- RingBuffer ---------------------------------------------------------------

test('RingBuffer writes, reads FIFO, and reports length/bytes', () => {
  const rb = new RingBuffer(8);
  assert.equal(rb.write([1, 2, 3]), 3);
  assert.equal(rb.length, 3);
  assert.equal(rb.bytes, 3 * 4);
  const out = rb.read(2);
  assert.deepEqual([...out], [1, 2]);
  assert.equal(rb.length, 1);
});

test('RingBuffer evicts the oldest samples when full and keeps the newest', () => {
  const rb = new RingBuffer(4);
  rb.write([1, 2, 3, 4, 5, 6]); // 6 into a 4-slot ring -> evict 1,2
  assert.equal(rb.length, 4, 'never exceeds capacity');
  assert.equal(rb.evicted, 2);
  assert.deepEqual([...rb.peek()], [3, 4, 5, 6], 'holds the newest capacity samples');
  assert.equal(rb.written, 6, 'tracks total ever written');
});

// --- Fakes mirroring bot.test.js ---------------------------------------------

function makeFakes({ pageCaptures = [] } = {}) {
  const calls = { evalOnNewDoc: [], goto: [], evaluate: [], enqueued: [], metrics: 0, closed: false };
  const fakePage = {
    setUserAgent: async () => {},
    evaluateOnNewDocument: async (js) => calls.evalOnNewDoc.push(String(js)),
    goto: async (url) => calls.goto.push(url),
    waitForFunction: async () => {},
    evaluate: async (fn, ...args) => {
      const s = String(fn);
      calls.evaluate.push(s);
      if (/__trussalAggCapture|\.drain\(\)/.test(s)) return pageCaptures;    // pageDrainParticipantAudio
      if (/__trussalMasterPlayer|\.enqueue\(/.test(s)) {                     // pageEnqueueMaster
        calls.enqueued.push(args[0]);
        return (args[0] || []).length;
      }
      if (/muteAudio|muteVideo/.test(s)) return undefined;                   // pageEnsure*Published
      return { fps: 30, errors: [], diag: {} };                             // pageReadSamples
    },
    metrics: async () => { calls.metrics++; return { JSHeapUsedSize: 50e6 }; },
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => { calls.closed = true; } };
  const fakeLauncher = { launch: async (opts) => { calls.launchOpts = opts; return fakeBrowser; } };
  return { calls, fakeLauncher };
}

// ingestIntervalMs/playbackIntervalMs: 0 keeps the self-driving loops off by
// default so tests drive writeTo…/ingestTick and readAndAssemble…/play…
// deterministically; each loop has its own test.
const cfg = { botId: 1, name: 'Aggregator', jitsiUrl: 'http://localhost/0', ingestIntervalMs: 0, playbackIntervalMs: 0 };

// --- start() ------------------------------------------------------------------

test('start(): joins injected browser unmuted, taps participants, no Strudel, publishes metrics', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const published = [];
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, reporter: (tag, data) => published.push({ tag, data }) });

  await bot.start();

  assert.ok(calls.launchOpts.args.includes('--use-fake-device-for-media-stream'), 'launched with bot chromium args');
  assert.equal(calls.goto.length, 1);
  assert.match(calls.goto[0], /displayName="Aggregator"/);
  // Audio-first: joins with video muted so the headless join never blocks on a
  // Hydra canvas the aggregator never creates.
  assert.match(calls.goto[0], /config\.startWithVideoMuted=true/);

  // Ingest tap + return-path playback sink installed before navigation.
  assert.ok(calls.evalOnNewDoc.some((s) => /__trussalAggCapture/.test(s)), 'participant-audio tap installed');
  assert.ok(calls.evalOnNewDoc.some((s) => /__trussalMasterPlayer/.test(s)), 'return-path playback sink installed');
  // Unmutes audio (its published track will carry the master mix)...
  assert.ok(calls.evaluate.some((s) => /muteAudio\(false\)/.test(s)), 'publishes an unmuted audio track');
  // ...but does NOT publish video (no canvas to capture yet).
  assert.ok(!calls.evaluate.some((s) => /muteVideo\(false\)/.test(s)), 'does not publish a video track');
  // Makes no sound of its own — never boots the Strudel REPL. (pageReadSamples
  // *queries* for a strudel-editor to diagnose; only pageStrudelBoot *creates* one.)
  assert.ok(!calls.evaluate.some((s) => /createElement\(['"]strudel-editor/.test(s)), 'does not boot Strudel');

  // Published exactly one metrics sample, carrying both buffer dimensions.
  assert.equal(published.length, 1);
  assert.equal(typeof published[0].data.ramBytes, 'number');
  assert.ok(published[0].data.buffers.shared, 'metrics include the shared buffer');
  assert.deepEqual(published[0].data.buffers.participants, {}, 'no participant buffers yet');

  await bot.stop();
  assert.equal(calls.closed, true, 'stop() closes the browser');
});

// --- writeToIndividualParticipantBufferQueues() ------------------------------

test('writeToIndividualParticipantBufferQueues: buffers keyed by room index, evicts when full', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);

  // human 0, their first bot 0a, and human 1 — the Net Cycles token space.
  const summary = await bot.writeToIndividualParticipantBufferQueues([
    { token: '0', samples: new Array(500).fill(0.5) },
    { token: '0a', samples: new Array(300).fill(0.25) },
    { token: '1', samples: new Array(2000).fill(0.1) }, // overflows the 1024 ring
  ]);

  assert.equal(summary['0'].wrote, 500);
  assert.equal(bot.buffers['0'].length, 500);
  assert.equal(summary['0'].evicted, 0);

  assert.equal(bot.buffers['0a'].length, 300, 'a human\'s bot gets its own buffer');

  assert.equal(bot.buffers['1'].length, 1024, 'individual buffer capped at bufferSize');
  assert.equal(summary['1'].evicted, 2000 - 1024);
});

test('writeToIndividualParticipantBufferQueues: pulls from the page tap (room-index tokens) when no captures passed', async () => {
  const { fakeLauncher } = makeFakes({
    pageCaptures: [{ token: '0a', samples: [0.1, 0.2, 0.3] }],
  });
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false });
  await bot.start();

  await bot.writeToIndividualParticipantBufferQueues(); // no arg -> drain page
  assert.equal(bot.buffers['0a'].length, 3);
});

// --- logBuffersAndStats() -----------------------------------------------------

test('logBuffersAndStats: prints the shared buffer and every participant buffer', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { token: '0', samples: [0.1, 0.2] },
    { token: '1', samples: [0.3] },
  ]);

  const rows = bot.logBuffersAndStats();
  const props = ['timestamp', 'bufferSize', 'bufferLength', 'bufferBytes', 'bufferEvicted', 'bufferMaxBuffers', 'bufferMaxBytes'];
  for (const r of rows) for (const p of props) assert.ok(p in r, `row missing ${p}`);

  const tokens = rows.map((r) => r.token);
  assert.ok(tokens.includes('__shared__'), 'includes the shared dimension');
  assert.ok(tokens.includes('0') && tokens.includes('1'), 'includes each participant dimension');
  assert.equal(rows.find((r) => r.token === '0').bufferLength, 2);
});

// --- ingest logging (logIngest, default on) ----------------------------------

test('ingest logging: prints incoming audio + buffers when data arrives, stays silent otherwise', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher }, {}, 1024); // logIngest defaults true

  const logs = [];
  const origLog = console.log;
  const origTable = console.table;
  console.log = (...a) => logs.push(String(a[0]));
  console.table = () => logs.push('[table]');
  try {
    // Nothing reached the bot -> no output.
    await bot.writeToIndividualParticipantBufferQueues([{ token: '0', samples: [] }]);
    assert.equal(logs.length, 0, 'silent when no audio has reached the bot');

    // Audio arrives -> prints the incoming per-token line and the buffer table.
    await bot.writeToIndividualParticipantBufferQueues([{ token: '0a', samples: [0.5, -0.25, 0.1] }]);
  } finally {
    console.log = origLog;
    console.table = origTable;
  }

  assert.ok(logs.some((l) => /incoming audio token=0a samples=3/.test(l)), 'logs incoming audio for the participant');
  assert.ok(logs.includes('[table]'), 'logs the ring-buffer table');
});

// --- ingest loop -------------------------------------------------------------

test('ingest loop: start() schedules a drain timer, ingestTick drains the page, stop() clears it', async () => {
  const { fakeLauncher } = makeFakes({ pageCaptures: [{ token: '0a', samples: [0.2, 0.4] }] });
  const bot = new AggregatorBot({ ...cfg, ingestIntervalMs: 50 }, { launcher: fakeLauncher, logIngest: false });

  await bot.start();
  assert.ok(bot._ingestTimer, 'ingest loop scheduled after start()');

  await bot.ingestTick(); // drive one tick deterministically (no arg -> drains page)
  assert.equal(bot.buffers['0a'].length, 2, 'tick drained the page tap into the participant buffer');

  await bot.stop();
  assert.equal(bot._ingestTimer, null, 'stop() cleared the ingest timer');
});

// --- readAndAssembleMasterBuffer() + playMasterBufferToClient() ---------------
// The round trip, no metaprogram yet: each participant's audio is arbitrarily
// queued into its own buffer and alternated 4s at a time back out to the client.

test('round trip: alternates each participant every 4s and streams the active one back out', async () => {
  const { calls, fakeLauncher } = makeFakes();
  let clock = 0; // injected so the 4s rotation is deterministic without real time
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 4000 },                                  // 4s slots; loops stay off
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {}, 1024,
  );
  await bot.start(); // installs the page playback sink; timers off (intervals 0)

  // Each participant has its own continuously-buffered audio. A constant level
  // per participant (all exactly representable in float32) makes the assembled
  // slice identifiable when it comes back out.
  bot.buffers['0']  = new RingBuffer(1024); bot.buffers['0'].write(new Array(200).fill(0.5));
  bot.buffers['0a'] = new RingBuffer(1024); bot.buffers['0a'].write(new Array(200).fill(-0.125));
  bot.buffers['1']  = new RingBuffer(1024); bot.buffers['1'].write(new Array(200).fill(0.25));
  // Room-index order is 0, 0a, 1 (numeric index first, then per-owner bot suffix).

  // Slot 0 (t=0): participant 0 is active — only its audio hits the master.
  clock = 0;
  let a = await bot.readAndAssembleMasterBuffer();
  assert.equal(a.active, '0');
  assert.equal(a.assembled, 200);
  assert.equal(bot.buffers['0'].length, 0, 'the active participant is drained as it streams');
  assert.equal(bot.buffers['0a'].length, 200, 'inactive participants keep their audio queued');

  let p = await bot.playMasterBufferToClient();
  assert.equal(p.played, 200);
  assert.deepEqual(calls.enqueued.at(-1), new Array(200).fill(0.5), 'participant 0 streamed back out');

  // Slot 1 (t=4s): participant 0a is active.
  clock = 4000;
  a = await bot.readAndAssembleMasterBuffer();
  assert.equal(a.active, '0a');
  await bot.playMasterBufferToClient();
  assert.deepEqual(calls.enqueued.at(-1), new Array(200).fill(-0.125), 'participant 0a streamed back out next');

  // Slot 2 (t=8s): participant 1 is active.
  clock = 8000;
  a = await bot.readAndAssembleMasterBuffer();
  assert.equal(a.active, '1');
  await bot.playMasterBufferToClient();
  assert.deepEqual(calls.enqueued.at(-1), new Array(200).fill(0.25), 'participant 1 streamed back out next');

  // Slot 3 (t=12s): the rotation wraps back to participant 0 (now empty -> silence).
  clock = 12000;
  a = await bot.readAndAssembleMasterBuffer();
  assert.equal(a.active, '0', 'rotation wraps back round');
  assert.equal(a.assembled, 0, 'a drained participant contributes silence until it fills again');
  assert.equal((await bot.playMasterBufferToClient()).played, 0);

  await bot.stop();
});

test('round trip: empty room assembles silence and enqueues nothing (keeps checking)', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.start();

  const a = await bot.readAndAssembleMasterBuffer();
  assert.deepEqual(a, { active: null, assembled: 0 }, 'no participants -> nothing assembled');
  const p = await bot.playMasterBufferToClient();
  assert.equal(p.played, 0);
  assert.equal(calls.enqueued.length, 0, 'nothing enqueued to the page player');

  await bot.stop();
});
