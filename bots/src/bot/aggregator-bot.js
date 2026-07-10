import { Bot } from './bot.js';
import { browserLaunchOptions, spoofedUserAgent, jitsiRoomUrl } from './chromium-args.js';
import {
  pageMarkBot, pageMarkAggregator, pageAudioBridge, pageGumOverride,
  pageAggregatorCapture, pageDrainParticipantAudio, pageAggregatorCaptureDiag, pageFpsSampler,
  pageEnsureAudioPublished, pageMasterPlayer, pageEnqueueMaster, pageIsActiveAggregator,
} from './page-scripts.js';
import { RingBuffer } from './ring-buffer.js';
import { CircularParticipantQueue, tokenOrder } from './circular-participant-queue.js';

// How often the ingest loop drains the page tap into the buffers.
const DEFAULT_INGEST_INTERVAL_MS = 500;
// How often the playback loop assembles the master and streams it back out.
const DEFAULT_PLAYBACK_INTERVAL_MS = 250;
// Round-robin turn length (ms) before the metaprogram schedules slots for real:
// stream one participant, then the next, so the alternation is audible.
const DEFAULT_SLOT_MS = 4000;
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
 *     -> large shared sequential buffer (one RingBuffer, all participants concatenated)
 *     -> back out to the client
 *
 * Two dimensions of ring buffer, both fixed-capacity with oldest-sample
 * eviction:
 *   - this.buffers[token]  each participant's own concatenated audio, keyed by
 *                          Net Cycles room index: 0 for the first human, 0a/0b/…
 *                          for that human's bots, 1 for the next human, and so on
 *   - this.sharedBuffer    all participants concatenated into the master mix
 *
 * Key differences from Bot: joins and unmutes immediately, boots no Strudel
 * (it makes no sound of its own — its published track carries the assembled
 * mix), and taps the room instead of playing into it.
 */
export class AggregatorBot extends Bot {

    constructor(cfg, { launcher, reporter, logIngest = true, now, isActive, connectSidecar } = {}, buffers = {}, bufferSize = 1024) {
        super(cfg, { launcher });
        // Individual dimension: token -> RingBuffer. Pre-seedable for tests.
        this.buffers = buffers;
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
        // Shared dimension: the concatenated master. Larger than one participant
        // buffer because it holds every scheduled slot back to back.
        this.sharedBuffer = new RingBuffer(cfg.sharedBufferSize || this.bufferSize * 8);
        // Turn length for the pre-metaprogram round-robin, and an injectable
        // clock so the alternation is testable without real time.
        this.slotMs = Math.max(1, Number(cfg.slotMs ?? DEFAULT_SLOT_MS));
        this.now = typeof now === 'function' ? now : () => Date.now();
        // The circular priority queue: the fixed join-order ring, the assign-once
        // jitsiId -> room-index-token mapping, and the write/turn pointer. Shares
        // this bot's clock and slot length so serve() rotates in lockstep with the
        // assembly loop. The per-participant PCM stays in this.buffers; the queue
        // only decides the order and whose turn it is.
        this._order = new CircularParticipantQueue({ now: this.now, slotMs: this.slotMs });
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
        // Pre-join gate: how the bot claims the room's single aggregator slot
        // from the sidecar BEFORE launching its browser. A `(url, {onOpen,
        // onMessage}) => { send, close }` connector (production injects the
        // ws-backed one; tests inject a fake). Absent -> the claim is skipped
        // (standalone / unit tests that drive the bot directly).
        this.connectSidecar = typeof connectSidecar === 'function' ? connectSidecar : null;
        this._claimConn = null;
        // Which token is currently streaming (the queue owns the turn timing).
        this._activeToken = null;
        // Where a metrics sample goes. Defaults to the console so a bare
        // instance "publishes its own metrics"; tests inject a capturing sink.
        this.reporter = reporter || ((tag, data) => console.log(tag, data));
        // Print incoming audio + ring buffers whenever data reaches the bot.
        // On by default (deployed bots log to their container stdout); tests
        // silence it to keep node:test output readable.
        this.logIngest = logIngest;
        // Wrap the timer globals rather than storing bare references: in a
        // browser setInterval is a Window method that throws when invoked as
        // this._setInterval(...) with the instance as receiver (the exact bug
        // that crashed ClockSync). Node doesn't care, but this keeps the bot
        // safe if it is ever driven page-side.
        this._setInterval = (typeof setInterval !== 'undefined') ? (fn, ms) => setInterval(fn, ms) : null;
        this._clearInterval = (typeof clearInterval !== 'undefined') ? (id) => clearInterval(id) : null;
        this._ingestTimer = null;
        this._playbackTimer = null;
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
    }

