import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RingBuffer } from '../src/bot/ring-buffer.js';
import { AggregatorBot, AGGREGATOR_SLOT_TAKEN } from '../src/bot/aggregator-bot.js';

// A fake sidecar connector (shape: (url, {onOpen, onMessage}) => {send, close})
// that answers the aggregator-claim with a fixed verdict. Records the URL it was
// asked to reach and whether the connection was closed.
function fakeClaimConnector(granted) {
  const rec = { url: null, closed: false };
  const connect = (url, { onOpen, onMessage }) => {
    rec.url = url;
    setTimeout(() => {
      onOpen(() => {}); // bot sends aggregator-claim; we ignore the payload
      onMessage({ type: 'aggregator-claim-result', granted });
    }, 0);
    return { send: () => {}, close: () => { rec.closed = true; } };
  };
  return { connect, rec };
}

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
  assert.ok(calls.evalOnNewDoc.some((sink) => /__trussalAggCapture/.test(sink)), 'participant-audio tap installed');
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
  assert.ok(bot.ingestTimer, 'ingest loop scheduled after start()');

  await bot.ingestTick(); // drive one tick deterministically (no arg -> drains page)
  assert.equal(bot.buffers['0a'].length, 2, 'tick drained the page tap into the participant buffer');

  await bot.stop();
  assert.equal(bot.ingestTimer, null, 'stop() cleared the ingest timer');
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

// --- pre-join claim gate ------------------------------------------------------
// The bot claims the room's single aggregator slot from the sidecar BEFORE
// launching its browser. A losing bot must never join the meeting at all.

test('claim gate: winning the claim lets the bot join (browser launched, slot URL from the room)', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const { connect, rec } = fakeClaimConnector(true);
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false, connectSidecar: connect });

  await bot.start();

  assert.ok(calls.launchOpts, 'browser launched after the claim was granted');
  assert.equal(calls.goto.length, 1, 'joined the Jitsi room');
  assert.match(rec.url, /^ws:\/\/localhost\/ws\?room=0&role=aggregator-probe$/, 'claimed the slot for the room derived from jitsiUrl');

  await bot.stop();
  assert.equal(rec.closed, true, 'stop() releases the claim (closes the probe)');
});

test('claim gate: losing the claim throws AGGREGATOR_SLOT_TAKEN and never launches the browser', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const { connect, rec } = fakeClaimConnector(false);
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false, connectSidecar: connect });

  await assert.rejects(() => bot.start(), (err) => err.code === AGGREGATOR_SLOT_TAKEN);

  assert.equal(calls.launchOpts, undefined, 'never launched a browser');
  assert.equal(calls.goto.length, 0, 'never joined the Jitsi room');
  assert.equal(rec.closed, true, 'released the probe on denial');
});

test('claim gate: with no connector wired the claim is skipped (unit/standalone path)', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }); // no connectSidecar
  await bot.start();
  assert.ok(calls.launchOpts, 'joins without a claim when no sidecar connector is injected');
  await bot.stop();
});

// --- single-aggregator election gate -----------------------------------------
// Only the room's ACTIVE aggregator ingests and streams. A second aggregator
// stands down so the two masters never tap and feed back into each other (which
// silences both). isActive is injected here; in production it polls the page's
// window.__trussalIsActiveAggregator (the bundle's election).

test('election gate: a stood-down aggregator neither drains nor streams', async () => {
  const { calls, fakeLauncher } = makeFakes({ pageCaptures: [{ token: '0a', samples: [0.2, 0.4] }] });
  const bot = new AggregatorBot(
    { ...cfg, ingestIntervalMs: 50, playbackIntervalMs: 50 },
    { launcher: fakeLauncher, logIngest: false, isActive: async () => false },
    {}, 1024,
  );
  await bot.start();

  // Pre-load a buffer so playback WOULD have something to stream if it ran.
  bot.buffers['0a'] = new RingBuffer(1024); bot.buffers['0a'].write(new Array(200).fill(0.5));

  await bot.ingestTick();
  assert.equal(bot.buffers['0a'].length, 200, 'stood-down aggregator does not drain the page tap');

  await bot.playbackTick();
  assert.equal(calls.enqueued.length, 0, 'stood-down aggregator enqueues no master to the page player');
  assert.equal(bot.buffers['0a'].length, 200, 'and does not consume the buffered audio');

  await bot.stop();
});

