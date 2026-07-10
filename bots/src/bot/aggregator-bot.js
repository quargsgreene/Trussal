import { Bot } from './bot.js';
import { browserLaunchOptions, spoofedUserAgent, jitsiRoomUrl } from './chromium-args.js';
import {
  pageMarkBot, pageMarkAggregator, pageAudioBridge, pageGumOverride,
  pageAggregatorCapture, pageDrainParticipantAudio, pageFpsSampler,
  pageEnsureAudioPublished, pageMasterPlayer, pageEnqueueMaster,
} from './page-scripts.js';
import { RingBuffer } from './ring-buffer.js';

// How often the ingest loop drains the page tap into the buffers.
const DEFAULT_INGEST_INTERVAL_MS = 500;
// How often the playback loop assembles the master and streams it back out.
const DEFAULT_PLAYBACK_INTERVAL_MS = 250;
// Round-robin turn length (ms) before the metaprogram schedules slots for real:
// stream one participant, then the next, so the alternation is audible.
const DEFAULT_SLOT_MS = 4000;

// Sort participant tokens into Net Cycles room-index order: 0, 0a, 0b, 1, 2, …
// (numeric index first, then the per-owner bot suffix). Falls back to a plain
// string compare for anything that doesn't parse, so the order is always stable.
function tokenOrder(a, b) {
    const ma = /^(\d+)([a-z]*)$/.exec(a);
    const mb = /^(\d+)([a-z]*)$/.exec(b);
    if (ma && mb) {
        const na = Number(ma[1]), nb = Number(mb[1]);
        if (na !== nb) return na - nb;
        return ma[2] < mb[2] ? -1 : ma[2] > mb[2] ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

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

    constructor(cfg, { launcher, reporter, logIngest = true, now } = {}, buffers = {}, bufferSize = 1024) {
        super(cfg, { launcher });
        // Individual dimension: token -> RingBuffer. Pre-seedable for tests.
        this.buffers = buffers;
        this.bufferSize = Math.max(1, Math.floor(bufferSize));
        // Shared dimension: the concatenated master. Larger than one participant
        // buffer because it holds every scheduled slot back to back.
        this.sharedBuffer = new RingBuffer(cfg.sharedBufferSize || this.bufferSize * 8);
        // Turn length for the pre-metaprogram round-robin, and an injectable
        // clock so the alternation is testable without real time.
        this.slotMs = Math.max(1, Number(cfg.slotMs ?? DEFAULT_SLOT_MS));
        this.now = typeof now === 'function' ? now : () => Date.now();
        // When the current round-robin started (set lazily on the first assemble
        // that actually has a participant to stream) and which token is streaming.
        this._playbackStartMs = null;
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
        await this.page.evaluate(pageEnsureAudioPublished).catch(() => {});

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
        // `captures` is [{ token, samples }] where token is the participant's
        // room index (0, 0a, 1, …); when omitted, drain the latest frames the
        // page-side tap accumulated from the remote <audio> elements.
        //
        // Turn-taking ("wait until it is this participant's turn") is deliberately
        // NOT applied here: the individual buffers are each participant's own
        // continuous audio, so gating writes would drop material. The metaprogram
        // slot decides whose audio is copied into the SHARED buffer — that gate
        // lives in readAndAssembleMasterBuffer, the next hop.
        const takes = captures ?? await this.#drainPageCaptures();
        // "Reached the aggregator" = a participant actually delivered samples.
        const arrived = (takes || []).filter((t) => t && t.token != null && t.samples && t.samples.length);
        const summary = {};
        for (const take of arrived) {
            const token = String(take.token);
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
        // Round-robin turn-taking, NO metaprogram yet: rotate the active
        // participant every slotMs (default 4s) and concatenate only that
        // participant's audio into the shared master. This is the proof that
        // audio makes the full round trip — participant -> individual buffer ->
        // shared master -> back out — before the scheduler decides the slots for
        // real. interpretAndExecuteMetaprogram will later replace this fixed
        // rotation with the metaprogram-dictated schedule.
        //
        // The inactive participants' individual buffers keep filling (and
        // evicting their oldest) in the meantime; when a participant's turn comes
        // round we stream whatever it has accumulated. Draining only the ACTIVE
        // buffer is what makes the alternation audible: at any instant the master
        // carries exactly one voice.
        const tokens = Object.keys(this.buffers).sort(tokenOrder);
        if (!tokens.length) {
            // Nothing has reached the bot yet: assemble nothing. The page player
            // emits silence and we keep checking on the next tick.
            this._activeToken = null;
            return { active: null, assembled: 0 };
        }
        const now = this.now();
        if (this._playbackStartMs == null) this._playbackStartMs = now;
        const slot = Math.floor((now - this._playbackStartMs) / this.slotMs);
        // Guard against a clock that runs backwards yielding a negative index.
        const active = tokens[((slot % tokens.length) + tokens.length) % tokens.length];
        this._activeToken = active;
        const rb = this.buffers[active];
        const samples = rb.read(rb.length); // stream everything buffered for them
        if (samples.length) this.sharedBuffer.write(samples);
        console.log(`[aggregator-bot] assembled master from token=${active} samples=${samples.length}`);
        return { active, assembled: samples.length };
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
        // Stop streaming, drop buffered audio, and close the page + browser.
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

    computeGainStaging() {
        // compute the gain staging for the audio streams
        // reduce master gain if max gain exceeds what's allowed by the bit depth of the audio stream
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

    async #drainPageCaptures() {
        if (!this.page || typeof this.page.evaluate !== 'function') return [];
        try {
            const takes = await this.page.evaluate(pageDrainParticipantAudio);
            return Array.isArray(takes) ? takes : [];
        } catch (e) {
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
            // A late Jitsi navigation tears down the context; the next tick
            // re-enqueues, so a dropped frame here is self-healing.
        }
    }
}
