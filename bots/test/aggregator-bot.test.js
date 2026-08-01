import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RingBuffer } from '../src/bot/ring-buffer.js';
import { AggregatorBot, AGGREGATOR_SLOT_TAKEN } from '../src/bot/aggregator-bot.js';
import { computeWorstCaseMetrics } from '../../src/audio-net/network-modulation/WorstCaseCalculationUtils.js';

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

function makeFakes({ pageCaptures = [], pageLeaves = [] } = {}) {
  const calls = { evalOnNewDoc: [], goto: [], evaluate: [], enqueued: [], roomPushes: [], metrics: 0, closed: false };
  const fakePage = {
    setUserAgent: async () => {},
    evaluateOnNewDocument: async (js) => calls.evalOnNewDoc.push(String(js)),
    goto: async (url) => calls.goto.push(url),
    waitForFunction: async () => {},
    evaluate: async (fn, ...args) => {
      const s = String(fn);
      calls.evaluate.push(s);
      if (/\.drainLeaves\(\)/.test(s)) return pageLeaves;                    // pageDrainParticipantLeaves
      if (/__trussalAggCapture|\.drain\(\)/.test(s)) return pageCaptures;    // pageDrainParticipantAudio
      if (/\.setRoom\(/.test(s)) { calls.roomPushes.push(args[0]); return undefined; } // pageSetMasterRoom
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

// --- ingestTick <-> page-reported leaves (production wiring for removeParticipant) ---
// removeParticipant/CircularParticipantQueue.remove already compact the ring on
// their own (see the "leave / rejoin / replace / remove" suite below); these
// tests pin that ingestTick actually DRIVES that compaction from what the page
// tap reports left the Jitsi conference, since nothing else in production calls
// removeParticipant.

test('ingestTick compacts a page-reported departure out of the rotation (no gap)', async () => {
  const { fakeLauncher } = makeFakes({ pageLeaves: ['human-0'] });
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.start();
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.25] },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '1']);

  await bot.ingestTick(); // page reports human-0 left this tick
  assert.deepEqual(bot.order.order(), ['1'], 'the ring compacted, no gap where 0 was');
  assert.equal(bot.buffers['0'], undefined, 'the departed participant\'s buffer is gone too');

  await bot.stop();
});

test('ingestTick: after a page-reported departure, a rejoin under a fresh id appends at the tail', async () => {
  const { fakeLauncher } = makeFakes({ pageLeaves: ['human-0'] });
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.start();
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.25] },
  ]);

  await bot.ingestTick(); // human-0 leaves, ring compacts to ['1']
  assert.deepEqual(bot.order.order(), ['1']);

  // human-0 rejoins under a fresh Jitsi endpoint id (the sidecar hands the
  // returning participant back its same persistent room-index token).
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'human-0-rejoin', token: '0', samples: [0.5] }]);
  assert.deepEqual(bot.order.order(), ['1', '0'], 'the rejoiner lands at the tail, not back in its old slot');

  await bot.stop();
});

test('ingestTick: a stood-down aggregator does not act on page-reported departures', async () => {
  const { fakeLauncher } = makeFakes({ pageLeaves: ['human-0'] });
  const bot = new AggregatorBot(
    cfg,
    { launcher: fakeLauncher, logIngest: false, isActive: async () => false },
    {}, 1024,
  );
  await bot.start();
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'human-0', token: '0', samples: [0.5] }]);

  await bot.ingestTick();
  assert.deepEqual(bot.order.order(), ['0'], 'a stood-down aggregator leaves the ring untouched');

  await bot.stop();
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

// --- Metaprogram ordering (interpretAndExecuteMetaprogram's queue hookup) ------

test('applyProgramText re-orders the rotation to the $ participants written order', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2] },
    { jitsiId: 'human-2', token: '2', samples: [0.1] },
  ]);
  assert.deepEqual(bot.order.order(), ['0', '1', '2'], 'join order before a program lands');

  const errors = bot.applyProgramText('$ participants <2 0 1>');
  assert.deepEqual(errors, []);
  assert.deepEqual(bot.order.order(), ['2', '0', '1'], 'the written order takes over');
});

test('invalid program text is rejected and leaves the rotation untouched', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2] },
  ]);
  const errors = bot.applyProgramText('$ participants <1 0');
  assert.ok(errors.length > 0, 'parse errors are surfaced to the caller');
  assert.deepEqual(bot.order.order(), ['0', '1'], 'rotation unchanged by the invalid text');
});

