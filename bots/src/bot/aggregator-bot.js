import { Bot } from './bot.js';
import { browserLaunchOptions, spoofedUserAgent, jitsiRoomUrl } from './chromium-args.js';
import {
  pageMarkBot, pageMarkAggregator, pageAudioBridge, pageGumOverride,
  pageAggregatorCapture, pageDrainParticipantAudio, pageDrainParticipantLeaves,
  pageAggregatorCaptureDiag, pageFpsSampler,
  pageEnsureAudioPublished, pageMasterPlayer, pageEnqueueMaster, pageIsActiveAggregator,
  pageReportStudioStatus, pageAggregatorTrackMapDiag, pageSetMasterRoom, pageSetMasterNoise,
  pageSetMasterCrush, pageSetMasterEcho,
} from './page-scripts.js';
import { RingBuffer } from './ring-buffer.js';
import { CircularParticipantQueue, tokenOrder } from './circular-participant-queue.js';
import { createMetaprogramDoc, connectMetaprogramSync } from '../../../src/audio-net/MetaprogrammerCrdtSync.js';
import { parseMetaprogram, buildDefaultProgram, resolveEffectParams } from '../../../src/audio-net/MetaprogrammerParser.js';
import { computeWorstCaseMetrics, mergeInducedMetrics } from '../../../src/audio-net/network-modulation/WorstCaseCalculationUtils.js';
import { roomParams } from '../../../src/audio-net/av-effects/Room.js';
import { noiseParams } from '../../../src/audio-net/av-effects/Noise.js';
import { crushParams } from '../../../src/audio-net/av-effects/Crush.js';
import { echoParams } from '../../../src/audio-net/av-effects/Echo.js';
// The master-bus counterpart of the browser chain's pattern tick: same reader,
// same cadence, so a patterned argument steps identically on both paths.
import { chainHasValuePattern, PATTERN_TICK_MS } from '../../../src/audio-net/ValuePattern.js';
import { makeClockSyncOverO2 } from '../../../src/audio-net/ClockSync.js';
import O2LiteClient from '../../../public/lib/o2lite-web.js';
import { MetaprogramScheduler } from '../../../src/audio-net/MetaprogramScheduler.js';

// How often the ingest loop drains the page tap into the buffers.
const DEFAULT_INGEST_INTERVAL_MS = 500;
// How often the playback loop assembles the master and streams it back out.
const DEFAULT_PLAYBACK_INTERVAL_MS = 250;
// Round-robin turn length (ms) before the metaprogram schedules slots for real:
// stream one participant, then the next, so the alternation is audible.
const DEFAULT_SLOT_MS = 4000;
// How long to let ClockSync converge before declaring a cycle epoch. One burst
// is ~700 ms (DEFAULT_BURST sends at DEFAULT_BURST_SPACING_MS, plus a 2x
// spacing commit), so this allows several attempts on a slow start.
const CLOCK_SYNC_WAIT_MS = 5000;
const CLOCK_SYNC_POLL_MS = 100;
// How far in the past a remote /nc/epoch may sit and still be believable as
// the same clock we are reading. A room that started earlier today is minutes
// old; a value further back than this is another timebase, not an older room.
const EPOCH_PLAUSIBLE_PAST_S = 24 * 60 * 60;
// Ceiling on the per-participant ghost-replay retention window. Cycle length
// tracks the network and has no upper bound, but the window costs
// ~192 kB/s/participant at 48 kHz Float32 — past this a ghost loops what it has.
const MAX_RETAIN_MS = 10000;
// Ceiling on banked-but-unplayed scheduler slots. The scheduler only emits a
// lookahead ahead of real time, so this is slack for a stalled playback loop,
// not a working size.
const MAX_PENDING_SLOTS = 256;
// How far ahead of now a banked slot may sit before it is treated as belonging
// to an abandoned grid rather than the current one — whichever is larger.
const SLOT_HORIZON_CYCLES = 3;
const SLOT_HORIZON_MIN_S = 30;
// Rate limit for the empty-turn diagnostic: often enough to characterise a
// persistent silence within seconds, rare enough not to flood a quiet room.
const EMPTY_TURN_LOG_MS = 3000;
// Re-announce the current nc-active turn at least this often even when it hasn't
// changed, so a late joiner (or a sidecar whose per-room cache was cleared by a
// session reset) learns it without waiting for the ring to rotate.
const NC_ACTIVE_HEARTBEAT_MS = 2000;
// Sample rate the page-side taps run at (the shared AudioContext defaults to
// 48 kHz on Chrome). Used only to convert a cfg.holdMs hold window into a
// per-participant RingBuffer capacity in samples.
const DEFAULT_SAMPLE_RATE = 48000;
// Master output ceiling for gain staging: the peak amplitude the assembled mix
// is allowed to reach before it is scaled down. 1.0 is full scale for the
// float32 (and any fixed bit-depth) sample stream — beyond it the stream clips.
const DEFAULT_GAIN_CEILING = 1.0;
// How long to wait for the sidecar to answer an aggregator-claim before giving
// up and joining anyway: a claim we can't obtain must not strand the (possibly
// only) aggregator forever if the bus is briefly unreachable at startup.
const CLAIM_TIMEOUT_MS = 5000;
// Election-gate hysteresis window. Once the bot HAS been the active aggregator,
// a transient "not active" reading (a bot-join storm can momentarily drop it
// from the page-side election roster) is held for this long before it actually
// stands down — otherwise a one-tick flap silences the whole room's audio.
const DEFAULT_ACTIVE_GRACE_MS = 10000;
// Shared metaprogram O2 addresses — same wire contract as
// src/audio-net/Metaprogrammer.js so the bot and every browser client agree
// on one cycle grid and one program text.
const EPOCH_ADDR = '/nc/epoch';
const APPLY_ADDR = '/nc/apply';
// How long to wait for the O2 relay handshake before running unsynced — a
// hung connection must not stall start() (same fail-open spirit as
// CLAIM_TIMEOUT_MS).
const O2_CONNECT_TIMEOUT_MS = 5000;

// Participant tokens in the order they are WRITTEN in the $ participants
// sequence (depth-first; every branch of a | choice included). This is the
// metaprogram's participant ordering irrespective of timing mode — <>
// alternation plays them across consecutive cycles, [] subdivision within one
// cycle, both in this written order — so it is what the ring adopts.
function metaprogramTokenSequence(participants) {
  const out = [];
  const walk = (elements) => {
    for (const el of elements || []) {
      if (!el) continue;
      if (el.type === 'participant' && el.token != null) out.push(String(el.token));
      else if (el.type === 'choice') (el.options || []).forEach(walk);
      else if (el.type === 'sequence') (el.stacks || []).forEach((st) => walk(st.elements));
      else if (el.type === 'run') walk(el.elements);
    }
  };
  if (participants && Array.isArray(participants.stacks)) {
    for (const st of participants.stacks) walk(st.elements);
  }
  return out;
}

// Empty master slice. #pendingMaster is ALWAYS a Float32Array (empty means
// nothing pending), never null, so playMasterBufferToClient can test
// `!samples.length` without a null guard. Length 0 and never mutated, so a
// single shared instance is safe to reuse as the "nothing pending" sentinel.
const EMPTY_MASTER = new Float32Array(0);


// err.code set on the throw from start() when another aggregator already holds
// the room's slot. The entrypoint treats this as a clean "nothing to do" exit
// (code 0), NOT a crash to replace — a losing aggregator is expected to leave.
export const AGGREGATOR_SLOT_TAKEN = 'AGGREGATOR_SLOT_TAKEN';

/**
 * AggregatorBot — one headless bot that gathers every participant's audio into
 * per-participant ring buffers, will schedule/mix them under the metaprogram,
 * and streams a single consolidated master mix back to the room.
 *
 * Data flow (audio implemented first):
 *   clients (bots + humans)
 *     -> individual buffer queues   (one RingBuffer per participant)
 *     -> metaprogram-dictated processing
 *     -> one tick's assembled master slice (the #pendingMaster handoff)
 *     -> back out to the client
 *
 * The per-participant dimension is a fixed-capacity RingBuffer with oldest-
 * sample eviction:
 *   - this.buffers[token]  each participant's own concatenated audio, keyed by
 *                          Net Cycles room index: 0 for the first human, 0a/0b/…
 *                          for that human's bots, 1 for the next human, and so on
 * The master is NOT a second ring buffer: readAndAssembleMasterBuffer writes one
 * playback tick's rate-matched slice into #pendingMaster, and
 * playMasterBufferToClient drains and clears it within the same tick — nothing
 * is buffered across ticks, so a RingBuffer there only added latency.
 *
 * Key differences from Bot: joins and unmutes immediately, boots no Strudel
 * (it makes no sound of its own — its published track carries the assembled
 * mix), and taps the room instead of playing into it.
 */
export class AggregatorBot extends Bot {

    // Single-slot handoff from readAndAssembleMasterBuffer to
    // playMasterBufferToClient — one tick's assembled master, cleared on read.
    // Deliberately NOT a jitter buffer: the redundant shared RingBuffer that used
    // to sit between them (written then fully drained every tick, buffering
    // nothing across ticks) is gone.
    #pendingMaster = EMPTY_MASTER;
    // Monotonic total of master samples streamed to the room (folded into the
    // shared dimension of the metrics/buffer table in place of the removed shared
    // RingBuffer's `written`). Only ever grows, so it doubles as a liveness signal
    // that the aggregator is actually producing output.
    #masterWritten = 0;
    // Which token is currently streaming (the queue owns the turn timing).
    #activeToken = null;
    // Last active token+ring-index broadcast over nc-active, and when, so we emit
    // on change OR on the NC_ACTIVE_HEARTBEAT_MS heartbeat rather than every audio
    // tick. The index distinguishes repeated tokens (`<0 1 0>` — same token, two
    // ring slots) so the browser outlines the occurrence actually playing.
    // `undefined` (not null) so the first real value — including null — is sent.
    // `kind` distinguishes the two token-less states that must NOT dedup against
    // each other: 'rest' (the program is resting at a named `~`) and null (no
    // turn at all).
    #lastBroadcastActive = undefined;
    #lastBroadcastIndex = undefined;
    #lastBroadcastKind = undefined;
    #lastBroadcastActiveAt = 0;
    // Per token: a rolling copy of the audio a participant most recently STREAMED,
    // accumulated a slice at a time as each live turn plays and capped at one full
    // turn/cycle (this.slotSamples, which tracks cycle length) — see
    // #retainScheduled. This is what a
    // departed ghost replays: the live RingBuffer only holds ~holdMs (<1s) and is
    // drained by the participant's own turns, so it can't be the replay source;
    // this retained window is, and holding a whole cycle lets the ghost's turn play
    // a full cycle of distinct audio instead of looping a sub-second fragment.
    // Frozen once the participant becomes a ghost (no more live turns refresh it)
    // and dropped when it is revived or the metaprogram retires the token.
    #lastScheduledBuffer = new Map();
    // Per departed-ghost token: how far into #lastScheduledBuffer the replay has
    // streamed, so its turns loop that frozen audio rather than falling silent.
    // Reset at the start of each of the ghost's turns.
    #ghostReplayOffset = new Map();
    // Election-gate hysteresis state (see #isActiveNow): whether we have ever won
    // the active slot, and when we were last active. Held so a transient miss
    // can't silence the room mid-stream.
    #everActive = false;
    #lastActiveAt = 0;
    // Playback-loop interval handle and the setInterval/clearInterval wrappers
    // (see the constructor for why the wrappers exist), kept private. The ingest-
    // loop handle (this.ingestTimer) is public instead — a test reads it to assert
    // the loop is scheduled/cleared, so it is not truly private.
    #playbackTimer = null;
    #setInterval = null;
    #clearInterval = null;
    // The aggregator-claim probe connection to the sidecar, held open for our
    // lifetime so nothing else can claim the room's single aggregator slot.
    #claimConn = null;
    // Second, persistent sidecar connection dedicated to metaprogram sync
    // (crdt-state/crdt-update). Separate from #claimConn: the claim probe
    // never sends `hello` so it never joins the room's broadcast set (see
    // #metaprogramBusUrl for why this one does, with role=fleet).
    #metaprogramConn = null;
    // Throttle counter for the capture-diag heartbeat (every ~10th drain).
    #drainTicks = 0;
    // Anchor for schedulerClockSeconds, latched on first read so the bot's scheduler
    // clock counts from its own start rather than the Unix epoch.
    #localT0 = null;
    // Room roster as seen over the metaprogram bus (peerId → publicView
    // record), the worst-case metrics derived from it, the applied program's
    // four audio-effect chain entries, and the last params pushed to the page
    // for each (as JSON, so unchanged params don't re-evaluate every
    // peer-update — or, for the patterned ones, every cycle and every pattern
    // tick). The page starts with a bare master bus, so 'null' — not
    // undefined — is the honest starting point: a program without a given
    // directive never pushes it at all.
    #peers = new Map();
    // The metaprogram's slot grid, banked from the scheduler's slot-open/
    // slot-close events with their NETWORK timestamps (the scheduler emits a
    // lookahead early, so these wait here until their window arrives) and read
    // by #serveFromScheduler. Empty until the first slot-open, which is what
    // schedulerPacing latches — before that the join-order write pointer
    // still paces the rotation.
    #slotTimeline = [];
    // Public (like this.ingestTimer, and for the same reason): which of the two
    // pacing sources is in force is what a test must assert to know it exercised
    // the grid rather than the fallback, so it is not honestly private.
    schedulerPacing = false;
    #lastSlotId = null;
    #turnCounter = 0;
    #servedTurnAt = new Map();   // "stack:index" -> #turnCounter when last served
    #pacingStalled = false;      // latched so the fall-back warning prints once per stall
    #lastEmptyTurnLogAt = 0;     // rate limit for the empty-turn diagnostic
    #worstCase = { wcl: 0, wcj: 0, wcrtt: 0, wcpl: 0 };
    #roomChain = null;
    #lastRoomPushJson = 'null';
    #noiseChain = null;
    #lastNoisePushJson = 'null';
    #crushChain = null;
    #lastCrushPushJson = 'null';
    #echoChain = null;
    #lastEchoPushJson = 'null';
    // Cycle number the scheduler last opened. noise's `<…>` arguments are
    // sampled by whole cycle, so this alone is what it needs, and it is also
    // what room falls back to before the first boundary has been scheduled.
    #cycle = 0;
    // The last cycle-start the scheduler EMITTED, for the effects that sample
    // at a fractional position rather than a whole cycle: crush and echo take
    // `[…]` subdivisions too, and echo's delay is written in cycles so it
    // needs the length. Mirrors the browser's cycleGrid
    // (src/audio-net/Metaprogrammer.js), including reading position off the
    // emitted event rather than scheduler.getCycle() — the scheduler
    // increments past the cycle it just announced, so getCycle() names the
    // next one and every client would sample an element apart.
    #cycleGrid = null;           // { cycle, t, seconds }
    // Armed only while the applied chain holds a patterned argument: a
    // sub-cycle step falls between the metrics updates and the cycle
    // boundaries, so it needs a clock of its own (see PATTERN_TICK_MS).
    #patternTimer = null;