    /**
     * Drive the ingest on a cadence: every tick drains the page tap into the
     * per-participant buffers (which logs incoming audio + buffers when data
     * arrives). Interval from cfg.ingestIntervalMs; <= 0 disables the loop
     * (tests call ingestTick() directly).
     */
    startIngestLoop() {
        const ms = Number(this.cfg.ingestIntervalMs ?? DEFAULT_INGEST_INTERVAL_MS);
        if (!(ms > 0) || !this._setInterval || this._ingestTimer) return;
        this._ingestTimer = this._setInterval(() => { this.ingestTick(); }, ms);
        // Don't keep the process alive just for the ingest loop.
        if (this._ingestTimer && this._ingestTimer.unref) this._ingestTimer.unref();
    }

    async ingestTick() {
        // Stand down unless we're the room's active aggregator (see isActive): a
        // second aggregator neither taps nor streams, so no feedback loop forms.
        if (!(await this.isActive())) return;
        // #drainPageCaptures already swallows page errors; nothing to write when
        // the room is silent.
        await this.writeToIndividualParticipantBufferQueues();
    }

    /**
     * Drive the return path on a cadence: every tick assembles the master mix
     * from the individual buffers and streams it back out to the room. Interval
     * from cfg.playbackIntervalMs; <= 0 disables the loop (tests call
     * readAndAssembleMasterBuffer()/playMasterBufferToClient() directly).
     */
    startPlaybackLoop() {
        const ms = Number(this.cfg.playbackIntervalMs ?? DEFAULT_PLAYBACK_INTERVAL_MS);
        if (!(ms > 0) || !this._setInterval || this._playbackTimer) return;
        this._playbackTimer = this._setInterval(() => { this.playbackTick(); }, ms);
        // Don't keep the process alive just for the playback loop.
        if (this._playbackTimer && this._playbackTimer.unref) this._playbackTimer.unref();
    }

    async playbackTick() {
        // Only the active aggregator assembles and streams the master; a stood-
        // down aggregator publishes silence, so it can't feed back into the
        // active one's mix (which taps every participant, including this bot).
        if (!(await this.isActive())) return;
        await this.readAndAssembleMasterBuffer();
        await this.playMasterBufferToClient();
    }