test('the master streams participants in the metaprogram order, not join order', async () => {
  let clock = 0;
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {},
    1024,
  );
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5, 0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2, 0.2] },
  ]);
  bot.applyProgramText('$ participants <1 0>');

  clock = 0;
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '1', 'the program lists 1 first');
  clock = 1000;
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '0');
  clock = 2000;
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '1', 'wraps in program order');
});

test('a newcomer stays silent until the metaprogram adds them; their audio buffers all along', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
  ]);
  bot.applyProgramText('$ participants <0>');

  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-1', token: '1', samples: [0.25, 0.25] },
  ]);
  assert.deepEqual(bot.order.order(), ['0'], 'the unlisted newcomer gets no slot');
  assert.deepEqual(bot.order.waitingTokens(), ['1'], 'they wait off the ring');
  assert.equal(bot.buffers['1'].length, 2, 'but their audio keeps buffering');

  bot.applyProgramText('$ participants <1 0>');
  assert.deepEqual(bot.order.order(), ['1', '0'], 'added to the program -> they join the rotation');
  assert.equal(bot.buffers['1'].length, 2, 'their buffered material is ready for their first turn');
});

test('a departed listed participant keeps its slot and buffer until the program drops it', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5, 0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2] },
  ]);
  bot.applyProgramText('$ participants <0 1>');

  bot.removeParticipant('human-0');
  assert.deepEqual(bot.order.order(), ['0', '1'], 'the metaprogram still lists 0 -> ghost keeps its turn');
  assert.ok(bot.buffers['0'], 'its most recent queued buffer survives the leave');
  assert.equal(bot.buffers['0'].length, 2);

  bot.applyProgramText('$ participants <1>');
  assert.deepEqual(bot.order.order(), ['1'], 'dropping 0 from the program retires the ghost');
  assert.equal(bot.buffers['0'], undefined, 'and only then is its buffer removed');
});

test('a departed ghost replays its last scheduled buffer even after its live turn drained it', async () => {
  let clock = 0;
  const { fakeLauncher } = makeFakes();
  // masterSliceSamples is huge (250ms @ 48kHz), so a live turn drains the whole
  // small buffer in one tick — exactly the production case where, by the time a
  // participant leaves, its RingBuffer is already empty.
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {},
    1024,
  );
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5, 0.5, 0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2] },
  ]);
  bot.applyProgramText('$ participants <0 1>');

  // Participant 0 takes a LIVE turn first: its buffer is snapshotted (before the
  // drain) and then consumed to empty.
  clock = 0;
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '0');
  assert.equal(bot.buffers['0'].length, 0, 'the live turn drained the RingBuffer to empty');

  // NOW 0 leaves. Its RingBuffer holds nothing — the old fix looped that empty
  // buffer and produced silence. The retained pre-drain snapshot is the source.
  bot.removeParticipant('human-0');

  clock = 1000; // participant 1's turn
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '1');

  clock = 2000; // the ghost comes round again
  let r = await bot.readAndAssembleMasterBuffer();
  assert.equal(r.active, '0', 'the ghost still takes its turn');
  assert.equal(r.assembled, 3, 'and replays its last scheduled audio, not a silent gap');

  clock = 4000; // and again a full lap later — still not silence
  assert.equal((await bot.readAndAssembleMasterBuffer()).assembled, 3, 'the ghost keeps replaying');

  // Only dropping 0 from the program retires it (snapshot + buffer gone for good).
  bot.applyProgramText('$ participants <1>');
  assert.equal(bot.buffers['0'], undefined, 'the metaprogram dropping 0 finally deletes its buffer');
});