test('election gate: the active aggregator ingests and streams normally', async () => {
  const { calls, fakeLauncher } = makeFakes({ pageCaptures: [{ token: '0a', samples: [0.2, 0.4] }] });
  const bot = new AggregatorBot(
    cfg,
    { launcher: fakeLauncher, logIngest: false, isActive: async () => true },
    {}, 1024,
  );
  await bot.start();

  await bot.ingestTick();
  assert.equal(bot.buffers['0a'].length, 2, 'active aggregator drains the page tap into its buffer');

  await bot.playbackTick();
  assert.equal(calls.enqueued.length, 1, 'active aggregator streams the assembled master back out');

  await bot.stop();
});

test('election gate: default isActive polls the page election helper', async () => {
  // No injected isActive -> the bot asks the page. Assert it evaluates the
  // election helper (pageIsActiveAggregator, which reads
  // window.__trussalIsActiveAggregator) before doing ingest work.
  const { calls, fakeLauncher } = makeFakes({ pageCaptures: [{ token: '0a', samples: [0.1] }] });
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.start();

  await bot.playbackTick();
  assert.ok(
    calls.evaluate.some((s) => /__trussalIsActiveAggregator/.test(s)),
    'default gate evaluates the page election helper',
  );

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

// --- gain staging (requirement 6) --------------------------------------------

test('computeGainStaging: passes a master within the ceiling through untouched', () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false });
  const inp = Float32Array.from([0.5, -0.25, 0.75]);
  const { gain, samples } = bot.computeGainStaging(inp);
  assert.equal(gain, 1);
  assert.equal(samples, inp, 'no scaling -> same buffer, no copy');
});

test('computeGainStaging: scales a master hotter than the ceiling down to it', () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false });
  const { gain, samples } = bot.computeGainStaging([2.0, -1.0, 0.5]); // peak 2.0
  assert.equal(gain, 0.5, 'gain = ceiling / peak');
  assert.deepEqual([...samples], [1.0, -0.5, 0.25], 'loudest sample sits exactly at the ceiling');
});

test('round trip: the assembled master is gain-staged before it is streamed out', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.start();

  // One participant whose buffered audio clips (peak 4.0). The master must come
  // back out scaled so its peak is at the ceiling (1.0), i.e. divided by 4.
  bot.buffers['0'] = new RingBuffer(1024);
  bot.buffers['0'].write([4.0, -2.0, 1.0]);

  const a = await bot.readAndAssembleMasterBuffer();
  assert.equal(a.active, '0');
  assert.equal(a.gain, 0.25);
  await bot.playMasterBufferToClient();
  assert.deepEqual(calls.enqueued.at(-1), [1.0, -0.5, 0.25], 'streamed out at the staged level');

  await bot.stop();
});

// --- assign-once jitsiId -> token mapping (requirement 2) --------------------

test('jitsiId pinning: a source keeps its token/buffer even if the token is re-announced', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);

  // First capture pins media-stream source "src-1" to room index 0.
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'src-1', token: '0', samples: [0.1] }]);
  assert.equal(bot.buffers['0'].length, 1);
  assert.deepEqual(bot.order.order(), ['0']);

  // The SAME source later arrives under a different token: its audio must still
  // land in its original buffer (0), not spawn a new "9" slot.
  const summary = await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'src-1', token: '9', samples: [0.2, 0.3] }]);
  assert.equal(bot.buffers['0'].length, 3, 'routed to the pinned buffer');
  assert.equal(bot.buffers['9'], undefined, 'no buffer for the re-announced token');
  assert.deepEqual(bot.order.order(), ['0'], 'ring unchanged');
  assert.equal(summary['0'].wrote, 2);
});

// --- bots stream through the aggregator under their cluster tokens (req 5) ---

test('bots participate in the alternation under their cluster tokens', async () => {
  const { calls, fakeLauncher } = makeFakes();
  let clock = 0;
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {}, 1024,
  );
  await bot.start();

  // A human (0) and two of their bots (0a, 0b). All three are captured from the
  // room and must each get a turn in join order.
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: new Array(10).fill(0.5) },
    { jitsiId: 'bot-0a', token: '0a', samples: new Array(10).fill(0.25) },
    { jitsiId: 'bot-0b', token: '0b', samples: new Array(10).fill(0.125) },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '0a', '0b'], 'humans and bots share one join-order ring');

  const streamed = [];
  for (const timestamp of [0, 1000, 2000]) {
    clock = timestamp;
    const a = await bot.readAndAssembleMasterBuffer();
    await bot.playMasterBufferToClient();
    streamed.push(a.active);
  }
  assert.deepEqual(streamed, ['0', '0a', '0b'], 'each participant (bots included) takes its turn');
  // Bot 0a's turn streamed bot 0a's audio (0.25) — a bot audible only via the aggregator.
  assert.deepEqual(calls.enqueued[1], new Array(10).fill(0.25));

  await bot.stop();
});