    constructor(cfg, { launcher, reporter, logIngest = true, now, isActive, connectSidecar, webSocketImpl } = {}, buffers = {}, bufferSize = 1024) {
        super(cfg, { launcher });
        // Individual dimension: token -> RingBuffer. Pre-seedable for tests.
        this.buffers = buffers;
        this.metaprogramDoc = null;
        this.o2 = null;
        // Per-participant hold buffers are MEASURED IN MS (requirement 4): a
        // participant retains cfg.holdMs of audio while it waits for its turn.
        // When cfg.holdMs is set we derive the RingBuffer capacity from it and
        // the sample rate; otherwise the explicit bufferSize (samples) is used
        // directly so unit tests can pin an exact capacity.
        this.sampleRate = Math.max(1, Number(cfg.sampleRate ?? DEFAULT_SAMPLE_RATE));
        this.holdMs = cfg.holdMs != null ? Math.max(1, Number(cfg.holdMs)) : null;
        this.bufferSize = this.holdMs != null
            ? Math.max(1, Math.round(this.holdMs * this.sampleRate / 1000))
            : Math.max(1, Math.floor(bufferSize));
        this.epoch = null;
        // Turn length for the pre-metaprogram round-robin, and an injectable
        // clock so the alternation is testable without real time.
        this.slotMs = Math.max(1, Number(cfg.slotMs ?? DEFAULT_SLOT_MS));
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.programText = null;
        // Rate-match the master drain to real time. Each playback tick releases
        // at most ONE playback interval's worth of the active participant's audio
        // (playbackMs * sampleRate) instead of its whole backlog: draining
        // everything dumped a full hold-window burst at every slot flip, so the
        // page player queue (the only real-time-paced stage) fell further behind
        // real time each slot without bound. When the loop is disabled (interval
        // 0, as in unit tests) fall back to the default cadence so the cap is a
        // large sane number rather than 0.
        const playbackMs = Number(cfg.playbackIntervalMs) > 0
            ? Number(cfg.playbackIntervalMs) : DEFAULT_PLAYBACK_INTERVAL_MS;
        this.masterSliceSamples = Math.max(1, Math.round(playbackMs * this.sampleRate / 1000));
        // How much of a participant's most-recently-STREAMED audio to retain for a
        // ghost replay: one full turn (slotMs — the ~4s "cycle" a turn lasts), so a
        // departed ghost's turn replays a whole cycle of distinct audio rather than
        // looping a sub-second fragment. The retained window rolls as the live turn
        // streams (accumulated a masterSliceSamples slice at a time) and is capped
        // here; the ghost loops back to the start only if less than this was ever
        // captured (see #retainScheduled / #replayDepartedGhost).
        // The circular priority queue: the fixed join-order ring, the assign-once
        // jitsiId -> room-index-token mapping, and the write/turn pointer. Shares
        // this bot's clock and slot length so serve() rotates in lockstep with the
        // assembly loop. The per-participant PCM stays in this.buffers; the queue
        // only decides the order and whose turn it is.
        this.order = new CircularParticipantQueue({ now: this.now, slotMs: this.slotMs });
        // Master gain-staging ceiling (requirement 6): the assembled mix is scaled
        // down so its peak never exceeds this, keeping it inside the stream's
        // representable range instead of clipping.
        this.gainCeiling = Math.max(0, Number(cfg.gainCeiling ?? DEFAULT_GAIN_CEILING)) || DEFAULT_GAIN_CEILING;
        // Election gate: only the room's single ACTIVE aggregator ingests and
        // streams. A second aggregator that joins stands down here (publishing
        // nothing), so the two masters never tap and feed back into each other.
        // Defaults to polling the page, which reads the Trussal bundle's election
        // (window.__trussalIsActiveAggregator); tests inject a predicate.
        this.isActive = typeof isActive === 'function' ? isActive : () => this.#queryActiveFromPage();
        // Election-gate hysteresis (see #isActiveNow): once we HAVE won the slot,
        // hold it through a transient stand-down rather than silencing the room
        // on a one-tick miss. A bot that has never been active still stands down
        // immediately (a genuine second aggregator must not stream). Only a miss
        // sustained past activeGraceMs actually yields the slot.
        this.activeGraceMs = Math.max(0, Number(cfg.activeGraceMs ?? DEFAULT_ACTIVE_GRACE_MS));
        // Pre-join gate: how the bot claims the room's single aggregator slot
        // from the sidecar BEFORE launching its browser. A `(url, {onOpen,
        // onMessage}) => { send, close }` connector (production injects the
        // ws-backed one; tests inject a fake). Absent -> the claim is skipped
        // (standalone / unit tests that drive the bot directly).
        this.connectSidecar = typeof connectSidecar === 'function' ? connectSidecar : null;
        // WebSocket constructor for O2LiteClient's own transport (distinct from
        // connectSidecar, which wraps the peer-state protocol, not O2's).
        // Production passes the `ws` package's WebSocket; absent -> metaprogram
        // sync is skipped (tests/standalone), matching connectSidecar's pattern.
        this.webSocketImpl = webSocketImpl || null;
        // Where a metrics sample goes. Defaults to the console so a bare
        // instance "publishes its own metrics"; tests inject a capturing sink.
        this.reporter = reporter || ((tag, data) => console.log(tag, data));
        // Print incoming audio + ring buffers whenever data reaches the bot.
        // On by default (deployed bots log to their container stdout); tests
        // silence it to keep node:test output readable.
        this.logIngest = logIngest;
        // Wrap the timer globals rather than storing bare references: in a
        // browser setInterval is a Window method that throws when invoked as
        // this.#setInterval(...) with the instance as receiver (the exact bug
        // that crashed ClockSync). Node doesn't care, but this keeps the bot
        // safe if it is ever driven page-side.
        this.clock = null;
        this.#setInterval = (typeof setInterval !== 'undefined') ? (fn, ms) => setInterval(fn, ms) : null;
        this.#clearInterval = (typeof clearInterval !== 'undefined') ? (id) => clearInterval(id) : null;
        this.ingestTimer = null;
        this.#playbackTimer = null;
        this.scheduler = null;
    }

    async start() {
        // Pull config, launch the browser, join the Jitsi room, unmute, and
        // publish an initial metrics sample. Mirrors Bot.start() but omits the
        // Strudel boot and adds the participant-audio tap.
        const { botId, name, jitsiUrl, executablePath, bandwidth = {}, ownerIndex } = this.cfg;

        // Claim the room's single aggregator slot BEFORE touching the browser.
        // If another aggregator already holds it, throw so the container exits
        // without ever joining Jitsi — a losing aggregator must never be in the
        // meeting, because two of them mutually mute (see the sidecar's
        // 'aggregator-claim' handler and electAggregator).
        await this.#claimAggregatorSlot();

        this.browser = await this.launcher.launch(browserLaunchOptions(executablePath));
        this.page = await this.browser.newPage();
        await this.page.setUserAgent(spoofedUserAgent(botId));

        // Installed before navigation (Jitsi enumerates devices / renders peers
        // on load). Order matches Bot: mark-as-bot first, then the audio bridge
        // (its shared AudioContext is what the capture tap reuses). No
        // preserve-drawing-buffer shim — the aggregator creates no WebGL canvas.
        await this.page.evaluateOnNewDocument(pageMarkBot, typeof ownerIndex === 'string' ? ownerIndex : '');
        // Announce as the room's aggregator so every other client silences all
        // non-aggregator peers, leaving this bot's assembled master the only
        // audio source they hear.
        await this.page.evaluateOnNewDocument(pageMarkAggregator);
        await this.page.evaluateOnNewDocument(pageAudioBridge);
        await this.page.evaluateOnNewDocument(pageGumOverride, bandwidth.captureFps ?? 15);
        // The ingest tap: accumulates every remote <audio> element's PCM.
        await this.page.evaluateOnNewDocument(pageAggregatorCapture);
        // The return-path sink: streams the assembled master mix back out through
        // the bot's published track. Installed before navigation like the tap.
        await this.page.evaluateOnNewDocument(pageMasterPlayer);
        await this.page.evaluateOnNewDocument(pageFpsSampler);

        // Audio-first: join with video muted so Jitsi never requests a camera
        // (the gUM override would otherwise wait forever for a Hydra canvas the
        // aggregator never creates, hanging the join).
        await this.page.goto(jitsiRoomUrl(jitsiUrl, name, { ...bandwidth, videoMuted: true }), {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });
        if (this.page.waitForFunction) {
            await this.page
                .waitForFunction(() => globalThis.APP !== undefined, { timeout: 30000 })
                .catch(() => {});
        }

        // Publish an unmuted audio track immediately so the aggregator holds a
        // live track to carry the assembled master mix (wired up in
        // readAndAssembleMasterBuffer). No video track — see videoMuted above.
        await this.page.evaluate(pageEnsureAudioPublished).catch((e) => {
            console.error(`[aggregator-bot] failed to ensure audio is published: ${e.message}`);
        });

        await this.publishMetrics();
        this.startIngestLoop();
        this.startPlaybackLoop();
        // Join the room's shared metaprogram AFTER the audio loops are live so
        // the round trip never waits on the O2/CRDT handshakes (worst case
        // O2_CONNECT_TIMEOUT_MS + the 500ms epoch grace).
        await this.interpretAndExecuteMetaprogram();
    }