test('a departed ghost replays a FULL cycle of accumulated audio, not a sub-second fragment looped', async () => {
  const { calls, fakeLauncher } = makeFakes();
  let clock = 0;
  // sampleRate 4 + playbackIntervalMs 0 (loops off) -> masterSliceSamples 1 (one
  // sample streamed per tick); slotMs 1000 -> slotSamples 4 (a "cycle" is 4
  // samples, i.e. 4 ticks); holdMs 500 -> the per-participant RingBuffer holds
  // only 2 samples at once — HALF a cycle — so a single snapshot could never
  // retain a whole cycle; only cross-tick accumulation can. Values are exactly
  // representable in float32 so they survive the Array round-trip unchanged.
  const bot = new AggregatorBot(
    { ...cfg, sampleRate: 4, slotMs: 1000, holdMs: 500 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {}, 1024,
  );
  await bot.start();               // installs the page playback sink (calls.enqueued)
  assert.equal(bot.masterSliceSamples, 1);
  assert.equal(bot.slotSamples, 4);
  bot.applyProgramText('$ participants <0>');   // single listed participant -> ghosts on leave

  const tick = async (t) => { clock = t; await bot.readAndAssembleMasterBuffer(); await bot.playMasterBufferToClient(); return calls.enqueued.at(-1); };
  const feed = (samples) => bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'h0', token: '0', samples }]);

  // Live turn (slot 0), streaming four distinct samples one per tick while the
  // 2-sample buffer is refilled between ticks — no instant ever holds > 2 samples.
  await feed([0.5, 0.25]);
  assert.deepEqual(await tick(0), [0.5]);
  await feed([0.125]);
  assert.deepEqual(await tick(1), [0.25]);
  await feed([0.0625]);
  assert.deepEqual(await tick(2), [0.125]);
  assert.deepEqual(await tick(3), [0.0625]);
  assert.equal(bot.buffers['0'].length, 0, 'the live turn drained the buffer');

  // 0 leaves; still listed -> ghost. Its retained window is the WHOLE cycle.
  bot.removeParticipant('h0');

  // Over the ghost's next turn (slot 1) it replays all four samples IN ORDER —
  // the full cycle — instead of looping the ~half-cycle a snapshot would hold
  // (which would give 0.5,0.25,0.5,0.25).
  const g = [await tick(1000), await tick(1001), await tick(1002), await tick(1003)].flat();
  assert.deepEqual(g, [0.5, 0.25, 0.125, 0.0625], 'ghost replays a full cycle end-to-end');

  // Only at the NEXT turn does it loop back to the top of the cycle.
  assert.deepEqual(await tick(2000), [0.5], 'a new turn restarts the cycle from the start');
});

test('re-applying a program that still lists a departed participant silences it (Case 2) and drops its buffer', async () => {
  let clock = 0;
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {},
    1024,
  );
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5, 0.5, 0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2] },
  ]);
  bot.applyProgramText('$ participants <0 1>');

  // 0 takes a live turn (snapshotting its buffer) and then leaves -> ghost replay.
  clock = 0;
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '0');
  bot.removeParticipant('human-0');
  clock = 2000; // 0 comes round again as a ghost
  assert.equal((await bot.readAndAssembleMasterBuffer()).assembled, 3, 'the ghost replays its last audio');

  // The performer re-applies the SAME program; nobody rejoined as 0. Case 2:
  // 0 is reset to a silent placeholder and its retained audio is dropped —
  // it is now treated like a token listed but never seen.
  bot.applyProgramText('$ participants <0 1>');
  assert.deepEqual(bot.order.order(), ['0', '1'], '0 keeps its ring position — now a silent placeholder');
  assert.equal(bot.buffers['0'], undefined, 'its stale buffer is dropped on the re-apply');

  clock = 4000; // 0's turn again — silent now, not a replaying ghost
  const r = await bot.readAndAssembleMasterBuffer();
  assert.equal(r.active, '0', '0 still takes its placeholder turn');
  assert.equal(r.assembled, 0, 'but streams silence, not a replay');
});

test('a rejoin on the departed index reclaims the slot (Case 3); a later re-apply keeps it live', async () => {
  let clock = 0;
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {},
    1024,
  );
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2] },
  ]);
  bot.applyProgramText('$ participants <0 1>');
  clock = 0;
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '0');

  // 0 leaves -> ghost.
  bot.removeParticipant('human-0');
  assert.equal(bot.order.serve().departed, true, 'index 0 is a ghost');

  // A DIFFERENT participant rejoins on the same room index (identity-stable
  // reclaim) and delivers fresh audio: the slot is reclaimed and un-ghosted.
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0-rejoined', token: '0', samples: [0.7, 0.7, 0.7] },
  ]);
  assert.equal(bot.order.serve().departed, false, 'fresh audio revived the reclaimed slot');

  // A genuine re-apply that still lists 0 keeps the reclaimed slot LIVE and
  // does NOT drop its buffer — it is a live participant, not a stale ghost.
  bot.applyProgramText('$ participants <0 1>');
  assert.deepEqual(bot.order.order(), ['0', '1']);
  assert.ok(bot.buffers['0'] && bot.buffers['0'].length > 0, "the rejoiner's live buffer survives the re-apply");

  clock = 2000; // 0's turn: it streams the rejoiner's LIVE audio
  const r = await bot.readAndAssembleMasterBuffer();
  assert.equal(r.active, '0');
  assert.equal(r.assembled, 3, "plays the rejoiner's fresh audio, not a ghost loop");
});