// --- room-shape scenarios (join order + alternation vs. continuous) ----------
// These pin the alternation behavior for the room shapes the aggregator has to
// handle. They drive the existing round trip with an injected clock; leave /
// rejoin / replace / remove are a separate milestone (the queue is append-only
// today) and are covered once participant removal lands.

test('two humans: the stream alternates one human per slot (no bots)', async () => {
  const { fakeLauncher } = makeFakes();
  let clock = 0;
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {}, 1024,
  );
  await bot.start();

  // Two humans, no bots — each with their own continuously-buffered audio.
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: new Array(50).fill(0.5) },
    { jitsiId: 'human-1', token: '1', samples: new Array(50).fill(0.25) },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '1'], 'two humans in join order');

  const streamed = [];
  for (const timestamp of [0, 1000, 2000, 3000]) {
    clock = timestamp;
    streamed.push((await bot.readAndAssembleMasterBuffer()).active);
  }
  // Same alternation as a multi-cluster room: one participant per slot, wrapping.
  assert.deepEqual(streamed, ['0', '1', '0', '1'], 'audio alternates between the two humans');

  await bot.stop();
});

test('two human-bot clusters: the stream alternates through all six in join order', async () => {
  const { fakeLauncher } = makeFakes();
  let clock = 0;
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {}, 1024,
  );
  await bot.start();

  // Human 0 with bots 0a/0b, and human 1 with bots 1a/1b — two clusters, one ring.
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0',  samples: [0.5] },
    { jitsiId: 'bot-0a',  token: '0a', samples: [0.4] },
    { jitsiId: 'bot-0b',  token: '0b', samples: [0.3] },
    { jitsiId: 'human-1', token: '1',  samples: [0.2] },
    { jitsiId: 'bot-1a',  token: '1a', samples: [0.15] },
    { jitsiId: 'bot-1b',  token: '1b', samples: [0.1] },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '0a', '0b', '1', '1a', '1b'],
    'both clusters share one join-order ring');

  const streamed = [];
  for (let i = 0; i < 6; i++) { clock = i * 1000; streamed.push((await bot.readAndAssembleMasterBuffer()).active); }
  assert.deepEqual(streamed, ['0', '0a', '0b', '1', '1a', '1b'], 'alternates through every cluster member');

  clock = 6000; // a full lap later the pointer wraps back to the first participant
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '0', 'rotation wraps round');

  await bot.stop();
});

test('large fleet: 1 human + 27 bots each take exactly one turn per lap', async () => {
  const { fakeLauncher } = makeFakes();
  let clock = 0;
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {}, 1024,
  );
  await bot.start();

  // Human 0 and 27 of its bots. Suffixes run a..z then aa for the 28th slot; the
  // assertions read back through bot.order.order() so they hold whatever order the
  // tokenOrder tiebreak produces for the co-arriving batch.
  const suffix = (i) => (i < 26 ? String.fromCharCode(97 + i) : 'a' + String.fromCharCode(97 + i - 26));
  const captures = [{ jitsiId: 'human-0', token: '0', samples: [0.5] }];
  for (let i = 0; i < 27; i++) captures.push({ jitsiId: `bot-0${suffix(i)}`, token: `0${suffix(i)}`, samples: [0.1] });
  await bot.writeToIndividualParticipantBufferQueues(captures);
  assert.equal(bot.order.size, 28, '28 participants in the ring');

  const streamed = [];
  for (let botIndex = 0; botIndex < 28; botIndex++) { clock = botIndex * 1000; streamed.push((await bot.readAndAssembleMasterBuffer()).active); }
  assert.deepEqual(streamed, bot.order.order(), 'every participant takes exactly one turn per lap');

  clock = 28000;
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, bot.order.order()[0], 'wraps after a full lap');

  await bot.stop();
});