    async interpretAndExecuteMetaprogram() {
        // evaluate the metaprogram and schedule the audio and visual streams to the client
        // update buffer sizes
        // implement and test audio streaming first
        // starts off with  audio and video to the Jitsi roomdefault metaprogram, but listens for updates from the client and re-evaluates the metaprogram when it changes
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
            // Pin jitsiId -> token ONCE and route by the pinned token, so a
            // participant's audio always lands in the same buffer/slot for the
            // whole meeting even if its token were re-announced (requirement 2).
            // Bots participate exactly like humans here — their audio (only) is
            // captured from the room and streamed through this aggregator
            // (requirement 5) under their cluster token (0a, 0b, …).
            const identity = take.jitsiId != null ? String(take.jitsiId) : String(take.token);
            const token = this._order.register(identity, String(take.token));
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
        // Cyclic fixed-order turn-taking, NO metaprogram yet: the circular queue
        // rotates the active participant every slotMs (default 4s) through the
        // fixed JOIN-ORDER ring, and only that participant's audio is concatenated
        // into the shared master. This is the proof that audio makes the full
        // round trip — participant -> individual buffer -> shared master -> back
        // out — before the scheduler decides the slots for real.
        // interpretAndExecuteMetaprogram will later replace this fixed rotation
        // with the metaprogram-dictated schedule.
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

        const { token: active, lapped } = this._order.serve();
        if (!active) {
            // Nothing has reached the bot yet: assemble nothing. The page player
            // emits silence and we keep checking on the next tick.
            this._activeToken = null;
            return { active: null, assembled: 0 };
        }
        this._activeToken = active;
        const rb = this.buffers[active];
        // Draining the active buffer both RELEASES this turn's audio and, relative
        // to the previous turn, evicts what was released a lap ago — the two
        // events requirement 4 pairs at a slot: released on its turn, gone (the
        // buffer emptied) by the time the write pointer reaches this slot again.
        // `lapped` marks that return-to-position for observability.
        const held = rb ? rb.read(rb.length) : new Float32Array(0);
        // Gain-stage the master before it is streamed (requirement 6).
        const { gain, samples } = this.computeGainStaging(held);
        if (samples.length) this.sharedBuffer.write(samples);
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
            if (!this._order.hasToken(token)) this._order.register(token, token);
        }
    }

    async playMasterBufferToClient() {
        // Drain the shared master and hand it to the page-side player, which
        // streams it out through the bot's published track to every other client.
        // An empty master enqueues nothing — the player emits silence and we keep
        // checking on the next tick.
        const samples = this.sharedBuffer.read(this.sharedBuffer.length);
        if (!samples.length) return { played: 0 };
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
        if (this._claimConn) {
            try { this._claimConn.close(); }
            catch (e) { console.error(`[aggregator-bot] failed to close aggregator claim connection: ${e.message}`); }
            this._claimConn = null;
        }
        if (this._ingestTimer && this._clearInterval) this._clearInterval(this._ingestTimer);
        this._ingestTimer = null;
        if (this._playbackTimer && this._clearInterval) this._clearInterval(this._playbackTimer);
        this._playbackTimer = null;
        this.sharedBuffer.clear();
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
        // Log both buffer dimensions — the shared master plus every participant's
        // individual buffer — as an array of rows with the debugging/perf columns.
        const timestamp = Date.now();
        const row = (token, rb) => ({
            timestamp,
            token,
            bufferSize: rb.capacity,
            bufferLength: rb.length,
            bufferBytes: rb.bytes,
            bufferEvicted: rb.evicted,
            bufferMaxBuffers: rb.capacity,
            bufferMaxBytes: rb.capacity * Float32Array.BYTES_PER_ELEMENT,
        });
        const rows = [row('__shared__', this.sharedBuffer)];
        for (const [token, rb] of Object.entries(this.buffers)) rows.push(row(token, rb));
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

    /** Buffer stats for both dimensions, folded into the metrics sample. */
    bufferStats() {
        const participants = {};
        for (const [token, rb] of Object.entries(this.buffers)) participants[token] = rb.stats();
        return { shared: this.sharedBuffer.stats(), participants };
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

    // Sidecar URL for the aggregator claim, derived from the Jitsi room URL so it
    // targets the SAME room the bundle registers under (the bundle keys the room
    // on the last path segment and reaches the sidecar at /ws on the page host —
    // proxied by nginx). Null if no connector is wired or the URL can't be parsed.
    #sidecarClaimUrl() {
        if (!this.connectSidecar) return null;
        try {
            const u = new URL(this.cfg.jitsiUrl);
            const room = u.pathname.split('/').filter(Boolean).pop();
            if (!room) return null;
            const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
            return `${proto}//${u.host}/ws?room=${encodeURIComponent(room)}&role=aggregator-probe`;
        } catch (e) {
            console.error(`[aggregator-bot] could not derive sidecar claim URL from ${this.cfg.jitsiUrl}: ${e.message}`);
            return null;
        }
    }

    async #claimAggregatorSlot() {
        const url = this.#sidecarClaimUrl();
        if (!url) return; // no connector wired — nothing to gate on (tests/standalone)
        const granted = await this.#requestAggregatorClaim(url);
        if (!granted) {
            // Someone else holds the room's single aggregator slot. Release our
            // probe and refuse to join — the caller (start) propagates the throw
            // so the container exits instead of joining the meeting.
            if (this._claimConn) {
                try { this._claimConn.close(); }
                catch (e) { console.error(`[aggregator-bot] failed to close aggregator claim connection: ${e.message}`); }
                this._claimConn = null;
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
            this._claimConn = this.connectSidecar(url, {
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
            // Empty drain: dump the capture tap's state so "drained 0" localizes to a
            // stage (no audio received / tap failing / token unresolved). Throttled to
            // roughly every 10th empty tick so it's a heartbeat, not a flood. Best-effort
            // telemetry — log a failure but don't throw, so a diag hiccup can't wedge ingest.
            if (!takes || !takes.length) {
                this._emptyDrains = (this._emptyDrains || 0) + 1;
                if (this._emptyDrains % 10 === 1) {
                    try {
                        const diag = await this.page.evaluate(pageAggregatorCaptureDiag);
                        console.log('[aggregator-bot] capture diag', JSON.stringify(diag));
                    } catch (e) {
                        console.error(`[aggregator-bot] capture diag failed: ${e.message}`);
                    }
                }
            }
            return Array.isArray(takes) ? takes : [];
        } catch (e) {
            console.error(`[aggregator-bot] failed to drain participant captures: ${e.message}`);
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