test('a participant that delivered audio while UNLISTED is not stranded off-ring when later listed; its leave ghosts', async () => {
  let clock = 0;
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {},
    1024,
  );
  // Program lists only 0. 0a delivers audio while UNLISTED -> parks off-ring.
  bot.applyProgramText('$ participants <0>');
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'bot-0a', token: '0a', samples: [0.3, 0.3, 0.3] },
  ]);

  // A playback tick runs #syncOrderFromBuffers. The old bug re-registered 0a's
  // buffer as a pseudo-id off-ring pin (hasToken was ring-only); knowsToken now
  // skips it, so there is exactly ONE off-ring pin — 0a's real source.
  clock = 0;
  await bot.readAndAssembleMasterBuffer();
  assert.deepEqual(bot.order.waitingTokens(), ['0a'], 'one off-ring pin (real source), no pseudo-id duplicate');

  // Listing 0a folds the REAL source into the ring (not a silent placeholder).
  bot.applyProgramText('$ participants <0 0a>');
  assert.equal(bot.order.jitsiIdFor('0a'), 'bot-0a', 'the ring slot binds 0a\'s real media-stream id');
  assert.deepEqual(bot.order.waitingTokens(), [], 'nothing stranded off-ring');

  // 0a leaves. Because its live source is in-ring under a listed token, the leave
  // GHOSTS — the buffer is kept and replays — rather than being dropped silently.
  bot.removeParticipant('bot-0a');
  assert.deepEqual(bot.order.order(), ['0', '0a'], 'the metaprogram still lists 0a -> ghost slot kept');
  assert.ok(bot.buffers['0a'], 'the ghost buffer persists after the leave');

  clock = 1000; // 0a's turn as a ghost: it replays, not silence
  const r = await bot.readAndAssembleMasterBuffer();
  assert.equal(r.active, '0a');
  assert.ok(r.assembled > 0, 'the ghost replays its last audio instead of a silent gap');
});

test('fresh audio revives a spuriously-departed participant so it plays live, not a stale loop', async () => {
  let clock = 0;
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 1000 },
    { launcher: fakeLauncher, logIngest: false, now: () => clock },
    {},
    1024,
  );
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.2, 0.2] },
  ]);
  bot.applyProgramText('$ participants <0 1>');

  clock = 0; // anchor the rotation's start (first serve pins slot 0)
  assert.equal((await bot.readAndAssembleMasterBuffer()).active, '0');

  // A transient roster/play blip marks 1 departed even though it never left.
  bot.removeParticipant('human-1');
  assert.deepEqual(bot.order.order(), ['0', '1'], 'still listed -> ghost slot kept');

  // 1 keeps delivering audio (it was never really gone): that must un-ghost it.
  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-1', token: '1', samples: [0.9, 0.9, 0.9] },
  ]);

  clock = 1000; // 1's turn: it must stream its LIVE buffer (consumed), not a loop
  const r = await bot.readAndAssembleMasterBuffer();
  assert.equal(r.active, '1');
  assert.equal(r.assembled, 5, 'plays all its live audio (2 held + 3 fresh)');
  assert.equal(bot.buffers['1'].length, 0, 'the revived buffer is drained like any live one');
});

test('start() reaches interpretAndExecuteMetaprogram; without a WebSocket impl it skips cleanly', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false }, {}, 1024);
  await bot.start();
  assert.equal(bot.o2, null, 'metaprogram sync skipped: no WebSocket implementation wired');
  assert.equal(bot.scheduler, null, 'no scheduler without the O2/CRDT wiring');
  await bot.stop();
});

// Minimal WebSocket fake for O2LiteClient: fires 'open' asynchronously but
// stays readyState 0, so the client's send() guard drops every outbound
// frame (the bot tolerates running unsynced).
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    setTimeout(() => (this.listeners.get('open') || []).forEach((fn) => fn()), 0);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const fns = this.listeners.get(type) || [];
    const i = fns.indexOf(fn);
    if (i >= 0) fns.splice(i, 1);
  }
  send() {}
  close() {}
}