test('single human, no bots: one continuous stream, never alternating', async () => {
  const { calls, fakeLauncher } = makeFakes();
  let clock = 0;
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {}, 1024,
  );
  await bot.start();

  // Only one participant: every slot is theirs, so the stream never switches
  // sources. Fresh audio arrives each tick to model a continuous live capture.
  const actives = [];
  for (const timestamp of [0, 1000, 2000, 3000, 4000]) {
    clock = timestamp;
    await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'human-0', token: '0', samples: new Array(10).fill(0.5) }]);
    actives.push((await bot.readAndAssembleMasterBuffer()).active);
    await bot.playMasterBufferToClient();
  }
  assert.deepEqual(actives, ['0', '0', '0', '0', '0'], 'the sole human streams continuously, every slot');
  assert.equal(bot.order.size, 1, 'the ring never grows a second slot');
  // Continuous: every tick streamed the fresh audio, so there are no silence gaps.
  assert.equal(calls.enqueued.length, 5, 'streamed on every tick');
  assert.ok(calls.enqueued.every((c) => c.length === 10), 'each tick streamed the human\'s audio, not silence');

  await bot.stop();
});

// --- sample validation: only finite floats in [-1.0, 1.0] are accepted -------
// A sample is valid normalized PCM iff it is a finite number within full scale.
// Out-of-range magnitudes and non-number data types are rejected, so corrupt or
// mis-typed frames never reach a participant buffer or the master mix.

test('isValidSampleBuffer: accepts finite floats in [-1.0, 1.0], including the boundaries', () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false });
  assert.equal(bot.isValidSampleBuffer([0, 0.5, -0.5, 0.999]), true);
  assert.equal(bot.isValidSampleBuffer([-1.0, 1.0]), true, 'full scale is inclusive');
  assert.equal(bot.isValidSampleBuffer(Float32Array.from([0.25, -0.25])), true, 'a typed array is valid');
  assert.equal(bot.isValidSampleBuffer([]), true, 'an empty buffer is vacuously valid');
});

test('isValidSampleBuffer: rejects out-of-range magnitudes', () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false });
  assert.equal(bot.isValidSampleBuffer([2.0]), false, 'above full scale');
  assert.equal(bot.isValidSampleBuffer([-1.5]), false, 'below full scale');
  assert.equal(bot.isValidSampleBuffer([0.5, 1.0000001]), false, 'one out-of-range sample invalidates the buffer');
});

test('isValidSampleBuffer: rejects non-number sample types, and returns false (never throws) for non-array-like input', () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false });
  // Non-number samples (Number.isFinite never coerces these to a number).
  assert.equal(bot.isValidSampleBuffer([NaN]), false, 'NaN');
  assert.equal(bot.isValidSampleBuffer([Infinity]), false, '+Infinity');
  assert.equal(bot.isValidSampleBuffer([-Infinity]), false, '-Infinity');
  assert.equal(bot.isValidSampleBuffer([0.5, '0.25']), false, 'a numeric string is not a number');
  assert.equal(bot.isValidSampleBuffer([0.5, null]), false, 'null');
  assert.equal(bot.isValidSampleBuffer([0.5, true]), false, 'boolean');
  assert.equal(bot.isValidSampleBuffer([0.5, {}]), false, 'object');
  // Non-array-like samples: rejected outright, not thrown.
  assert.equal(bot.isValidSampleBuffer('nope'), false, 'a string is not a sample buffer');
  assert.equal(bot.isValidSampleBuffer(null), false, 'null buffer');
  assert.equal(bot.isValidSampleBuffer(undefined), false, 'undefined buffer');
  assert.equal(bot.isValidSampleBuffer(42), false, 'a bare number is not a buffer');
  assert.equal(bot.isValidSampleBuffer({ length: 1, 0: 0.5 }), false, 'an array-like object is not accepted');
});

test('writeToIndividualParticipantBufferQueues: rejects captures whose samples are invalid', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);

  // The two invalid captures each log a rejection (left visible) and are skipped.
  const summary = await bot.writeToIndividualParticipantBufferQueues([
    { token: '0', samples: [0.5, -0.25] }, // valid -> accepted
    { token: '1', samples: [2.0, 0.1] },   // out of range -> rejected
    { token: '2', samples: [0.5, 'x'] },   // wrong type -> rejected
  ]);

  assert.equal(summary['0'].wrote, 2, 'the valid capture is accepted');
  assert.equal(bot.buffers['0'].length, 2);
  assert.equal(summary['1'], undefined, 'the out-of-range capture is not accepted');
  assert.equal(bot.buffers['1'], undefined, 'no buffer for the rejected token');
  assert.equal(summary['2'], undefined, 'the wrong-type capture is not accepted');
  assert.equal(bot.buffers['2'], undefined);
  assert.deepEqual(bot.order.order(), ['0'], 'only the valid participant entered the ring');
});