    /**
     * Drive the ingest on a cadence: every tick drains the page tap into the
     * per-participant buffers (which logs incoming audio + buffers when data
     * arrives). Interval from cfg.ingestIntervalMs; <= 0 disables the loop
     * (tests call ingestTick() directly).
     */
    startIngestLoop() {
        const ms = Number(this.cfg.ingestIntervalMs ?? DEFAULT_INGEST_INTERVAL_MS);
        if (!(ms > 0) || !this.#setInterval || this.ingestTimer) return;
        this.ingestTimer = this.#setInterval(() => { this.ingestTick(); }, ms);
        // Don't keep the process alive just for the ingest loop.
        if (this.ingestTimer && this.ingestTimer.unref) this.ingestTimer.unref();
    }

    async ingestTick() {
        // Stand down unless we're the room's active aggregator (see #isActiveNow):
        // a second aggregator neither taps nor streams, so no feedback loop forms.
        if (!(await this.#isActiveNow())) return;
        // Compact departed participants out of the rotation BEFORE ingesting new
        // audio, so a slot freed this tick can't briefly reappear as an empty turn.
        await this.#removeDepartedParticipants();
        // #drainPageCaptures already swallows page errors; nothing to write when
        // the room is silent.
        await this.writeToIndividualParticipantBufferQueues();
    }

    /**
     * Remove every participant the page tap has seen leave the Jitsi conference
     * since the last tick, closing the gap their slot would otherwise leave in
     * the rotation (see removeParticipant / CircularParticipantQueue.remove). The
     * page tap is the source of truth for "left" — it diffs successive
     * room.getParticipants() scans, since this deployment has no reliable
     * member-left event to listen for directly.
     */
    async #removeDepartedParticipants() {
        const departed = await this.#drainPageLeaves();
        for (const jitsiId of departed) this.removeParticipant(jitsiId);
    }

    /**
     * Drive the return path on a cadence: every tick assembles the master mix
     * from the individual buffers and streams it back out to the room. Interval
     * from cfg.playbackIntervalMs; <= 0 disables the loop (tests call
     * readAndAssembleMasterBuffer()/playMasterBufferToClient() directly).
     */
    startPlaybackLoop() {
        const ms = Number(this.cfg.playbackIntervalMs ?? DEFAULT_PLAYBACK_INTERVAL_MS);
        if (!(ms > 0) || !this.#setInterval || this.#playbackTimer) return;
        this.#playbackTimer = this.#setInterval(() => { this.playbackTick(); }, ms);
        // Don't keep the process alive just for the playback loop.
        if (this.#playbackTimer && this.#playbackTimer.unref) this.#playbackTimer.unref();
    }

    async playbackTick() {
        // Only the active aggregator assembles and streams the master; a stood-
        // down aggregator publishes silence, so it can't feed back into the
        // active one's mix (which taps every participant, including this bot).
        if (!(await this.#isActiveNow())) return;
        await this.readAndAssembleMasterBuffer();
        await this.playMasterBufferToClient();
    }

    /**
     * The election gate WITH hysteresis. Reads the raw predicate (this.isActive,
     * which fail-actives on its own errors so it never throws) and folds in the
     * "stay active through a transient miss once we've been active" rule, so a
     * bot-join storm can't permanently silence the room by flapping the page-side
     * election for a tick or two. A bot that has never won the slot stands down
     * immediately (a genuine second aggregator must not stream); an active read
     * pins #everActive and refreshes the last-active stamp.
     */
    async #isActiveNow() {
        const activeStatus = await this.isActive();
        const now = this.now();
        if (activeStatus && !this.#everActive) this.#everActive = true;
        if (activeStatus) this.#lastActiveAt = now;
        const lastActiveNow = this.#lastActiveAt - now === 0;              // active this very tick
        const beforeActiveGraceMs = (now - this.#lastActiveAt) < this.activeGraceMs;
        // Holding the slot on a false read (ever-active, still inside the grace
        // window) means the active status is momentarily UNKNOWN — surface it.
        if (this.#everActive && !lastActiveNow && beforeActiveGraceMs) {
            await this.#reportStudioStatus('aggregator active status unknown');
        }
        // Active right now, OR ever-active and still within the grace window. The
        // literal `beforeActiveGraceMs && lastActiveNow` would only ever be true
        // while active this tick — i.e. the non-hysteretic raw gate — so the hold
        // is expressed with the OR against the grace window instead.
        return lastActiveNow || (this.#everActive && beforeActiveGraceMs);
    }

    /**
     * Surface a short status line in the Trussal studio overlay (the page's
     * `.ts-agg-status` child of `.ts-detail`) from the Node side. Only ever
     * reached from #isActiveNow's hysteresis hold — a fallback path — and a
     * no-op until the overlay has mounted, so it stays best-effort.
     */
    async #reportStudioStatus(text) {
        if (!this.page || typeof this.page.evaluate !== 'function') return;
        await this.page.evaluate(pageReportStudioStatus, String(text));
    }

    /**
     * Wire up the room's shared metaprogram on the Node side (called from
     * start() once the audio loops are live): O2 (epoch agreement + clock
     * sync), the CRDT program-text doc, and the pure MetaprogramScheduler —
     * mirroring src/audio-net/Metaprogrammer.js's setNetCyclesActive()/
     * startScheduler() (browser side), NOT importing it, since that module is
     * a per-BROWSER-TAB singleton wired to window/document and the page's own
     * peer-state connection; the aggregator is its own process and needs its
     * own CRDT doc replica (createMetaprogramDoc) that converges via update
     * exchange, not a shared object reference.
     *
     * Idempotent, and deliberately does the heavy construction ONCE: after
     * this returns, a metaprogram edit arrives via crdt.onRemoteChange or the
     * /nc/apply O2 method and flows through applyProgramText →
     * #pushProgramToScheduler, which updates the EXISTING scheduler in place
     * (scheduler.setProgram) and hands the ring its new order/membership
     * (this.order.applyMetaprogramOrder) rather than rebuilding anything. The
     * one case that legitimately rebuilds the scheduler is
     * adoptEpochIfEarlier, because the epoch defines the cycle grid every
     * client must share — an ordinary text edit does not touch it.
     */
    async interpretAndExecuteMetaprogram() {
        if (this.o2) return; // already wired — updates flow in reactively from here

        if (!this.webSocketImpl) {
            console.warn('[aggregator-bot] metaprogram sync skipped: no WebSocket implementation wired');
            return;
        }
        const o2Url = this.#o2Url();
        if (!o2Url) {
            console.warn('[aggregator-bot] metaprogram sync skipped: no O2 URL derivable from the Jitsi URL');
            return;
        }
        // Kept in a local so the post-await guards can tell whether stop()
        // tore the subsystem down while we were suspended.
        const o2 = new O2LiteClient({ url: o2Url, WebSocketImpl: this.webSocketImpl });
        this.o2 = o2;
        o2.method(EPOCH_ADDR, (msg) => this.adoptEpochIfEarlier(msg.args[0]));
        o2.method(APPLY_ADDR, (msg) => this.applyProgramText(msg.args[0]));
        this.clock = makeClockSyncOverO2(o2, () => this.schedulerClockSeconds());
        try {
            await this.#withTimeout(o2.connect(), O2_CONNECT_TIMEOUT_MS, 'O2 connect');
        } catch (e) {
            console.warn(`[aggregator-bot] O2 connect failed (running unsynced): ${e.message}`);
        }
        if (this.o2 !== o2) return; // stop() ran while connect was in flight
        this.clock.start();

        const bus = this.#connectMetaprogramBus();
        if (bus) {
            const handle = createMetaprogramDoc();
            this.metaprogramDoc = connectMetaprogramSync(handle, bus);
            // Fires for both live crdt-update diffs and the crdt-state
            // late-joiner catch-up, so the room's existing program (if any)
            // lands here shortly after the hello. Keystroke diffs (modality
            // 'keyboard'/'head-cursor'/…) sync the shared TEXT only; the ring
            // and scheduler adopt a program solely on an explicit apply, the
            // roster seed, or the catch-up — half-typed programs never run.
            this.metaprogramDoc.onRemoteChange((text, payload) => {
                const applied = !!payload && (payload.catchUp === true ||
                    payload.modality === 'apply' || payload.modality === 'roster');
                if (!applied) return;
                this.programText = text;
                // apply/roster/catch-up are all genuine re-applies: end any
                // departed ghost's grace period (Case 2/3).
                this.#pushProgramToScheduler({ programUpdate: true });
            });
            // Shared induced-metric floors move the effective worst case the
            // same way a measured change does.
            this.metaprogramDoc.onModulationChange(() => this.#refreshWorstCase());
        }

        // Wait for ClockSync to converge before declaring an epoch, and give
        // /nc/epoch a beat to arrive — an already-running room's epoch should
        // win a race against a freshly-joined aggregator's guess.
        //
        // Waiting for the sync is the point: an epoch declared on the unsynced
        // local clock and then used against the synced one names an instant on
        // a DIFFERENT TIMELINE. One burst is ~700 ms (5 sends at 100 ms plus a
        // 200 ms commit), so the old flat 500 ms grace essentially guaranteed
        // an unsynced epoch. If the clock never syncs we proceed on the local
        // one — a self-consistent local grid is fine; what is not fine is
        // mixing the two, which adoptEpochIfEarlier now also refuses.
        await this.#awaitClockSync(CLOCK_SYNC_WAIT_MS);
        if (this.o2 !== o2) return; // stop() ran during the grace window
        if (this.epoch == null) {
            this.epoch = Math.ceil(this.networkSeconds());
            console.log(`[aggregator-bot] epoch ${this.epoch} declared on the ` +
                `${this.clock.isSynced() ? 'synced network' : 'local (UNSYNCED)'} clock`);
        }
        // Net Cycles is always on: if no shared program reached us during the
        // grace (empty room, or nothing in the CRDT catch-up), start under the
        // default — participant 0 streams continuously — instead of the
        // join-order rotation. The browser leader seeds the same default into
        // the shared doc, so a late catch-up converges on identical text.
        if (this.programText == null) this.applyProgramText(buildDefaultProgram());
        this.#startScheduler();
    }

    /**
     * Resolve once ClockSync has committed a burst, or after `ms`. Polls
     * rather than taking a callback because ClockSync exposes no ready event
     * and the poll is a handful of cheap checks over one startup window.
     */
    async #awaitClockSync(ms) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (this.clock && this.clock.isSynced()) return true;
            await new Promise((r) => setTimeout(r, CLOCK_SYNC_POLL_MS));
        }
        if (!(this.clock && this.clock.isSynced())) {
            console.warn(`[aggregator-bot] ClockSync did not converge in ${ms}ms — ` +
                `running the cycle grid on this bot's local clock`);
        }
        return !!(this.clock && this.clock.isSynced());
    }

    /**
     * Network time on the same clock the scheduler stamps its events with, so
     * everything comparing against a scheduled instant compares like with
     * like. ClockSync's reference once converged; this bot's own monotonic
     * clock (see schedulerClockSeconds) until then.
     */
    networkSeconds() {
        return this.clock && this.clock.isSynced()
            ? this.clock.toNetworkTime(this.schedulerClockSeconds())
            : this.schedulerClockSeconds();
    }

    // Bound an await on external I/O so a hung handshake can't stall start().
    // Rejection or timeout is the caller's to interpret; the timer is cleared
    // either way so it never holds the process open.
    #withTimeout(promise, ms, what) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    /**
     * Adopt new program text (an /nc/apply broadcast, or a direct call in
     * tests): parse, keep only if valid, then push into the scheduler and the
     * ring. Returns the parse errors (empty array = adopted), like the
     * browser's applyProgramText.
     */
    applyProgramText(text) {
        const { errors, valid } = parseMetaprogram(text);
        if (!valid) return errors;
        this.programText = text;
        // A genuine re-apply: ends any departed ghost's grace period (Case 2/3).
        this.#pushProgramToScheduler({ programUpdate: true });
        return errors;
    }

    /**
     * Parse this.programText and push it into the EXISTING scheduler instance
     * AND into the ring. The scheduler swaps programs at its next cycle
     * boundary; the ring re-orders immediately — the two re-align at that
     * boundary via #onSchedulerEvent's cycle-start. CRDT text can be
     * transiently invalid mid-keystroke; invalid text leaves both untouched
     * (last valid program stays in force), matching the scheduler's own
     * keep-last-valid behavior.
     *
     * `programUpdate` marks a genuine re-apply (an ▶ Apply / Ctrl+Enter, the
     * roster seed, or a catch-up) as opposed to the routine cycle-boundary
     * re-adoption that #onSchedulerEvent drives. It flows to the ring so a
     * departed ghost's grace period ends only on a real re-apply, not on every
     * cycle (see CircularParticipantQueue.applyMetaprogramOrder).
     */
    #pushProgramToScheduler({ programUpdate = false } = {}) {
        if (this.programText == null) return;
        const { ast, valid } = parseMetaprogram(this.programText);
        if (!valid) return;
        if (this.scheduler) this.scheduler.setProgram(ast);
        this.#applyOrderFromProgram(ast, { programUpdate });
        // Every `#` audio effect targets THIS bot's master bus (the mix every
        // client hears); adopt/drop them with the program.
        const chain = ast.chain || [];
        this.#roomChain = chain.find((c) => c.fn === 'room') || null;
        this.#noiseChain = chain.find((c) => c.fn === 'noise') || null;
        this.#crushChain = chain.find((c) => c.fn === 'crush') || null;
        this.#echoChain = chain.find((c) => c.fn === 'echo') || null;
        this.#syncMasterEffects();
        this.#syncPatternLoop(chain);
    }

    /** Push all four master-bus effects. */
    #syncMasterEffects() {
        this.#syncMasterRoom();
        this.#syncMasterNoise();
        this.#syncMasterCrush();
        this.#syncMasterEcho();
    }

    /**
     * Where the room is on its cycle grid, for the effects written in cycles
     * (`# echo`'s delay length) or sampled at a fractional position (`[…]`
     * arguments). Position is deliberately UNCLAMPED arithmetic off the last
     * boundary: cycle-start events are emitted a lookahead early, so between
     * the event and the boundary the fraction is negative and the position
     * correctly still names the previous cycle — evaluateValuePattern
     * floor-mods, so that resolves to the last element rather than off the
     * end. Before the first boundary there is no anchor, so fall back to the
     * length the scheduler is about to use at position 0. Identical to the
     * browser's cycleContext(), which is what keeps a patterned parameter the
     * same value on the mix and in every client's visual.
     */
    #cycleContext() {
        if (this.#cycleGrid && this.#cycleGrid.seconds > 0) {
            return {
                cycleSeconds: this.#cycleGrid.seconds,
                cyclePos: this.#cycleGrid.cycle +
                    (this.networkSeconds() - this.#cycleGrid.t) / this.#cycleGrid.seconds,
            };
        }
        const len = this.scheduler ? this.scheduler.getCycleLength() : null;
        return { cycleSeconds: len && len.seconds > 0 ? len.seconds : 1, cyclePos: 0 };
    }

    /**
     * Whether the applied program has the pattern tick armed. Public for the
     * same reason schedulerPacing is: which clock is re-deriving the effects
     * is what a test must assert to know it exercised the sub-cycle path
     * rather than the cycle-boundary one.
     */
    patternTicking() { return this.#patternTimer != null; }

    /**
     * A patterned argument moves with the CYCLE, not with the metrics, so
     * neither the metrics hook nor the cycle-boundary hook covers a `[…]`
     * subdivision — it needs its own tick. Whether any argument follows the
     * grid is a property of the PROGRAM, so it is settled here, when a
     * program is adopted, rather than re-resolved every tick; a chain of
     * constants keeps re-deriving on metrics updates alone and this stays
     * disarmed.
     */
    #syncPatternLoop(chain) {
        const wanted = chainHasValuePattern(chain) && !!this.#setInterval;
        if (wanted && !this.#patternTimer) {
            this.#patternTimer = this.#setInterval(() => this.#syncMasterEffects(), PATTERN_TICK_MS);
            // Don't keep the process alive just to re-read a pattern.
            if (this.#patternTimer.unref) this.#patternTimer.unref();
        } else if (!wanted && this.#patternTimer) {
            if (this.#clearInterval) this.#clearInterval(this.#patternTimer);
            this.#patternTimer = null;
        }
    }

    /**
     * Worst-case metrics over the roster the metaprogram bus reports, with
     * the CRDT-shared induced floors layered on — the same computation every
     * browser's effectiveWorstCase() runs, so cycle lengths and room-reverb
     * decay agree everywhere. Recomputed on every roster/metrics/modulation
     * change; the scheduler adopts new metrics at its next cycle boundary.
     */
    #refreshWorstCase() {
        const measured = computeWorstCaseMetrics([...this.#peers.values()]);
        this.#worstCase = this.metaprogramDoc
            ? mergeInducedMetrics(measured, this.metaprogramDoc.getInduced())
            : measured;
        if (this.scheduler) this.scheduler.setMetrics(this.#worstCase);
        this.#syncMasterEffects();
    }

    /**
     * Where the room sits on its cycle grid, in fractional cycles — what every
     * patterned effect argument is sampled at. Read off the scheduler, which
     * derives it from the boundaries it actually emitted rather than from the
     * current cycle length, so a metrics change does not renumber the past and
     * jump every pattern. Falls back to the last cycle-start's NUMBER before
     * the first boundary has been scheduled (and when there is no scheduler at
     * all), which is exactly the resolution noise has always run at.
     */
    #cyclePosition() {
        const pos = this.scheduler ? this.scheduler.getCyclePosition() : null;
        return Number.isFinite(pos) ? pos : this.#cycle;
    }

    /**
     * Push the applied program's `# room` parameters (or null to clear) into
     * the page's master player, which hosts the actual WebAudio Schroeder
     * graph on the proc → published-track path. Deduplicated by JSON so the
     * per-peer-update recompute only crosses into the page when a value
     * actually moved. Best-effort per push — a failed evaluate (page mid-
     * navigation/teardown) is logged and the dedup reset so the next change
     * retries rather than wedging on a stale "already pushed" state.
     */
    #syncMasterRoom() {
        if (!this.page) return;
        const params = this.#roomChain
            ? roomParams(this.#worstCase, resolveEffectParams(this.#roomChain), this.#cyclePosition())
            : null;
        const json = JSON.stringify(params ?? null);
        if (json === this.#lastRoomPushJson) return;
        this.#lastRoomPushJson = json;
        Promise.resolve(this.page.evaluate(pageSetMasterRoom, params)).catch((e) => {
            // Leave the cache mismatched so the next change retries rather
            // than believing a push that never landed.
            this.#lastRoomPushJson = 'stale';
            console.error('[aggregator-bot] master room push failed', e);
        });
    }

    /**
     * The same for the applied program's `# noise` bed. Unlike room this is
     * also called at every cycle boundary, because noise arguments may be
     * `<…>` patterns that resolve per cycle — the JSON dedup is what keeps
     * that from crossing into the page on cycles where nothing moved.
     */
    #syncMasterNoise() {
        if (!this.page) return;
        const params = this.#noiseChain
            ? noiseParams(this.#worstCase, resolveEffectParams(this.#noiseChain, { cycle: this.#cycle }))
            : null;
        const json = JSON.stringify(params ?? null);
        if (json === this.#lastNoisePushJson) return;
        this.#lastNoisePushJson = json;
        Promise.resolve(this.page.evaluate(pageSetMasterNoise, params)).catch((e) => {
            this.#lastNoisePushJson = 'stale';
            console.error('[aggregator-bot] master noise push failed', e);
        });
    }

    /**
     * The same for `# crush`. Unlike room it is re-derived at every cycle
     * boundary AND on the pattern tick, because any of its three arguments
     * may be a `<…>`/`[…]` pattern; the JSON dedup is what keeps a tick where
     * nothing moved from crossing into the page 20 times a second.
     */
    #syncMasterCrush() {
        if (!this.page) return;
        const params = this.#crushChain
            ? crushParams(this.#worstCase, resolveEffectParams(this.#crushChain),
                this.#cycleContext().cyclePos)
            : null;
        const json = JSON.stringify(params ?? null);
        if (json === this.#lastCrushPushJson) return;
        this.#lastCrushPushJson = json;
        Promise.resolve(this.page.evaluate(pageSetMasterCrush, params)).catch((e) => {
            this.#lastCrushPushJson = 'stale';
            console.error('[aggregator-bot] master crush push failed', e);
        });
    }

    /**
     * The same for `# echo`, which additionally needs the cycle LENGTH: its
     * delay is written in cycles, so it re-times itself whenever the metrics
     * move the grid — a change no argument of its own reflects.
     */
    #syncMasterEcho() {
        if (!this.page) return;
        const params = this.#echoChain
            ? echoParams(this.#worstCase, resolveEffectParams(this.#echoChain), this.#cycleContext())
            : null;
        const json = JSON.stringify(params ?? null);
        if (json === this.#lastEchoPushJson) return;
        this.#lastEchoPushJson = json;
        Promise.resolve(this.page.evaluate(pageSetMasterEcho, params)).catch((e) => {
            this.#lastEchoPushJson = 'stale';
            console.error('[aggregator-bot] master echo push failed', e);
        });
    }

    /**
     * The $ participants written order becomes the ring's rotation order and
     * MEMBERSHIP: unlisted participants wait silent off the ring, departed-
     * but-listed ghosts keep streaming their held audio (see
     * CircularParticipantQueue.applyMetaprogramOrder). Tokens the queue
     * retires lose their buffers and replay state here — a departed ghost the
     * program no longer lists (removed from the ring for good), and, on a
     * genuine re-apply (`programUpdate`), a departed ghost the program STILL
     * lists but that nobody rejoined (reset to a silent placeholder). Either
     * way the leaver's stale audio is dropped; the routine cycle-boundary
     * re-adoption (programUpdate=false) retires nothing, so the ghost keeps
     * replaying until the performer actually re-applies.
     */
    #applyOrderFromProgram(ast, { programUpdate = false } = {}) {
        if (!ast || !ast.participants) return;
        const retired = this.order.applyMetaprogramOrder(
            metaprogramTokenSequence(ast.participants), { programUpdate },
        );
        if (!retired.length) return;
        this.buffers = Object.fromEntries(
            Object.entries(this.buffers).filter(([token]) => !retired.includes(token)),
        );
        for (const token of retired) { this.#ghostReplayOffset.delete(token); this.#lastScheduledBuffer.delete(token); }
        console.log(`[aggregator-bot] metaprogram retired departed participant(s): ${retired.join(',')}`);
    }

    /**
     * Cross-client agreement: adopt the smaller of our epoch and one just
     * heard on /nc/epoch. Only this — not a program edit — rebuilds the
     * scheduler, because the epoch anchors the cycle grid every client's
     * scheduler must agree on. Non-finite input (a malformed message) is
     * ignored — NaN would poison every later comparison and silently freeze
     * the scheduler's tick loop.
     *
     * An epoch is only comparable when both sides quote the SAME clock, so a
     * remote value that could not plausibly be on our timeline is refused
     * rather than adopted. "Smaller" is otherwise indistinguishable from "on a
     * different clock", and adopting across timebases anchors the grid at an
     * instant our own clock will never reach: the scheduler then emits nothing
     * for ever and the room goes silent. We only adopt while synced, and only
     * within EPOCH_PLAUSIBLE_PAST_S of now — a genuine earlier epoch comes
     * from a room that started minutes ago, not aeons.
     */
    adoptEpochIfEarlier(remoteEpoch) {
        if (!Number.isFinite(remoteEpoch)) return;
        if (this.epoch != null && remoteEpoch >= this.epoch - 0.05) return;
        const now = this.networkSeconds();
        const synced = !!(this.clock && this.clock.isSynced());
        if (!synced || remoteEpoch > now || (now - remoteEpoch) > EPOCH_PLAUSIBLE_PAST_S) {
            console.warn(`[aggregator-bot] refused /nc/epoch ${remoteEpoch} — ` +
                `${synced ? `implausible against local now ${now.toFixed(1)}` : 'clock not synced yet'}`);
            return;
        }
        this.epoch = remoteEpoch;
        if (this.scheduler) {
            this.scheduler.stop();
            this.#startScheduler();
        }
    }

    #startScheduler() {
        // A fresh grid: drop any slots banked against the previous epoch, or
        // #serveFromScheduler would keep serving turns the old cycle grid
        // scheduled. The pattern anchor goes with them — it counts from cycle
        // 0 again, so the old one would sample in a cycle that no longer
        // exists.
        this.#resetSlotPacing();
        this.#cycleGrid = null;
        this.scheduler = new MetaprogramScheduler({
            now: () => this.networkSeconds(),
            onEvent: (ev) => this.#onSchedulerEvent(ev),
            label: 'netcycles/aggregator',
        });
        this.#pushProgramToScheduler();
        this.scheduler.setMetrics(this.#worstCase);
        this.scheduler.start(this.epoch);
    }

    /**
     * Scheduler events → the ring AND the rotation's pace.
     *
     * At every cycle boundary the ring re-adopts the program the scheduler is
     * actually playing (setProgram defers swaps to the boundary, so this is
     * where a mid-cycle edit really lands).
     *
     * slot-open/slot-close are banked into #slotTimeline, which
     * #serveFromScheduler reads to decide whose turn it is — so the metaprogram
     * dictates ORDER, MEMBERSHIP *and* TIMING. The scheduler emits a lookahead
     * ahead of real time, which is exactly why the events are banked with their
     * network timestamps rather than applied on arrival.
     */
    #onSchedulerEvent(ev) {
        if (ev.type === 'cycle-start') {
            if (this.scheduler) this.#applyOrderFromProgram(this.scheduler.getProgram());
            // Patterned noise arguments advance one element per cycle, so the
            // bed is re-derived here; a program with none pushes nothing.
            // Applied on ARRIVAL rather than banked against ev.t like the
            // slots are, so the new element lands up to the scheduler's
            // lookahead (0.2 s) before the cycle it belongs to. The bed is a
            // continuous drone against cycles of at least a second, so it
            // reads as a slightly early fade rather than a missed cue; a
            // percussive effect would need the timeline treatment instead.
            this.#cycle = ev.cycle;
            this.#cycleGrid = { cycle: ev.cycle, t: ev.t, seconds: ev.seconds };
            // crush and echo come along: a boundary is the only moment the
            // cycle LENGTH can change (the scheduler applies pending metrics
            // here, not when they arrived), and echo's delay is quoted in
            // cycles, so nothing else would re-time it — #refreshWorstCase ran
            // before the swap, with the old length.
            this.#syncMasterNoise();
            // room's patterns turn over on the boundary too. A sub-cycle one
            // also has the pattern tick, but a plain `<a b>` must not wait on
            // that tick being armed, and re-deriving here costs a JSON compare
            // when nothing moved.
            this.#syncMasterRoom();
            this.#syncMasterCrush();
            this.#syncMasterEcho();
            return;
        }
        if (!ev.id) return;
        if (ev.type === 'slot-open') {
            this.#slotTimeline.push({
                id: ev.id,
                // A rest slot has no participant: keep the token null rather
                // than stringifying it into the literal "null", which would
                // look like a token to everything downstream.
                token: ev.rest ? null : String(ev.token),
                rest: ev.rest === true,
                openT: ev.t,
                closeT: ev.t + ev.dur,
                cycle: ev.cycle,
                stack: ev.stack,
                index: ev.index ?? null,
            });
            this.schedulerPacing = true;
            // Bounded: a scheduler left running while nothing drains the
            // timeline (a stalled playback loop) must not grow without end.
            // Now that rests are banked too, a dense program fills this roughly
            // twice as fast, so reclaim the slots whose windows have CLOSED
            // before falling back to dropping the oldest — a blind shift at a
            // full timeline can evict the slot covering `now`, which reads to
            // #pruneToOpenSlots as "nothing open" and drops the rotation into
            // the join-order fallback mid-turn.
            if (this.#slotTimeline.length > MAX_PENDING_SLOTS) {
                this.#pruneToOpenSlots();
                if (this.#slotTimeline.length > MAX_PENDING_SLOTS) this.#slotTimeline.shift();
            }
        } else if (ev.type === 'slot-close') {
            // The close event is authoritative for the closing edge — trust it
            // over open.t + open.dur if they ever disagree.
            const slot = this.#slotTimeline.find((s) => s.id === ev.id);
            if (slot) slot.closeT = ev.t;
        }
    }

    /**
     * Drop banked slots whose window has closed and return those already open,
     * both relative to network time now. Kept as a plain filter rather than a
     * sorted scan: the timeline holds at most a scheduler lookahead's worth.
     */
    #pruneToOpenSlots() {
        const now = this.networkSeconds();
        // Drop slots whose window has closed AND slots stranded implausibly far
        // ahead. The latter matters because the scheduler's clock can move
        // (ClockSync converging, a sidecar restart resetting the relay's
        // hrtime): when it does, everything banked against the old grid sits in
        // an unreachable future. The scheduler re-anchors and emits a fresh
        // grid, but these leftovers would linger for ever — indistinguishable
        // from a rest, and liable to "open" spuriously much later.
        const horizon = now + this.#slotHorizonS();
        this.#slotTimeline = this.#slotTimeline.filter((slot) => slot.closeT > now && slot.openT <= horizon);
        return this.#slotTimeline.filter((slot) => slot.openT <= now);
    }

    /**
     * How far ahead a banked slot may legitimately sit. The scheduler only
     * emits a lookahead ahead of real time, so anything beyond a couple of
     * cycles came from a grid that no longer applies.
     */
    #slotHorizonS() {
        const cycle = this.scheduler ? this.scheduler.getCycleLength() : null;
        return Math.max(SLOT_HORIZON_MIN_S, (cycle ? cycle.seconds : this.slotMs / 1000) * SLOT_HORIZON_CYCLES);
    }

    /**
     * Forget the metaprogram's slot grid and fall back to the join-order write
     * pointer until a new one arrives. Used when the grid is rebuilt (a new
     * epoch) and on teardown — banked slots carry absolute network timestamps
     * from the grid that produced them, so they must never outlive it.
     */
    #resetSlotPacing() {
        this.#slotTimeline = [];
        this.schedulerPacing = false;
        this.#lastSlotId = null;
        this.#servedTurnAt.clear();
    }

    /**
     * Whose turn it is according to the metaprogram's slot grid — the
     * scheduler-paced counterpart of CircularParticipantQueue.serve(), and the
     * reason turn length now tracks the cycle length `# cycles` computes
     * instead of a fixed 4 s. Returns serve()'s shape so
     * readAndAssembleMasterBuffer treats both pacing sources identically.
     */
    #serveFromScheduler() {
        const silence = {
            token: null, position: null, slot: -1, newTurn: false, lapped: false,
            departed: false, resting: false, restIndex: null,
        };
        let open = this.#pruneToOpenSlots();
        if (!open.length) {
            // Nothing open right now. Distinguish two cases that look identical
            // from here but must not behave alike:
            //
            //   - slots are banked and upcoming -> the metaprogram schedules a
            //     REST at this instant. Silence is the correct output.
            //   - nothing usable is banked at all -> the grid has fallen behind
            //     (a late tick, a stalled loop, a clock jump). Pump the
            //     scheduler, which re-anchors if it has come adrift, and look
            //     again. tick() is idempotent.
            //
            // If that still yields nothing, PACING FAILS OPEN: hand back to the
            // join-order write pointer rather than reporting silence. Getting
            // this wrong is what silenced a live room — an unusable grid read
            // as an endless rest, and the room stayed quiet for ever. A
            // slightly wrong turn order is a far better failure than no audio.
            if (!this.#slotTimeline.length && this.scheduler) {
                this.scheduler.tick();
                open = this.#pruneToOpenSlots();
            }
            if (!open.length) {
                // A HEALTHY grid with no slot open is a rest — the program
                // genuinely schedules nothing here, and a rest longer than the
                // scheduler's lookahead legitimately leaves the timeline empty.
                // Emptiness alone therefore proves nothing; grid health does.
                if (this.scheduler && this.scheduler.isGridHealthy()) return silence;
                if (!this.#pacingStalled) {
                    this.#pacingStalled = true;
                    console.warn('[aggregator-bot] no usable metaprogram slot grid — ' +
                        'falling back to the join-order rotation so the room keeps streaming');
                }
                return this.order.serve();
            }
        }
        this.#pacingStalled = false;
        // A rest slot is open time with nobody in it. It decides the output only
        // when NO participant slot is open: with concurrent stacks (the `,`
        // operator) a rest in the lowest stack must not silence a participant
        // playing alongside it — before rests were emitted at all, that
        // participant is what played, and a highlight must not change what the
        // room hears.
        const playing = open.filter((slot) => !slot.rest);
        if (!playing.length) return { ...silence, ...this.#restingSlot(open) };
        // Concurrent stacks can overlap, but requirement 1 says the master
        // carries exactly one voice: lowest stack wins, earlier opening breaks
        // the tie. Deterministic, so every client resolving the same grid picks
        // the same participant.
        playing.sort((a, b) => a.stack - b.stack || a.openT - b.openT);
        const active = playing[0];

        const newTurn = active.id !== this.#lastSlotId;
        let lapped = false;
        if (newTurn) {
            this.#lastSlotId = active.id;
            this.#turnCounter++;
            // "The write pointer reached this position again": the same slot of
            // the program has come round after a full lap of the ring, so what
            // it held a lap ago is stale (requirement 4). Position identity is
            // the written index, since that is what repeats each lap.
            const key = `${active.stack}:${active.index}`;
            const previousTurn = this.#servedTurnAt.get(key);
            const ringSize = Math.max(1, this.order.size);
            if (previousTurn != null && this.#turnCounter - previousTurn >= ringSize) lapped = true;
            this.#servedTurnAt.set(key, this.#turnCounter);
        }
        return {
            token: active.token,
            position: active.index ?? this.order.positionOf(active.token),
            slot: this.#turnCounter,
            newTurn,
            lapped,
            departed: this.order.isDeparted(active.token),
            restIndex: null,
        };
    }

    /**
     * The room is RESTING: open slots exist but none of them has a participant
     * in it. Streams nothing, so no participant audio reaches the master for
     * the rest's span, and names which written rest is in force so the shared
     * editor can outline it.
     *
     * `resting` is the decision itself, NOT `restIndex != null`: a `0?` that
     * degraded to a rest this cycle is a real rest with no `~` in the source to
     * address, and reporting it as an idle room would lose exactly the silence
     * hardest to attribute.
     *
     * Nothing here touches the bot's own output path — the same "assemble
     * nothing" the pre-rest code reached by inference. That is what leaves the
     * page's master player running into the `# room` graph, so the master-bus
     * reverb tail rings on across the rest instead of being cut with the
     * participants. Scheduling the rest explicitly is what stops the pacing
     * fallback (see #serveFromScheduler) from filling the rest with a
     * join-order turn; the tail is the output path's own doing.
     *
     * Same tie-break as a played slot (lowest stack, earliest opening) so every
     * client resolving the same grid outlines the same `~`.
     */
    #restingSlot(open) {
        const resting = open.sort((a, b) => a.stack - b.stack || a.openT - b.openT)[0];
        return { resting: true, restIndex: resting ? resting.index : null };
    }

    // Local seconds for O2/ClockSync/the scheduler: MONOTONIC SINCE THIS BOT
    // STARTED, not Unix epoch seconds. this.now() (injectable, defaults to
    // Date.now()) is in MS — CircularParticipantQueue's unit, which only ever
    // takes differences — so this rescales it AND rebases it; it does NOT
    // introduce a second clock.
    //
    // The rebase matters because the O2 relay's reference clock is
    // process.hrtime since the SIDECAR started (see latency-instrument/
    // o2-relay.js) — a small number. Returning Date.now()/1000 (~1.79e9) here
    // made the pre-sync fallback ~1.79 BILLION seconds larger than the synced
    // network time, so the instant ClockSync converged the scheduler's clock
    // fell off a cliff and every already-scheduled cycle sat unreachably in
    // the future. Same scale in both states means convergence is a small
    // correction, not a cliff.
    schedulerClockSeconds() {
        if (this.#localT0 == null) this.#localT0 = this.now();
        return (this.now() - this.#localT0) / 1000;
    }

    /**
     * Second, persistent sidecar connection dedicated to metaprogram sync.
     * Sends `hello` with isFleet so the server (see server.js's `isFleet`
     * derivation) adds it to the room's broadcast set — which is required to
     * receive the crdt-state catch-up and any later crdt-update broadcasts —
     * WITHOUT assigning it a roomIndex or exposing it in any client's roster:
     * the aggregator's browser page already holds the room's one real
     * aggregator slot, so this connection must stay invisible as a
     * participant. Adapts the raw sidecar messages into the
     * { subscribe, sendUpdate } shape connectMetaprogramSync expects (see
     * peer-state.js's crdt-update/crdt-state handling for the wire contract
     * this mirrors).
     */
    #connectMetaprogramBus() {
        if (!this.connectSidecar) return null;
        const url = this.#metaprogramBusUrl();
        if (!url) return null;
        const listeners = new Set();
        const sidecar = this.connectSidecar(url, {
            onOpen: (send) => {
                // A (re)connect — including after a sidecar restart — drops the
                // sidecar's cached nc-active. Reset the dedup so the next tick
                // re-broadcasts the current turn and refills that cache.
                this.#lastBroadcastActive = undefined;
                this.#lastBroadcastIndex = undefined;
                this.#lastBroadcastKind = undefined;
                send({ type: 'hello', isFleet: true, displayName: `${this.cfg.name || 'aggregator'}-metaprogram-sync` });
            },
            onMessage: (msg) => {
                if (!msg || typeof msg.type !== 'string') return;
                if (msg.type === 'crdt-update' && msg.update) {
                    const payload = { update: msg.update, authorIndex: msg.authorIndex ?? null, modality: msg.modality };
                    listeners.forEach((fn) => fn('crdt-update', payload));
                } else if (msg.type === 'crdt-state' && Array.isArray(msg.updates)) {
                    listeners.forEach((fn) => fn('crdt-state', { updates: msg.updates }));
                } else if (msg.type === 'roster' && Array.isArray(msg.peers)) {
                    // The hello reply carries every peer's metrics; peer-update
                    // patches keep them live. This is the same broadcast stream
                    // browsers derive their worst-case metrics from, so the
                    // aggregator's scheduler and master-bus room reverb compute
                    // the identical values.
                    this.#peers.clear();
                    for (const p of msg.peers) if (p && p.peerId) this.#peers.set(p.peerId, p);
                    this.#refreshWorstCase();
                } else if (msg.type === 'peer-join' && msg.peer && msg.peer.peerId) {
                    this.#peers.set(msg.peer.peerId, msg.peer);
                    this.#refreshWorstCase();
                } else if (msg.type === 'peer-update' && msg.peerId) {
                    const rec = this.#peers.get(msg.peerId);
                    if (rec && msg.patch) {
                        Object.assign(rec, msg.patch);
                        this.#refreshWorstCase();
                    }
                } else if (msg.type === 'peer-leave' && msg.peerId) {
                    if (this.#peers.delete(msg.peerId)) this.#refreshWorstCase();
                }
            },
        });
        this.#metaprogramConn = sidecar;
        return {
            subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
            sendUpdate: (update, { snapshot = false, modality = 'keyboard', channel = 'metaprogram' } = {}) => {
                sidecar.send({ type: 'crdt-update', update, snapshot, modality, channel });
            },
        };
    }

    /**
     * Publish the ring's current turn to the room so browsers can outline it in
     * the shared metaprogram editor: the streaming participant's token, or —
     * with `kind: 'rest'` and no token — the written `~` the program is resting
     * at, so a rest is shown as the deliberate part of the cycle it is. Sent over
     * the metaprogram sidecar connection (already in the room's broadcast set)
     * ONLY when the token changes — one small message per slot flip, not per
     * audio tick, which is why readAndAssembleMasterBuffer can call it every
     * tick. Best-effort: a dropped highlight update is purely cosmetic.
     */
    #broadcastActiveToken(token, index, kind = null) {
        const t = token == null ? null : String(token);
        const i = Number.isInteger(index) ? index : null;
        const k = kind === 'rest' ? 'rest' : null;
        const now = Date.now();
        if (t === this.#lastBroadcastActive && i === this.#lastBroadcastIndex &&
            k === this.#lastBroadcastKind &&
            (now - this.#lastBroadcastActiveAt) < NC_ACTIVE_HEARTBEAT_MS) return;
        this.#lastBroadcastActive = t;
        this.#lastBroadcastIndex = i;
        this.#lastBroadcastKind = k;
        this.#lastBroadcastActiveAt = now;
        const conn = this.#metaprogramConn;
        if (!conn || typeof conn.send !== 'function') return;
        try { conn.send({ type: 'nc-active', token: t, index: i, kind: k }); } catch (e) { /* cosmetic */ }
    }

    async writeToIndividualParticipantBufferQueues(captures) {
        // Ingest every participant's captured PCM into that participant's own
        // ring buffer, evicting the oldest samples when the buffer is full (the
        // ring overwrites, so a participant whose buffer is never drained can't
        // grow without bound or wedge the writer).
        //
        // `captures` is [{ jitsiId?, token, samples }] where token is the
        // participant's room index (0, 0a, 1, …) and jitsiId (when the page tap
        // supplies it) is the media-stream source; when omitted, drain the latest
        // frames the page-side tap accumulated from the remote <audio> elements.
        //
        // Turn-taking ("wait until it is this participant's turn") is deliberately
        // NOT applied here: the individual buffers are each participant's own
        // continuous audio, so gating writes would drop material. The metaprogram
        // slot decides whose audio is copied into the SHARED buffer — that gate
        // lives in readAndAssembleMasterBuffer, the next hop.
        const takes = captures ?? await this.#drainPageCaptures();
        // "Reached the aggregator" = a participant actually delivered samples.
        // Sort co-arriving participants into room-index order so that any first
        // seen together enter the join-order ring deterministically (the sidecar
        // hands out indices in join order, so this IS join order).
        const arrived = (takes || [])
            .filter((t) => t && t.token != null && t.samples && t.samples.length)
            .sort((a, b) => tokenOrder(a.token, b.token));
        const summary = {};
        for (const take of arrived) {
            // Only accept valid normalized PCM: reject a capture whose samples are
            // out of range or the wrong type rather than writing NaN / a clipping
            // value into the participant buffer (and thence the master). Logged and
            // skipped, NOT thrown — one corrupt frame must not wedge ingest or drop
            // the valid captures batched alongside it. The participant is not
            // registered either, so garbage never claims a ring slot.
            if (!this.isValidSampleBuffer(take.samples)) {
                console.error(
                    `[aggregator-bot] rejected invalid samples for token=${take.token}: ` +
                    `expected finite floats in [-1.0, 1.0]`,
                );
                continue;
            }
            // Pin jitsiId -> token ONCE and route by the pinned token, so a
            // participant's audio always lands in the same buffer/slot for the
            // whole meeting even if its token were re-announced (requirement 2).
            // Bots participate exactly like humans here — their audio (only) is
            // captured from the room and streamed through this aggregator
            // (requirement 5) under their cluster token (0a, 0b, …).
            const identity = take.jitsiId != null ? String(take.jitsiId) : String(take.token);
            const token = this.order.register(identity, String(take.token));
            // Fresh audio proves this participant is still here: reverse a
            // spurious ghosting (an ICE-slow roster blip or a play-state flicker
            // marked it departed while it was really present) so it resumes LIVE
            // instead of looping its last-scheduled audio forever. A genuine
            // leave sends no more audio, so it is never revived.
            if (this.order.revive(identity)) {
                this.#ghostReplayOffset.delete(token);
                this.#lastScheduledBuffer.delete(token);
            }
            const samples = take.samples;
            const rb = this.participantBuffer(token);
            const evictedBefore = rb.evicted;
            rb.write(samples);
            summary[token] = {
                wrote: samples.length,
                length: rb.length,
                evicted: rb.evicted - evictedBefore,
            };
        }
        // Only print once audio has reached the bot — silent while the room is
        // empty or before anyone unmutes.
        if (this.logIngest && arrived.length) {
            this.logIncomingAudio(arrived);
            this.logBuffersAndStats();
        }
        return summary;
    }

    async readAndAssembleMasterBuffer() {
        // Cyclic turn-taking: one participant is active at a time and only that
        // participant's audio is concatenated into the shared master. ORDER,
        // MEMBERSHIP and TIMING all follow the room's metaprogram (see
        // interpretAndExecuteMetaprogram / #applyOrderFromProgram: unlisted
        // participants wait silent, departed-but-listed ghosts keep streaming
        // their held audio), which is always in force in production —
        // `$ participants <0>` with `# cycles wcl 2000` by default.
        //
        // Pace comes from the scheduler's slot-open/slot-close grid
        // (#serveFromScheduler), so a turn lasts exactly the cycle length the
        // program's `# cycles` directive derives from the live worst-case
        // metrics: a degrading room stretches its turns, a recovering one
        // tightens them. The queue's fixed-slotMs write pointer remains the
        // fallback for when no metaprogram grid exists yet — before the first
        // slot-open, and in unit/standalone runs with no metaprogram sync.
        //
        // The inactive participants' individual buffers keep filling (and evicting
        // their oldest, ms-bounded) in the meantime; when a participant's turn
        // comes round we stream whatever it has accumulated. Draining ONLY the
        // active buffer is what enforces requirement 1: at any instant the master
        // carries exactly one voice and every other participant streams nothing.

        // Make sure every participant that has a buffer is in the ring. Real
        // captures register through writeTo…; tests (and any direct seeding) put
        // RingBuffers straight into this.buffers, so fold those in here in
        // room-index order (assign-once, so this is a no-op once registered).
        this.#syncOrderFromBuffers();

        // `resting` is absent from the join-order fallback's shape (it knows
        // nothing of the program), which is honest: without a grid there are no
        // rests to be in.
        const { token: active, lapped, departed, newTurn, position, restIndex, resting = false } =
            this.schedulerPacing ? this.#serveFromScheduler() : this.order.serve();
        if (!active) {
            // No audio has reached the bot yet, or the metaprogram schedules a
            // REST right now: assemble nothing, so no participant reaches the
            // master for this span. The page player emits silence — while its
            // graph, and so the `# room` reverb tail, keeps running — and we
            // check again on the next tick.
            //
            // A rest says so, and names the `~` it is resting at when the
            // program wrote one, so the editor outlines that occurrence; a
            // merely idle room sends neither and clears the outline as before.
            this.#activeToken = null;
            this.#broadcastActiveToken(null, restIndex, resting ? 'rest' : null);
            return { active: null, assembled: 0, resting };
        }
        this.#activeToken = active;
        this.#broadcastActiveToken(active, position, null);
        // this.buffers[token] is a RingBuffer (mono Float32 PCM) or undefined when
        // the active token has no buffer yet — hence the guard below.
        const currentRingBuffer = this.buffers[active];
        // Release at most ONE playback interval's worth of the active buffer per
        // tick (masterSliceSamples), rate-matching the drain to real time: draining
        // the whole buffer dumped a full hold-window burst at every slot flip, so
        // the real-time-paced page player fell further behind each slot.
        //
        // A live participant's buffer is DRAINED (read): releasing this turn's
        // audio and, relative to the previous turn, evicting what was released a
        // lap ago — the two events requirement 4 pairs at a slot: released on its
        // turn, gone by the time the write pointer reaches this slot again.
        // `lapped` marks that return-to-position. Each live tick's released slice
        // is also accumulated into #lastScheduledBuffer (#retainScheduled, capped
        // at one full turn/cycle), so a later departure has up to a whole cycle of
        // the participant's most recent audio to replay — not just the sub-second
        // snapshot the RingBuffer could hold at any instant.
        //
        // A departed ghost (metaprogram still lists the token) gets no fresh audio
        // and its live buffer was already drained to empty by its final turn, so
        // it instead REPLAYS #lastScheduledBuffer — its retained last cycle —
        // playing it straight through each turn (looping back only if less than a
        // full cycle was captured) until the program drops the token (retires it).
        let held;
        let heldFrom;
        if (departed) {
            held = this.#replayDepartedGhost(active, newTurn);
            heldFrom = 'ghost-replay';
        } else if (!currentRingBuffer) {
            held = new Float32Array(0);
            heldFrom = 'no-buffer';
        } else {
            this.#ghostReplayOffset.delete(active);
            held = currentRingBuffer.read(Math.min(currentRingBuffer.length, this.masterSliceSamples));
            this.#retainScheduled(active, held);
            heldFrom = 'live-drain';
        }
        // A turn that streams NOTHING while the room is unmuted is the shape of
        // every silence bug this thing has had, and "samples=0" alone never says
        // which branch produced it. Name the branch and its inputs, rate-limited
        // so a legitimately silent stretch cannot flood the log.
        if (!held.length) this.#logEmptyTurn(active, heldFrom, currentRingBuffer, departed, newTurn);
        // Gain-stage the master before it is streamed (requirement 6).
        const { gain, samples } = this.computeGainStaging(held);
        // Single-slot handoff to playMasterBufferToClient (drained + cleared there
        // within this same playback tick). Always a Float32Array (computeGainStaging
        // returns one even for an empty slice), so #pendingMaster is never null and
        // the drain there can test `!samples.length` without a null guard.
        this.#pendingMaster = samples;
        console.log(
            `[aggregator-bot] assembled master from token=${active} samples=${samples.length} ` +
            `gain=${gain.toFixed(3)}${lapped ? ' (pointer lapped)' : ''}`,
        );
        return { active, assembled: samples.length, gain, lapped };
    }

    /**
     * Register any token that has a per-participant buffer but is not yet in the
     * ring, in room-index order. Real captures enter the ring via writeTo…
     * (keyed by media-stream id); this covers buffers seeded directly (tests /
     * future direct injection) so the rotation still sees them. Assign-once, so
     * repeated calls after everyone is registered do no work.
     */
    #syncOrderFromBuffers() {
        for (const token of Object.keys(this.buffers).sort(tokenOrder)) {
            // knowsToken (not hasToken): skip a token the queue already tracks
            // OFF the ring too. A real participant whose token the metaprogram
            // doesn't list yet has a buffer here but no ring slot; re-registering
            // it as register(token, token) would park a pseudo-id off-ring pin
            // that later shadows its real media-stream id when the program lists
            // the token — stranding the live source off-ring so its leave never
            // ghosts. Only a genuinely unknown buffer (direct test seeding) is
            // folded into the ring.
            if (!this.order.knowsToken(token)) this.order.register(token, token);
        }
    }

    /**
     * Explain an empty turn once every EMPTY_TURN_LOG_MS: which branch produced
     * it and the state that decided the branch. Rate-limited rather than
     * silenced entirely, because the interesting case is the one that persists.
     */
    #logEmptyTurn(token, from, ringBuffer, departed, newTurn) {
        const now = this.now();
        if (now - this.#lastEmptyTurnLogAt < EMPTY_TURN_LOG_MS) return;
        this.#lastEmptyTurnLogAt = now;
        const retained = this.#lastScheduledBuffer.get(token);
        console.warn(
            `[aggregator-bot] EMPTY TURN token=${token} via=${from} departed=${departed} ` +
            `newTurn=${newTurn} bufferLen=${ringBuffer ? ringBuffer.length : 'NO-BUFFER'} ` +
            `retainedLen=${retained ? retained.length : 0} ghostOffset=${this.#ghostReplayOffset.get(token) ?? 0} ` +
            `slice=${this.masterSliceSamples} bufferTokens=[${Object.keys(this.buffers)}] ring=[${this.order.order()}]`,
        );
    }

    /**
     * How much of a participant's most-recently-STREAMED audio to retain for a
     * ghost replay: ONE FULL TURN, so a departed ghost's turn replays a whole
     * cycle of distinct audio rather than looping a sub-second fragment.
     *
     * Derived, not stored, because the turn length is no longer fixed: the
     * scheduler paces the rotation, so a turn lasts the program's current cycle
     * length, which moves with the network. A stored slotMs-derived constant
     * would under-retain on a degraded room (ghosts looping mid-turn) and
     * over-retain on a fast one. Falls back to slotMs when no scheduler is
     * running, matching the fallback pacing.
     *
     * Bounded by MAX_RETAIN_MS: cycle length has no upper limit, and at 48 kHz
     * a Float32 window costs ~192 kB/s PER PARTICIPANT. Past the cap a ghost
     * loops its retained window, which is the documented short-capture
     * behaviour anyway (see #replayDepartedGhost).
     */
    get slotSamples() {
        const cycle = this.scheduler ? this.scheduler.getCycleLength() : null;
        const turnMs = cycle ? cycle.seconds * 1000 : this.slotMs;
        return Math.max(1, Math.round(Math.min(turnMs, MAX_RETAIN_MS) * this.sampleRate / 1000));
    }

    /**
     * Append this live tick's just-streamed slice to the token's rolling
     * last-cycle window (#lastScheduledBuffer), keeping only the most recent
     * this.slotSamples — one full turn/cycle. Across a live turn the per-tick
     * slices accumulate into a whole cycle of the participant's actual streamed
     * audio, so a later departure replays a full cycle of distinct material
     * rather than the sub-second fragment a single RingBuffer snapshot held.
     * Empty slices (a silent or starved tick) are ignored so they neither grow
     * nor roll material out of the window.
     */
    #retainScheduled(token, slice) {
        if (!slice || !slice.length) return;
        const prev = this.#lastScheduledBuffer.get(token);
        let next;
        if (!prev || !prev.length) {
            next = slice;
        } else {
            next = new Float32Array(prev.length + slice.length);
            next.set(prev, 0);
            next.set(slice, prev.length);
        }
        // Cap at one cycle, keeping the MOST RECENT samples (drop from the front).
        if (next.length > this.slotSamples) next = next.slice(next.length - this.slotSamples);
        this.#lastScheduledBuffer.set(token, next);
    }

    /**
     * One playback tick's slice of a departed ghost's retained last cycle, played
     * straight through so its turn carries that material instead of a silent gap.
     * The source is #lastScheduledBuffer — up to a full turn/cycle of the audio
     * the participant most recently streamed, accumulated by #retainScheduled
     * while it was live (the live RingBuffer holds <1s and was drained by its own
     * turns, so it can't be the source). A ghost that left before streaming any
     * has no retained window; fall back to whatever is still buffered, freezing
     * that once so later turns replay the same thing. The offset restarts at the
     * top of each of the ghost's turns (newTurn) and advances by the slice within
     * the turn; #loopSlice wraps only when the turn outruns the retained audio, so
     * a full cycle plays once end-to-end and a shorter capture loops. All of it is
     * dropped only when the metaprogram retires the token (see
     * #applyOrderFromProgram), so a listed ghost never plays silence.
     */
    #replayDepartedGhost(token, newTurn) {
        let source = this.#lastScheduledBuffer.get(token);
        if (!source || !source.length) {
            const ringBuffer = this.buffers[token];
            source = ringBuffer ? ringBuffer.peek() : new Float32Array(0);
            if (source.length) this.#lastScheduledBuffer.set(token, source); // freeze it
        }
        if (!source.length) return new Float32Array(0);
        const offset = newTurn ? 0 : (this.#ghostReplayOffset.get(token) || 0);
        const slice = this.#loopSlice(source, offset, this.masterSliceSamples);
        this.#ghostReplayOffset.set(token, offset + slice.length);
        return slice;
    }

    /**
     * Up to `n` samples of `buffer` starting at `offset`, WRAPPING back to the
     * start when the end is reached — a looped read of a fixed array. Used to
     * stream a departed ghost's frozen last-scheduled audio round and round.
     */
    #loopSlice(buffer, offset, n) {
        const len = buffer.length;
        if (!len || n <= 0) return new Float32Array(0);
        const count = Math.min(n, len);
        const start = (((offset % len) + len) % len);
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = buffer[(start + i) % len];
        return out;
    }

    async playMasterBufferToClient() {
        // Drain the single-slot pending master (assembled this tick by
        // readAndAssembleMasterBuffer) and hand it to the page-side player, which
        // streams it out through the bot's published track to every other client.
        // Cleared on read so a slot is never re-streamed; an empty/absent slot
        // enqueues nothing — the player emits silence and we check again next tick.
        const samples = this.#pendingMaster;
        this.#pendingMaster = EMPTY_MASTER;
        if (!samples.length) return { played: 0 };
        this.#masterWritten += samples.length;
        await this.#enqueueMasterSamples(samples);
        console.log(`[aggregator-bot] played master samples=${samples.length}`);
        return { played: samples.length };
    }
    
    async checkHealthAndSync() {
        // check the health of the bot and sync with the client
        // implement and test audio streaming first
    }

    async stop () {
        // Stop streaming, drop buffered audio, release the aggregator claim, and
        // close the page + browser. Releasing the claim (closing the probe) lets
        // a replacement aggregator take the slot.
        if (this.#claimConn) {
            try { this.#claimConn.close(); }
            catch (e) { console.error(`[aggregator-bot] failed to close aggregator claim connection: ${e.message}`); }
            this.#claimConn = null;
        }
        if (this.#metaprogramConn) {
            try { this.#metaprogramConn.close(); }
            catch (e) { console.error(`[aggregator-bot] failed to close metaprogram bus connection: ${e.message}`); }
            this.#metaprogramConn = null;
        }
        // Each teardown is guarded like the closes above: a throw from one must
        // not skip the rest (leaking the audio-loop timers and, worse, the
        // browser super.stop() closes).
        try { if (this.scheduler) this.scheduler.stop(); }
        catch (e) { console.error(`[aggregator-bot] failed to stop metaprogram scheduler: ${e.message}`); }
        this.scheduler = null;
        try { if (this.clock) this.clock.stop(); }
        catch (e) { console.error(`[aggregator-bot] failed to stop clock sync: ${e.message}`); }
        this.clock = null;
        try { if (this.o2) this.o2.close(); }
        catch (e) { console.error(`[aggregator-bot] failed to close O2 client: ${e.message}`); }
        this.o2 = null;
        try { if (this.metaprogramDoc) this.metaprogramDoc.disconnect(); }
        catch (e) { console.error(`[aggregator-bot] failed to disconnect metaprogram doc: ${e.message}`); }
        this.metaprogramDoc = null;
        // A re-armed subsystem must negotiate a FRESH epoch: restarting on the
        // stale one would make the scheduler fast-forward through every cycle
        // boundary since it (matches the browser's epoch = null on teardown).
        this.epoch = null;
        if (this.ingestTimer && this.#clearInterval) this.#clearInterval(this.ingestTimer);
        this.ingestTimer = null;
        if (this.#playbackTimer && this.#clearInterval) this.#clearInterval(this.#playbackTimer);
        this.#playbackTimer = null;
        if (this.#patternTimer && this.#clearInterval) this.#clearInterval(this.#patternTimer);
        this.#patternTimer = null;
        // The next arming starts a fresh grid at cycle 0, so an anchor from
        // the old one would sample patterns in a cycle that no longer exists.
        this.#cycleGrid = null;
        // Every push cache records what THIS page was last given, and stop()
        // discards the page — so they have to go with it. Left standing, a
        // restart onto the same program would dedup its first push away and
        // leave the fresh master bus dry, bedless and unprocessed.
        this.#lastRoomPushJson = 'null';
        this.#lastNoisePushJson = 'null';
        this.#lastCrushPushJson = 'null';
        this.#lastEchoPushJson = 'null';
        this.#pendingMaster = EMPTY_MASTER;
        this.#resetSlotPacing();
        this.#ghostReplayOffset.clear();
        this.#lastScheduledBuffer.clear();
        for (const rb of Object.values(this.buffers)) rb.clear();
        await super.stop();
    }

    async processBuffers() {
        // apply metaprogram effects to each sample in the buffers as they are scheduled
    }

    computeBufferSizeFromCycleLength(cycleLength) {
        // compute the buffer size based on the cycle length in number of samples
        // implement and test audio streaming first
    }

    computeGainStaging(input) {
        // Gain staging (requirement 6): keep the assembled master inside the
        // stream's representable range. Find the peak amplitude; if it exceeds
        // the ceiling (full scale for the audio's bit depth — beyond it the
        // stream clips), scale every sample down by ceiling/peak so the loudest
        // sample sits exactly at the ceiling. A master already within range is
        // passed through untouched (gain 1). Returns { gain, samples }.
        const src = input || [];
        const n = src.length;
        if (!n) return { gain: 1, samples: src.length ? src : new Float32Array(0) };
        let peak = 0;
        for (let i = 0; i < n; i++) {
            const a = src[i] < 0 ? -src[i] : src[i];
            if (a > peak) peak = a;
        }
        if (peak <= this.gainCeiling || peak === 0) {
            return { gain: 1, samples: src };
        }
        const gain = this.gainCeiling / peak;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = src[i] * gain;
        return { gain, samples: out };
    }

    /**
     * Whether a capture is valid normalized PCM: an array (or typed array) whose
     * every sample is a finite number in [-1.0, 1.0] inclusive. Number.isFinite is
     * the type+finiteness gate — it never coerces, so "0.5", null, and true are
     * rejected rather than converted — and the Array/ArrayBuffer.isView guard makes
     * a non-array-like input return false instead of throwing.
     */
    isValidSampleBuffer(samples) {
        return Array.isArray(samples) || ArrayBuffer.isView(samples)
            ? samples.every(sample => Number.isFinite(sample) && sample >= -1.0 && sample <= 1.0)
            : false;
    }

    logIncomingAudio(takes) {
        // Print the raw audio that just reached the aggregator, one line per
        // participant: room-index token, sample count, peak/RMS level (so silence
        // vs. signal is obvious), and a short preview of the leading samples.
        for (const { token, samples } of takes) {
            const n = samples.length;
            let peak = 0, sumSq = 0;
            for (let i = 0; i < n; i++) {
                const v = samples[i];
                const a = v < 0 ? -v : v;
                if (a > peak) peak = a;
                sumSq += v * v;
            }
            const rms = n ? Math.sqrt(sumSq / n) : 0;
            const preview = Array.from(samples.slice(0, 8), (v) => Number(v.toFixed(4)));
            console.log(
                `[aggregator-bot] incoming audio token=${token} samples=${n} ` +
                `peak=${peak.toFixed(4)} rms=${rms.toFixed(4)} preview=`, preview,
            );
        }
    }

    logBuffersAndStats() {
        // Log both dimensions — the pending master (shared) plus every
        // participant's individual buffer — as an array of rows with the
        // debugging/perf columns. Both sources present the same RingBuffer.stats()
        // shape, so one row builder covers both.
        const timestamp = Date.now();
        const row = (token, stats) => ({
            timestamp,
            token,
            bufferSize: stats.bufferSize,
            bufferLength: stats.bufferLength,
            bufferBytes: stats.bufferBytes,
            bufferEvicted: stats.bufferEvicted,
            bufferMaxBuffers: stats.bufferMaxBuffers,
            bufferMaxBytes: stats.bufferMaxBytes,
        });
        const rows = [row('__shared__', this.#pendingMasterStats())];
        for (const [token, rb] of Object.entries(this.buffers)) rows.push(row(token, rb.stats()));
        if (typeof console.table === 'function') console.table(rows);
        else console.log('[aggregator-bot] buffers', rows);
        return rows;
    }

    // --- helpers -------------------------------------------------------------

    /** Existing or freshly-created individual ring buffer for a participant. */
    participantBuffer(token) {
        let rb = this.buffers[token];
        if (!rb) { rb = new RingBuffer(this.bufferSize); this.buffers[token] = rb; }
        return rb;
    }

    /**
     * A participant left (by the identity it was registered under — its jitsiId,
     * or its token when no jitsiId was seen). Mode-aware via
     * CircularParticipantQueue.depart:
     *   - join-order mode (or an off-ring pin): ring slot and per-participant
     *     buffer are dropped IMMEDIATELY, so the buffers collection and the
     *     ring compact with no empty gap and the departed participant never
     *     gets another silent turn. A rejoin re-registers as a fresh tail slot;
     *     the departed room index is not recycled.
     *   - metaprogram mode: the slot AND buffer are KEPT — the schedule still
     *     lists this token, so its turns REPLAY the last held audio buffer
     *     (readAndAssembleMasterBuffer loops it non-destructively rather than
     *     draining to silence) until the metaprogram is next re-applied, which
     *     ends the grace: dropping the token retires the slot and buffer, a
     *     re-apply that still lists it but saw no rejoin resets it to a silent
     *     placeholder and drops the buffer, and a rejoiner reclaiming the slot
     *     revives it to live (see #applyOrderFromProgram / revive).
     * Returns the token, or null if the identity was never registered.
     */
    removeParticipant(identity) {
        const { token, removed, reason, hadRingSlot } = this.order.depart(String(identity));
        if (token === null) return null;
        if (!removed) {
            console.log(
                `[aggregator-bot] participant left but the metaprogram still lists it, ghost kept: ` +
                `identity=${identity} token=${token} order=${this.order.order().join(',')}`,
            );
            return token;
        }
        // Rebuild buffers without the departed token (filter, not delete).
        this.buffers = Object.fromEntries(
            Object.entries(this.buffers).filter(([bufferToken]) => bufferToken !== token),
        );
        this.#ghostReplayOffset.delete(token);
        this.#lastScheduledBuffer.delete(token);
        if (this.#activeToken === token) this.#activeToken = null;
        // reason distinguishes a real ring compaction (join-order mode) from an
        // off-ring pin drop; hadRingSlot=true on an off-ring drop would flag the
        // stranded-source desync knowsToken() now prevents (see #syncOrderFromBuffers).
        console.log(
            `[aggregator-bot] participant left (${reason}), buffer dropped: identity=${identity} ` +
            `token=${token} hadRingSlot=${hadRingSlot} order=${this.order.order().join(',')}`,
        );
        return token;
    }

    /** Buffer stats for both dimensions, folded into the metrics sample. */
    bufferStats() {
        const participants = {};
        for (const [token, rb] of Object.entries(this.buffers)) participants[token] = rb.stats();
        return { shared: this.#pendingMasterStats(), participants };
    }

    /**
     * Stats for the single-slot pending master, shaped like RingBuffer.stats() so
     * it slots into the shared dimension of the metrics and the buffer table in
     * place of the removed shared RingBuffer. Capacity is the per-tick slice cap
     * (masterSliceSamples); the slot never evicts (it is written then drained
     * within one playback tick), and bufferWritten is the monotonic total of
     * master samples streamed to the room (#masterWritten).
     */
    #pendingMasterStats() {
        const bytesPerSample = Float32Array.BYTES_PER_ELEMENT;
        const length = this.#pendingMaster.length;
        const capacity = this.masterSliceSamples;
        return {
            bufferSize: capacity,
            bufferLength: length,
            bufferBytes: length * bytesPerSample,
            bufferEvicted: 0,
            bufferWritten: this.#masterWritten,
            bufferMaxBuffers: capacity,
            bufferMaxBytes: capacity * bytesPerSample,
        };
    }

    /** Base bot metrics plus this aggregator's buffer stats. */
    async sampleMetrics() {
        const base = await super.sampleMetrics();
        return { ...base, buffers: this.bufferStats() };
    }

    /** Sample and hand metrics to the reporter (console by default). */
    async publishMetrics() {
        const m = await this.sampleMetrics();
        this.reporter('[aggregator-bot] metrics', m);
        return m;
    }

    // Room name + ws/wss proto shared by every sidecar/O2 URL this bot derives,
    // parsed from the Jitsi room URL so each one targets the SAME room the
    // bundle registers under (the bundle keys the room on the last path
    // segment). Null if the URL can't be parsed.
    #roomAndProto() {
        try {
            const u = new URL(this.cfg.jitsiUrl);
            const room = u.pathname.split('/').filter(Boolean).pop();
            if (!room) return null;
            const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
            return { room, proto, host: u.host };
        } catch (e) {
            console.error(`[aggregator-bot] could not derive room/proto from ${this.cfg.jitsiUrl}: ${e.message}`);
            return null;
        }
    }

    // Sidecar URL for the aggregator claim (the pre-join probe — never sends
    // `hello`, so it never joins the room's broadcast set). Null if no
    // connector is wired or the URL can't be parsed.
    #sidecarClaimUrl() {
        if (!this.connectSidecar) return null;
        const parts = this.#roomAndProto();
        if (!parts) return null;
        return `${parts.proto}//${parts.host}/ws?room=${encodeURIComponent(parts.room)}&role=aggregator-probe`;
    }

    // Sidecar URL for the metaprogram sync bus (see #connectMetaprogramBus).
    // role=fleet joins the room's broadcast set (crdt-state/crdt-update)
    // without claiming a roomIndex or appearing in any roster.
    #metaprogramBusUrl() {
        if (!this.connectSidecar) return null;
        const parts = this.#roomAndProto();
        if (!parts) return null;
        return `${parts.proto}//${parts.host}/ws?room=${encodeURIComponent(parts.room)}&role=fleet`;
    }

    // O2 relay URL (latency-instrument/o2-relay.js, proxied at /o2) for epoch
    // agreement + clock sync. Independent of the peer-state sidecar/hello —
    // the O2 relay only keys on ?room=.
    #o2Url() {
        const parts = this.#roomAndProto();
        if (!parts) return null;
        return `${parts.proto}//${parts.host}/o2?room=${encodeURIComponent(parts.room)}`;
    }

    async #claimAggregatorSlot() {
        const url = this.#sidecarClaimUrl();
        if (!url) return; // no connector wired — nothing to gate on (tests/standalone)
        const granted = await this.#requestAggregatorClaim(url);
        if (!granted) {
            // Someone else holds the room's single aggregator slot. Release our
            // probe and refuse to join — the caller (start) propagates the throw
            // so the container exits instead of joining the meeting.
            if (this.#claimConn) {
                try { this.#claimConn.close(); }
                catch (e) { console.error(`[aggregator-bot] failed to close aggregator claim connection: ${e.message}`); }
                this.#claimConn = null;
            }
            const err = new Error(`[aggregator-bot] room already has an aggregator; refusing to join (${url})`);
            err.code = AGGREGATOR_SLOT_TAKEN;
            throw err;
        }
        // Granted: keep the probe connection open for our lifetime (closed in
        // stop()) so nothing else can claim the slot while we are the aggregator.
    }

    #requestAggregatorClaim(url) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (granted) => { if (!settled) { settled = true; resolve(granted); } };
            // Fail OPEN on timeout: if the bus doesn't answer, a lone aggregator
            // must still come up. The client-side election + stand-down remain as
            // a backstop if this lets a second one slip through.
            const timer = setTimeout(() => {
                console.warn(`[aggregator-bot] aggregator-claim timed out after ${CLAIM_TIMEOUT_MS}ms; proceeding`);
                finish(true);
            }, CLAIM_TIMEOUT_MS);
            this.#claimConn = this.connectSidecar(url, {
                onOpen: (send) => send({ type: 'aggregator-claim' }),
                onMessage: (msg) => {
                    if (msg && msg.type === 'aggregator-claim-result') {
                        clearTimeout(timer);
                        finish(!!msg.granted);
                    }
                },
            });
        });
    }

    async #queryActiveFromPage() {
        // Ask the page whether this aggregator won the election. No page (tests
        // that don't inject isActive drive the sub-methods directly) -> assume
        // active so the round trip still runs.
        if (!this.page || typeof this.page.evaluate !== 'function') return true;
        try {
            return !!(await this.page.evaluate(pageIsActiveAggregator));
        } catch (e) {
            // A torn-down page (late Jitsi navigation) can't answer. Assume active
            // so a lone aggregator keeps streaming through transient page churn;
            // the next tick re-checks once the election helper is reachable again.
            console.error(`[aggregator-bot] active-aggregator check failed: ${e.message}`);
            return true;
        }
    }

    async #drainPageCaptures() {
        if (!this.page || typeof this.page.evaluate !== 'function') return [];
        try {
            const takes = await this.page.evaluate(pageDrainParticipantAudio);
            console.log(`[aggregator-bot] drained ${takes.length} participant captures from the page`);
            // Capture-diag heartbeat: dump the tap's audio-element / store / resolver
            // state every ~10th drain — EMPTY OR NOT — so a multi-participant
            // subscription problem (only one remote stream reaching the tap) is
            // visible during an ACTIVE session, not just at startup. Localizes a
            // fault to a stage: no stream on the element (subscription/bundle) vs a
            // jitsiId in the store that never resolves to a token (resolver).
            // Best-effort telemetry — log a failure but never throw, so a diag
            // hiccup can't wedge ingest.
            this.#drainTicks += 1;
            if (this.#drainTicks % 10 === 1) {
                try {
                    const diag = await this.page.evaluate(pageAggregatorCaptureDiag);
                    console.log('[aggregator-bot] capture diag', JSON.stringify(diag));
                } catch (e) {
                    console.error(`[aggregator-bot] capture diag failed: ${e.message}`);
                }
                // Authoritative track→member map (redesign probe): shows whether each
                // remote audio stream can be tied to a member id that resolves to a
                // room index, so the tap can key on TRACK IDENTITY instead of the
                // broken element ids. Surfaces the throw from a corrupt member.
                try {
                    const trackMap = await this.page.evaluate(pageAggregatorTrackMapDiag);
                    console.log('[aggregator-bot] track-map diag', JSON.stringify(trackMap));
                } catch (e) {
                    console.error(`[aggregator-bot] track-map diag failed: ${e.message}`);
                }
            }
            return Array.isArray(takes) ? takes : [];
        } catch (e) {
            console.error(`[aggregator-bot] failed to drain participant captures: ${e.message}`);
            return [];
        }
    }

    async #drainPageLeaves() {
        if (!this.page || typeof this.page.evaluate !== 'function') return [];
        try {
            const left = await this.page.evaluate(pageDrainParticipantLeaves);
            return Array.isArray(left) ? left : [];
        } catch (e) {
            console.error(`[aggregator-bot] failed to drain participant leaves: ${e.message}`);
            return [];
        }
    }

    async #enqueueMasterSamples(samples) {
        if (!this.page || typeof this.page.evaluate !== 'function') return;
        try {
            // Puppeteer serializes evaluate() arguments structurally; a
            // Float32Array does not survive that, so hand the page a plain Array.
            await this.page.evaluate(pageEnqueueMaster, Array.from(samples));
        } catch (e) {
            console.error(`[aggregator-bot] failed to enqueue master samples: ${e.message}`);
            // A late Jitsi navigation tears down the context; the next tick
            // re-enqueues, so a dropped frame here is self-healing.
        }
    }
}