test('with no shared program, the metaprogram defaults to participant 0 streaming continuously', async () => {
  const { fakeLauncher } = makeFakes();
  const bot = new AggregatorBot(cfg, { launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket }, {}, 1024);

  await bot.interpretAndExecuteMetaprogram();

  assert.equal(bot.programText, '$ participants <0>\n# cycles wcl 2000\n');
  assert.ok(bot.order.hasValidMetaprogram(), 'the default program puts the ring in metaprogram mode');
  assert.ok(bot.scheduler, 'the scheduler runs the default program');

  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'human-0', token: '0', samples: [0.5] },
    { jitsiId: 'human-1', token: '1', samples: [0.25] },
  ]);
  assert.deepEqual(bot.order.order(), ['0'], 'only participant 0 rotates (continuously)');
  assert.deepEqual(bot.order.waitingTokens(), ['1'], 'a joiner waits silent until an edit lists them');
  assert.equal(bot.buffers['1'].length, 1, 'their audio buffers all along');

  await bot.stop();
});

// --- clock timebase ------------------------------------------------------------
// The O2 relay's reference clock is process.hrtime since the SIDECAR started
// (latency-instrument/o2-relay.js) — a small number. The bot's own clock must
// live on the same scale, or the moment ClockSync converges every already-
// scheduled cycle lands on a timeline the bot will never reach. That is what
// silenced a live room: the scheduler emitted cycle 0 and then nothing, for ever.

test('the scheduler clock is monotonic from bot start, not Unix epoch seconds', () => {
  const { fakeLauncher } = makeFakes();
  const clockRef = { ms: 1785540000000 }; // a realistic Date.now()
  const bot = new AggregatorBot(
    cfg,
    { launcher: fakeLauncher, logIngest: false, now: () => clockRef.ms },
    {}, 1024,
  );
  // First read anchors t0, so the bot's clock starts near zero however large
  // the injected wall clock is — the same scale the relay quotes.
  assert.equal(bot.schedulerClockSeconds(), 0);
  clockRef.ms += 4500;
  assert.equal(bot.schedulerClockSeconds(), 4.5);
  assert.ok(bot.schedulerClockSeconds() < 1e6,
    'must not be ~1.79e9 — that scale is what fell off a cliff at ClockSync convergence');
});

test('an epoch from another timebase is refused, not adopted', async () => {
  const { fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const clockRef = { ms: 1785540000000 };
  const bot = new AggregatorBot(
    cfg,
    { launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket,
      connectSidecar: bus.connect, now: () => clockRef.ms },
    {}, 1024,
  );
  try {
    await bot.interpretAndExecuteMetaprogram();
    const ownEpoch = bot.epoch;
    assert.ok(Number.isFinite(ownEpoch), 'the bot declared an epoch');

    // A browser that broadcast an epoch off its unsynced AudioContext clock,
    // or any peer on a different timeline: smaller, but not ours. Adopting it
    // would anchor the grid ~1.79e9 s away and emit nothing for ever.
    bot.adoptEpochIfEarlier(-1785540000);
    assert.equal(bot.epoch, ownEpoch, 'implausible epoch refused');
    bot.adoptEpochIfEarlier(Number.NaN);
    assert.equal(bot.epoch, ownEpoch, 'NaN refused');
    // A future epoch is not "earlier" and must never win either.
    bot.adoptEpochIfEarlier(ownEpoch + 9999);
    assert.equal(bot.epoch, ownEpoch, 'later epoch refused');
  } finally {
    await bot.stop();
  }
});

test('the cycle grid survives a ClockSync convergence jump', async () => {
  const { fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const clockRef = { ms: 1785540000000 };
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 4000 },
    { launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket,
      connectSidecar: bus.connect, now: () => clockRef.ms },
    {}, 1024,
  );
  try {
    await bot.interpretAndExecuteMetaprogram();
    bot.applyProgramText('$ participants <0 1>\n# cycles wcl 2000\n');
    bus.rec.deliver({ type: 'roster', peers: [{ peerId: 'p0', roomIndex: '0', rtt: 4 }] });
    bot.buffers['0'] = new RingBuffer(4096);
    bot.buffers['1'] = new RingBuffer(4096);

    clockRef.ms += 30000;
    bot.scheduler.tick();   // drive the grid explicitly; the 50 ms interval is real time
    assert.ok((await bot.readAndAssembleMasterBuffer()).active, 'streaming before convergence');
    const cyclesBefore = bot.scheduler.getCycle();
    assert.ok(cyclesBefore > 0, 'the grid advanced before the jump');

    // ClockSync converges: network time becomes the relay's reference, offset
    // from the bot's own clock. Swapping bot.clock is the real injection point
    // — it is the same public field makeClockSyncOverO2 assigns. Under the old
    // Date.now()/1000 base this was a ~1.79e9 s cliff; the grid must keep
    // advancing across it either way.
    const OFFSET = -500;
    // Stop the real ClockSync before displacing it: its resync chain reschedules
    // itself, and a stub that only *looks* like it would leave that timer running
    // and hold the process open after the test finishes.
    bot.clock.stop();
    bot.clock = {
      isSynced: () => true,
      toNetworkTime: (t) => t + OFFSET,
      toAudioTime: (t) => t - OFFSET,
      stop() {},
    };
    clockRef.ms += 10000;
    bot.scheduler.tick();
    assert.ok(bot.scheduler.getCycle() > cyclesBefore,
      'the scheduler kept emitting cycles across the jump');
    clockRef.ms += 10000;
    bot.scheduler.tick();
    assert.ok((await bot.readAndAssembleMasterBuffer()).active,
      'and the room is still streaming, not silent');

    // A huge FORWARD jump (the relay restarting far ahead of us) must re-anchor
    // too, not grind out every missed cycle one at a time.
    const startedAt = Date.now();
    bot.clock = { isSynced: () => true, toNetworkTime: (t) => t + 1e9, toAudioTime: (t) => t - 1e9, stop() {} };  // already a stub; nothing real to stop
    bot.scheduler.tick();
    assert.ok(Date.now() - startedAt < 2000, 'a far-future clock re-anchors instead of hanging');
    assert.ok((await bot.readAndAssembleMasterBuffer()).active, 'still streaming after the forward jump');
  } finally {
    await bot.stop();
  }
});