// --- leave / rejoin / replace / remove: participant removal ------------------
// removeParticipant drops a participant's ring slot AND its buffer immediately,
// compacting the ring so no silent gap is left; a rejoin re-appends at the tail
// (the queue's invariant), and a departed room index is never recycled.

test('a human leaving removes its buffer and ring slot immediately (no gap)', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.25] },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '1']);

  assert.equal(bot.removeParticipant('human-0'), '0', 'returns the removed token');
  assert.equal(bot.buffers['0'], undefined, 'the buffers collection shrinks immediately');
  assert.deepEqual(bot.order.order(), ['1'], 'the ring compacts, no gap');
  assert.equal(bot.order.size, 1);
});

test('a bot removed from a cluster leaves the rotation with no gap', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0',  samples: [0.5] },
    { jitsiId: 'bot-0a',  token: '0a', samples: [0.4] },
    { jitsiId: 'bot-0b',  token: '0b', samples: [0.3] },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '0a', '0b']);

  assert.equal(bot.removeParticipant('bot-0a'), '0a');
  assert.equal(bot.buffers['0a'], undefined, 'the removed bot\'s buffer is gone');
  assert.deepEqual(bot.order.order(), ['0', '0b'], 'compacted, no gap');
});

test('a human that leaves and rejoins is re-appended at the tail (survivors keep their order)', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0',  samples: [0.5] },
    { jitsiId: 'bot-0a',  token: '0a', samples: [0.4] },
    { jitsiId: 'human-1', token: '1',  samples: [0.2] },
    { jitsiId: 'bot-1a',  token: '1a', samples: [0.1] },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '0a', '1', '1a']);

  bot.removeParticipant('human-0');
  assert.deepEqual(bot.order.order(), ['0a', '1', '1a'], 'compacted, no gap where 0 was');

  // The same human rejoins under the same jitsiId/token -> a fresh tail slot.
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'human-0', token: '0', samples: [0.5] }]);
  assert.deepEqual(bot.order.order(), ['0a', '1', '1a', '0'], 'rejoin re-appends at the tail');
  assert.equal(bot.buffers['0'].length, 1, 'the rejoiner gets a fresh buffer');
});

test('two humans leaving and rejoining: each returns at the tail in the order they came back', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0',  samples: [0.5] },
    { jitsiId: 'bot-0a',  token: '0a', samples: [0.4] },
    { jitsiId: 'human-1', token: '1',  samples: [0.2] },
    { jitsiId: 'bot-1a',  token: '1a', samples: [0.1] },
  ]);

  bot.removeParticipant('human-0');
  bot.removeParticipant('human-1');
  assert.deepEqual(bot.order.order(), ['0a', '1a'], 'both humans gone, their bots compacted');

  // human 1 returns first, then human 0 -> tail-appended in return order.
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'human-1', token: '1', samples: [0.2] }]);
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'human-0', token: '0', samples: [0.5] }]);
  assert.deepEqual(bot.order.order(), ['0a', '1a', '1', '0'], 'rejoined at the tail, in return order');
});

test('a bot replaced by a fresh instance re-enters at the tail under the same token', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0',    token: '0',  samples: [0.5] },
    { jitsiId: 'bot-0a-old', token: '0a', samples: [0.4] },
    { jitsiId: 'human-1',    token: '1',  samples: [0.2] },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '0a', '1']);

  // The bot crashes and is torn down; the fleet spawns a replacement under 0a.
  bot.removeParticipant('bot-0a-old');
  assert.deepEqual(bot.order.order(), ['0', '1'], 'the crashed bot is gone, compacted');
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'bot-0a-new', token: '0a', samples: [0.3] }]);
  assert.deepEqual(bot.order.order(), ['0', '1', '0a'], 'the replacement re-enters at the tail');
  assert.equal(bot.buffers['0a'].length, 1, 'the replacement gets a fresh buffer');
});

test('a departed room index is not recycled: a new participant gets a fresh token, not the leaver\'s', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.25] },
  ]);

  bot.removeParticipant('human-1');            // room index 1 leaves
  assert.deepEqual(bot.order.order(), ['0']);

  // The sidecar hands the next joiner a FRESH index (2), never the departed 1
  // (see the sidecar-level guarantee in test/sidecar-indices.test.js).
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'human-2', token: '2', samples: [0.1] }]);
  assert.deepEqual(bot.order.order(), ['0', '2'], 'the new participant takes a fresh index');
  assert.equal(bot.order.hasToken('1'), false, 'the departed index 1 is not reassigned');
});