// --- scheduler-paced rotation -------------------------------------------------
// Turn length comes from the metaprogram's slot-open/slot-close grid, so it is
// the cycle length `# cycles` computes — not the fixed slotMs the join-order
// write pointer uses.

// The turn length actually in force, measured BOUNDARY TO BOUNDARY: advance the
// clock until the streamed token changes (that is a turn boundary), then report
// how long until the next change. Starting mid-turn and measuring to the first
// change would report the remainder of a turn, not a whole one — the grid is
// generally out of phase with any arbitrary start time.
async function measureTurnMs(bot, clockRef, startMs, stepMs = 100, limitMs = 80000) {
  clockRef.ms = startMs;
  let prev = (await bot.readAndAssembleMasterBuffer()).active;
  let boundary = null;
  for (let t = startMs + stepMs; t <= startMs + limitMs; t += stepMs) {
    clockRef.ms = t;
    const active = (await bot.readAndAssembleMasterBuffer()).active;
    if (active === prev) continue;
    prev = active;
    if (boundary == null) { boundary = t; continue; }
    return t - boundary;
  }
  return null;
}

test('turn length follows the cycle length # cycles computes, not the fixed slotMs', async () => {
  const { fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const clockRef = { ms: 0 };
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 4000 },
    { launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket,
      connectSidecar: bus.connect, now: () => clockRef.ms },
    {}, 1024,
  );
  try {
    await bot.interpretAndExecuteMetaprogram();
    // rtt 6 -> wcl 3 ms; x 2000 = 6 s cycles. Deliberately NOT the configured
    // 4000 ms slotMs, so a turn still coming from the write pointer is obvious.
    bot.applyProgramText('$ participants <0 1>\n# cycles wcl 2000\n');
    bus.rec.deliver({ type: 'roster', peers: [{ peerId: 'p0', roomIndex: '0', rtt: 6 }] });
    bot.buffers['0'] = new RingBuffer(4096);
    bot.buffers['1'] = new RingBuffer(4096);

    // Metrics land at a cycle boundary, so cross one before measuring.
    clockRef.ms = 30000; await bot.readAndAssembleMasterBuffer();
    assert.equal(bot.scheduler.getCycleLength().seconds, 6, 'wcl 3 ms x 2000 -> a 6 s cycle');
    const shortTurn = await measureTurnMs(bot, clockRef, 60000);
    assert.ok(Math.abs(shortTurn - 6000) <= 200, `turn tracked the 6 s cycle (got ${shortTurn}ms)`);
    assert.notEqual(shortTurn, bot.slotMs, 'the fixed slotMs no longer paces anything');

    // The room degrades: rtt 14 -> wcl 7 ms -> 14 s cycles.
    bus.rec.deliver({ type: 'peer-update', peerId: 'p0', patch: { rtt: 14 } });
    clockRef.ms = 200000; await bot.readAndAssembleMasterBuffer();
    assert.equal(bot.scheduler.getCycleLength().seconds, 14);
    const longTurn = await measureTurnMs(bot, clockRef, 260000);
    assert.ok(Math.abs(longTurn - 14000) <= 200, `turn stretched with wcl (got ${longTurn}ms)`);
    assert.ok(longTurn > shortTurn, 'a worse network gives each performer a longer turn');
  } finally {
    await bot.stop();
  }
});

test('a metaprogram rest schedules silence; an empty grid falls back to the write pointer', async () => {
  const { fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const clockRef = { ms: 0 };
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 4000 },
    { launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket,
      connectSidecar: bus.connect, now: () => clockRef.ms },
    {}, 1024,
  );
  try {
    // Before any scheduler grid exists the join-order write pointer still
    // paces, so standalone/unit runs are unaffected by any of this.
    bot.buffers['0'] = new RingBuffer(4096); bot.buffers['0'].write(new Array(50).fill(0.5));
    assert.equal((await bot.readAndAssembleMasterBuffer()).active, '0', 'fallback pacing before the grid');

    await bot.interpretAndExecuteMetaprogram();
    // `<0 ~>`: participant 0 plays one cycle, the next cycle is a rest.
    bot.applyProgramText('$ participants <0 ~>\n# cycles wcl 2000\n');
    bus.rec.deliver({ type: 'roster', peers: [{ peerId: 'p0', roomIndex: '0', rtt: 4 }] });
    clockRef.ms = 30000; await bot.readAndAssembleMasterBuffer();
    assert.equal(bot.scheduler.getCycleLength().seconds, 4);

    // Walk several cycles: some carry the token, the rests carry nothing. A
    // rest is deliberate silence, NOT a stale grid to fall back from.
    const seen = new Set();
    for (let t = 60000; t < 76000; t += 500) {
      clockRef.ms = t;
      seen.add((await bot.readAndAssembleMasterBuffer()).active);
    }
    assert.ok(seen.has('0'), 'the played cycle streams participant 0');
    assert.ok(seen.has(null), 'the rest cycle streams nothing at all');
    assert.equal(seen.size, 2, 'nothing else ever streams');
  } finally {
    await bot.stop();
  }
});

test('the ghost retention window follows the cycle length and is capped', async () => {
  const { fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const clockRef = { ms: 0 };
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 4000 },
    { launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket,
      connectSidecar: bus.connect, now: () => clockRef.ms },
    {}, 1024,
  );
  try {
    // No scheduler yet: the window falls back to slotMs, as the pacing does.
    assert.equal(bot.slotSamples, Math.round(bot.slotMs * bot.sampleRate / 1000));

    await bot.interpretAndExecuteMetaprogram();
    bot.applyProgramText('$ participants <0 1>\n# cycles wcl 2000\n');
    bus.rec.deliver({ type: 'roster', peers: [{ peerId: 'p0', roomIndex: '0', rtt: 2 }] }); // wcl 1 ms -> 2 s
    clockRef.ms = 30000; await bot.readAndAssembleMasterBuffer();
    assert.equal(bot.slotSamples, 2 * bot.sampleRate, 'retains exactly one 2 s turn');

    // A badly degraded room would demand an unbounded window; it is capped so
    // the per-participant cost cannot grow without limit.
    bus.rec.deliver({ type: 'peer-update', peerId: 'p0', patch: { rtt: 60 } }); // wcl 30 ms -> 60 s
    clockRef.ms = 300000; await bot.readAndAssembleMasterBuffer();
    assert.equal(bot.scheduler.getCycleLength().seconds, 60);
    assert.equal(bot.slotSamples, 10 * bot.sampleRate, 'capped at MAX_RETAIN_MS, not 60 s');
  } finally {
    await bot.stop();
  }
});

test('an unusable slot grid falls back to the write pointer instead of going silent', async () => {
  // The live outage in the flesh: the grid was banked against one clock, the
  // clock moved, and every banked slot sat unreachably in the future. Read as
  // an endless rest, the room stayed silent for ever. Pacing must fail OPEN.
  const { fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const clockRef = { ms: 1785540000000 };
  const bot = new AggregatorBot(
    { ...cfg, slotMs: 4000 },
    { launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket,
      connectSidecar: bus.connect, now: () => clockRef.ms },
    {}, 1024,
  );
  try {
    await bot.interpretAndExecuteMetaprogram();
    bot.applyProgramText('$ participants <0 1>\n# cycles wcl 2000\n');
    bus.rec.deliver({ type: 'roster', peers: [{ peerId: 'p0', roomIndex: '0', rtt: 4 }] });
    bot.buffers['0'] = new RingBuffer(4096); bot.buffers['0'].write(new Array(50).fill(0.5));
    bot.buffers['1'] = new RingBuffer(4096); bot.buffers['1'].write(new Array(50).fill(0.25));

    clockRef.ms += 30000;
    bot.scheduler.tick();
    assert.ok((await bot.readAndAssembleMasterBuffer()).active, 'streaming under scheduler pacing');

    // Strand the grid exactly as the outage did: freeze the scheduler so it
    // cannot re-anchor, then move the clock out from under the banked slots.
    bot.scheduler.stop();
    bot.clock.stop();
    bot.clock = {
      isSynced: () => true,
      toNetworkTime: (t) => t - 1_000_000,
      toAudioTime: (t) => t + 1_000_000,
      stop() {},
    };

    // Every banked slot is now ~1e6 s in the future. The room must NOT fall
    // silent: the write pointer takes over.
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      clockRef.ms += 4000;
      seen.add((await bot.readAndAssembleMasterBuffer()).active);
    }
    assert.ok(!seen.has(null), `never silent across the stall (saw ${[...seen]})`);
    assert.ok(seen.has('0') || seen.has('1'), 'a real participant is streaming');
  } finally {
    await bot.stop();
  }
});

// --- master-bus room reverb (`# room wcl …`) ----------------------------------

// A sidecar connector that hands the test the bot's own onMessage callback, so
// roster/metrics frames can be delivered the way the real bus would.
function fakeMetaprogramBus() {
  const rec = { deliver: null, sent: [] };
  const connect = (url, { onOpen, onMessage }) => {
    rec.deliver = onMessage;
    onOpen((msg) => rec.sent.push(msg));
    return { send: (msg) => rec.sent.push(msg), close: () => {} };
  };
  return { connect, rec };
}

test('# room wcl scales the master reverb decay by the room worst-case latency', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const bot = new AggregatorBot(cfg, {
    launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket, connectSidecar: bus.connect,
  }, {}, 1024);
  await bot.start();

  // The bot must derive wcl from the roster exactly as every browser does, so
  // the expectation comes from that same function rather than a copied formula.
  const peers = [{ peerId: 'p0', roomIndex: '0', rtt: 4 }, { peerId: 'p1', roomIndex: '1', rtt: 2 }];
  bus.rec.deliver({ type: 'roster', peers });
  bot.applyProgramText('$ participants <0 1>\n# room wcl 2\n');

  const pushed = calls.roomPushes.at(-1);
  assert.ok(pushed, 'room params reach the page master player');
  assert.equal(pushed.decayS, 2 * computeWorstCaseMetrics(peers).wcl / 1000, 'decay = scale x wcl');
  assert.equal(pushed.combFeedbacks.length, pushed.combDelaysS.length);

  // A worse link lengthens the tail without rebuilding anything.
  bus.rec.deliver({ type: 'peer-update', peerId: 'p1', patch: { rtt: 10 } });
  const after = calls.roomPushes.at(-1);
  assert.ok(after.decayS > pushed.decayS, 'a slower peer stretches the decay');

  await bot.stop();
});

test('# room wcl with a fixed amount pins the decay against live metrics', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const bot = new AggregatorBot(cfg, {
    launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket, connectSidecar: bus.connect,
  }, {}, 1024);
  await bot.start();

  bot.applyProgramText('$ participants <0>\n# room wcl 2 0.4\n');
  assert.equal(calls.roomPushes.at(-1).decayS, 0.8, '2 x 400 ms');

  const pushesBefore = calls.roomPushes.length;
  bus.rec.deliver({ type: 'roster', peers: [{ peerId: 'p0', roomIndex: '0', rtt: 250 }] });
  assert.equal(calls.roomPushes.length, pushesBefore, 'pinned decay ignores the metrics change');

  await bot.stop();
});

test('dropping # room from the program clears the master reverb', async () => {
  const { calls, fakeLauncher } = makeFakes();
  const bus = fakeMetaprogramBus();
  const bot = new AggregatorBot(cfg, {
    launcher: fakeLauncher, logIngest: false, webSocketImpl: FakeWebSocket, connectSidecar: bus.connect,
  }, {}, 1024);
  await bot.start();

  // The page starts dry, so a program with no `# room` must not push at all.
  bot.applyProgramText('$ participants <0>\n');
  assert.deepEqual(calls.roomPushes, [], 'no reverb directive -> nothing pushed');

  bot.applyProgramText('$ participants <0>\n# room wcl 2 0.4\n');
  assert.ok(calls.roomPushes.at(-1), 'reverb applied');
  bot.applyProgramText('$ participants <0>\n');
  assert.equal(calls.roomPushes.at(-1), null, 'removing the directive tears the reverb down');

  await bot.stop();
});
