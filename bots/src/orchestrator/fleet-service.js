/**
 * Fleet Service — the conductor's replacement as primary bot orchestrator.
 *
 * Fleet membership is (ownerIndex → cluster), driven by in-room requests
 * relayed through the latency sidecar instead of a fixed maxBots fleet:
 *   - a human sends { type:'fleet-request', action:'spawn', count } from the
 *     studio → the fleet starts N containers on their behalf, passing
 *     BOT_OWNER_INDEX so the sidecar assigns cluster indices (1a, 1b, …);
 *   - action:'remove' with targets [indices]|'all' tears down (only the
 *     requester's own cluster);
 *   - when an owner leaves, their cluster leaves after ownerLeaveGraceMs;
 *     when the last human leaves, everything tears down after
 *     meetingEndGraceMs (Puppeteer teardown per XMPP constraints).
 *
 * Everything the conductor exposed is preserved without duplication:
 * the assignment/metrics HTTP surface on :7700, listBots/applyConfig/
 * setMasterScript/cfg (so createAdminServer and the external mcp-observer's
 * /api/bots + /api/config keep working verbatim), and the health policy —
 * shouldReplace/computeMaxBots are used unchanged; spawn requests "may be
 * interrupted by preexisting health measures" (the ceiling caps clusters,
 * partial spawns surface a reason via fleet-status).
 *
 * The container runner and the sidecar socket factory are injected so tests
 * drive the full lifecycle with fakes.
 */

import http from 'node:http';
import { mergeConfig } from '../shared/config.js';
import { breedNameFor } from '../shared/dog-breeds.js';
import { worstCaseLatency, percentile } from '../shared/stats.js';
import { randomMasterScript, validateMasterScript, variationFor } from '../script-gen/index.js';
import { shouldReplace, computeMaxBots } from './health.js';

// The single per-room aggregator container runs outside the per-owner cluster
// id space (never assigned by #nextBotId, never counted against the ceiling).
// Its high sentinel id keeps its docker name (trussal-bot-99999) clear of any
// real bot.
export const AGGREGATOR_BOT_ID = 99999;

export class FleetService {
  constructor(cfg, { runner, connectSidecar }) {
    if (!runner) throw new TypeError('a container runner {start, stop} is required');
    this.cfg = cfg;
    this.runner = runner;
    this.connectSidecar = connectSidecar || null; // (url, handlers) → { send, close }
    this.master = randomMasterScript(cfg.sessionSeed);
    this.bots = new Map();     // botId → { botId, ownerIndex, name, script, startedAt }
    this.metrics = new Map();  // botId → latest metrics sample
    this.server = null;
    this.port = null;
    this.tick = null;
    this.activeCeiling = cfg.maxBots;

    this.sidecar = null;
    this.presentIndices = new Map(); // roomIndex → { isBot, peerId }
    this.ownerTimers = new Map();    // ownerIndex → teardown timeout
    this.meetingEndTimer = null;
    // One aggregator per room, spawned when the first human is present and
    // torn down with the meeting. Tracked separately from `bots` so it never
    // counts against the ceiling or gets health-replaced.
    this.aggregatorRunning = false;
    this.aggregatorMetrics = null;
    // When the currently-running aggregator was last confirmed alive: set on
    // a successful start, refreshed by every metrics report. #reapDeadAggregator
    // reads this to tell "hasn't reported yet, still starting up" (age <
    // aggregatorStartupGraceMs) apart from "was alive, has gone silent" (no
    // metrics for aggregatorStaleMs) — see #reapDeadAggregator.
    this.aggregatorStartedAt = null;
    // When diag.jitsiJoined was last observed true (defaults to
    // aggregatorStartedAt via the `||` at the read site, covering "never yet
    // joined, still within its own startup grace"). Updated on every metrics
    // arrival that reports joined; a sustained gap since this timestamp — not
    // a single false reading, which a normal ICE reconnect blip can cause —
    // means the bot's Jitsi conference is gone even though the process is
    // alive. See #reapDeadAggregator and the mirrored check in healthTick.
    this.aggregatorLastJoinedAt = null;
    // botId → same tracking as aggregatorLastJoinedAt, for player bots.
    this.botLastJoinedAt = new Map();
    // Serializes #ensureAggregator/#stopAggregator so a rejoin landing mid-
    // teardown queues behind the in-flight stop instead of racing it. Without
    // this, a rejoin's start() (which force-removes any stale container by
    // name first) can run concurrently with a still-in-flight graceful stop
    // and SIGKILL the old aggregator before its Jitsi leave() completes — a
    // ghost participant that lingers until Jitsi's own presence timeout,
    // alongside the duplicate that just joined.
    this.aggregatorQueue = Promise.resolve();
    this._nextBotId = 0;
  }

  // ---------- lifecycle ----------

  async start() {
    await this.#listen();
    if (this.connectSidecar) this.#joinBus();
    this.tick = setInterval(() => this.healthTick().catch(() => {}), this.cfg.healthTickMs);
  }

  async stop() {
    clearInterval(this.tick);
    for (const timer of this.ownerTimers.values()) clearTimeout(timer);
    this.ownerTimers.clear();
    if (this.meetingEndTimer) clearTimeout(this.meetingEndTimer);
    // Stop every bot AND the aggregator in PARALLEL so the whole fleet leaves the
    // Jitsi room within one graceful-stop window (each runner.stop is ~15s), not N
    // of them back to back — the conductor's stop_grace_period has to cover this.
    // allSettled, not all: one bot that fails to stop must NOT abort the teardown
    // of the rest (that would strand bots in the room). Log every outcome so a
    // failed leave is visible in the conductor's logs (the observer reads them).
    const results = await Promise.allSettled([
      ...[...this.bots.keys()].map((id) => this.#stopBot(id)),
      this.#stopAggregator(),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      console.error(`[fleet] teardown: ${failures.length}/${results.length} fleet stops failed:`,
        failures.map((failure) => (failure.reason && failure.reason.message) || failure.reason));
    } else {
      console.log(`[fleet] teardown: all ${results.length} fleet members stopped cleanly`);
    }
    if (this.sidecar) { try { this.sidecar.close(); } catch {} this.sidecar = null; }
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  // ---------- sidecar bus ----------

  #joinBus() {
    const url = `${this.cfg.sidecarWsUrl}?room=${encodeURIComponent(this.cfg.fleetRoom)}&role=fleet`;
    this.sidecar = this.connectSidecar(url, {
      onOpen: (send) => send({
        type: 'hello',
        jitsiId: `fleet-${this.cfg.fleetRoom}`,
        displayName: 'fleet-service',
        isFleet: true
      }),
      onMessage: (msg) => this.handleBusMessage(msg).catch((err) => {
        console.error('[fleet] bus message failed:', err.message);
      })
    });
  }

  #busSend(msg) {
    if (this.sidecar) { try { this.sidecar.send(msg); } catch {} }
  }

  // Exposed for tests (fakes call this directly).
  async handleBusMessage(msg) {
    switch (msg.type) {
      case 'roster':
        if (Array.isArray(msg.peers)) this.#reconcileRoster(msg.peers);
        break;
      case 'peer-join':
        if (msg.peer) this.#trackPeer(msg.peer);
        break;
      case 'peer-leave':
        this.#untrackPeer(msg.peerId);
        break;
      case 'fleet-request':
        await this.#handleFleetRequest(msg);
        break;
      case 'session-reset':
        // The sidecar broadcasts this when the room becomes fleet-only (every
        // real participant gone) — the meeting is genuinely over, even if a
        // human rejoins fast enough to cancel our own meetingEndGraceMs timer
        // before it fires (see #evaluateMeetingEnd). Without reacting to this
        // directly, old bot clusters (and the old aggregator) would silently
        // carry over into whatever reuses this room name next; a new meeting
        // should start with nothing, and bots should have to be spawned fresh.
        await this.#teardownAll('session reset — room emptied and reused');
        break;
      default:
        break;
    }
  }

  #trackPeer(peer) {
    if (peer.roomIndex == null) return;
    const idx = String(peer.roomIndex);
    this.presentIndices.set(idx, { isBot: !!peer.isBot, peerId: peer.peerId });
    // A returning owner cancels their cluster's death sentence.
    if (!peer.isBot && this.ownerTimers.has(idx)) {
      clearTimeout(this.ownerTimers.get(idx));
      this.ownerTimers.delete(idx);
    }
    // A human in the room means there is audio to aggregate.
    if (!peer.isBot) this.#ensureAggregator().catch((e) => {console.error('[fleet] failed to start aggregator:', e.message);});
    // A present human cancels any pending meeting-end teardown (recomputed here).
    this.#evaluateMeetingEnd();
  }

  #untrackPeer(peerId) {
    for (const [idx, info] of this.presentIndices.entries()) {
      if (info.peerId !== peerId) continue;
      this.presentIndices.delete(idx);
      if (!info.isBot) this.#onOwnerLeft(idx);
      return;
    }
  }

  #onOwnerLeft(ownerIndex) {
    if (this.#clusterIds(ownerIndex).length > 0 && !this.ownerTimers.has(ownerIndex)) {
      const t = setTimeout(() => {
        this.ownerTimers.delete(ownerIndex);
        this.removeCluster(ownerIndex, 'all', { reason: 'owner left' }).catch(() => {});
      }, this.cfg.ownerLeaveGraceMs);
      if (t.unref) t.unref();
      this.ownerTimers.set(ownerIndex, t);
    }
    // Last human gone → the meeting is over; destroy every Puppeteer instance
    // (clusters and the aggregator alike) after the grace period.
    this.#evaluateMeetingEnd();
  }

  // The single decision point for meeting-end teardown. Level-triggered on the
  // shadow roster so it is safe to call from any path (peer-leave, roster
  // reconcile, aggregator start): whenever no human remains but the aggregator
  // or a cluster is still up, arm the teardown; a returning human cancels a
  // pending one. XMPP constraints forbid leaving instantly, so the actual fleet
  // leave waits meetingEndGraceMs.
  #evaluateMeetingEnd() {
    const humansPresent = [...this.presentIndices.values()].some((p) => !p.isBot);
    const fleetUp = this.bots.size > 0 || this.aggregatorRunning;
    const actions = {
      cancel: () => {                              // a returning human aborts the countdown
        clearTimeout(this.meetingEndTimer);
        this.meetingEndTimer = null;
      },
      arm: () => {                                 // last human gone → start the countdown
        this.meetingEndTimer = setTimeout(() => {
          this.meetingEndTimer = null;
          this.#teardownAll('meeting ended').catch((err) => {
            console.error('[fleet] meeting-end teardown failed:', err.message);
          });
        }, this.cfg.meetingEndGraceMs);
        if (this.meetingEndTimer.unref) this.meetingEndTimer.unref();
      },
      noop: () => {},
    };
    const decide = () => {
      if (humansPresent && this.meetingEndTimer) return 'cancel';
      if (this.meetingEndTimer && !humansPresent) return 'noop'; // already counting down
      if (!humansPresent && fleetUp) return 'arm';
      return 'noop';
    };
    actions[decide()]();
  }

  // Reconcile the shadow roster against the sidecar's authoritative snapshot.
  // The roster arrives on every hello — so on every bus reconnect too — and is
  // the ONLY way a departed peer is corrected after a socket blip: peer-leave is
  // edge-triggered, and a reconnect misses any leaves that happened while we were
  // down. Without this, a human who left during the outage stays "present"
  // forever, meeting-end teardown never arms, and the aggregator persists into
  // the next meeting (blocking a fresh one). Register the peers the roster lists
  // FIRST so a still-present human is known before we run any departed owner's
  // leave path (otherwise we'd needlessly arm+cancel the teardown mid-reconcile).
  #reconcileRoster(peers) {
    const present = new Set(
      peers.filter((peer) => peer.roomIndex != null).map((peer) => String(peer.roomIndex)),
    );
    const departed = [...this.presentIndices.entries()].filter(([idx]) => !present.has(idx));
    departed.forEach(([idx]) => this.presentIndices.delete(idx));
    const departedOwners = departed.filter(([, info]) => !info.isBot).map(([idx]) => idx);

    peers.forEach((peer) => this.#trackPeer(peer));
    departedOwners.forEach((idx) => this.#onOwnerLeft(idx));
  }

  async #handleFleetRequest(msg) {
    const ownerIndex = msg.fromIndex != null ? String(msg.fromIndex) : null;
    if (ownerIndex == null) return;
    if (msg.action === 'spawn') {
      const count = Math.max(0, Math.floor(Number(msg.count) || 0));
      await this.spawnCluster(ownerIndex, count);
    } else if (msg.action === 'remove') {
      await this.removeCluster(ownerIndex, msg.targets ?? 'all', { reason: 'owner request' });
    } else if (msg.action === 'removeOne') {
      await this.removeOneBot(name, ownerIndex ?? -1,  { reason: 'owner request' });
    }
  }

  // ---------- clusters ----------

  #clusterIds(ownerIndex) {
    return [...this.bots.values()]
      .filter((b) => b.ownerIndex === ownerIndex)
      .map((b) => b.botId);
  }

  // Lowest cluster ordinal not currently held by one of ownerIndex's bots.
  // Mirrors the sidecar's lowestFreeBotOrdinal: bot suffixes gap-refill, so a
  // removed bot's suffix is reused by the next spawn rather than climbing. The
  // bot being started is added to `bots` by the caller AFTER this returns, so it
  // never counts itself.
  #lowestFreeOrdinal(ownerIndex) {
    const prefix = String(ownerIndex);
    const used = new Set();
    for (const b of this.bots.values()) {
      if (b.ownerIndex !== ownerIndex) continue;
      used.add(ordinalForSuffix(b.clusterIndex.slice(prefix.length)));
    }
    let ordinal = 0;
    while (used.has(ordinal)) ordinal++;
    return ordinal;
  }

  /**
   * Spawn `count` bots on ownerIndex's behalf. Health measures may interrupt:
   * the active ceiling caps the total fleet, a partial spawn reports why.
   */
  async spawnCluster(ownerIndex, count) {
    const headroom = Math.max(0, this.activeCeiling - this.bots.size);
    const toSpawn = Math.min(count, headroom);
    for (let i = 0; i < toSpawn; i++) {
      const botId = this.#nextBotId();
      await this.#startBot(botId, ownerIndex);
    }
    const status = {
      type: 'fleet-status',
      action: 'spawn',
      ownerIndex,
      requested: count,
      spawned: toSpawn,
      fleetSize: this.bots.size,
      ceiling: this.activeCeiling,
      ...(toSpawn < count ? { reason: `health ceiling ${this.activeCeiling} reached` } : {})
    };
    this.#busSend(status);
    return status;
  }

  /**
   * Remove targets ('all' or an array of cluster indices like ['1a','1c'])
   * from ownerIndex's own cluster only.
   */
  async removeCluster(ownerIndex, targets, { reason = '' } = {}) {
    const mine = [...this.bots.values()].filter((b) => b.ownerIndex === ownerIndex);
    const wanted = targets === 'all'
      ? mine
      : mine.filter((b) => Array.isArray(targets) && targets.includes(b.clusterIndex));
    for (const bot of wanted) await this.#stopBot(bot.botId);
    // No counter to reset: cluster suffixes are derived from the live cluster
    // (see #lowestFreeOrdinal), so a removed bot's suffix is simply free for the
    // next spawn — a fully-emptied cluster naturally restarts at 'a', a partial
    // removal refills the hole. Mirrors the sidecar's lowestFreeBotOrdinal.
    const status = {
      type: 'fleet-status',
      action: 'remove',
      ownerIndex,
      removed: wanted.length,
      fleetSize: this.bots.size,
      ...(reason ? { reason } : {})
    };
    this.#busSend(status);
    return status;
  }

  //TODO: implement single bot removal, call onclick of x button
  async removeOneBot(name, target, { reason = '' } = {}) {
      const botToRemove = [...this.bots.values()].find((bremoveOneot) => bot.name === name && target === bot.clusterIndex);
      await this.#stopBot(botToRemove.botId);
      const status = {
        type: 'fleet-status',
        action: 'removeOne',
        name,
        removed: 1,
        fleetSize: this.bots.size,
        ...(reason ? { reason } : {})
      };
      this.#busSend(status);
      return status;
  }

  async #teardownAll(reason) {
    for (const id of [...this.bots.keys()]) await this.#stopBot(id);
    await this.#stopAggregator();
    // Meeting over: `bots` is now empty, so the derived suffixes reset with it —
    // the next meeting to reuse this name starts its clusters fresh at 0a.
    this.#busSend({ type: 'fleet-status', action: 'teardown', removed: 'all', reason });
  }

  // ---------- aggregator (one per room, outside the cluster id space) ----------

  // Chains `op` onto aggregatorQueue so it runs only after every previously
  // queued start/stop has fully settled — see the aggregatorQueue comment in
  // the constructor. `op` is used as both the fulfilled and rejected handler
  // so a failed op (e.g. runner.stop() throwing) doesn't permanently wedge the
  // queue for whatever's chained after it; the immediate caller still observes
  // the rejection via the returned promise.
  #queueAggregatorOp(op) {
    this.aggregatorQueue = this.aggregatorQueue.then(op, op);
    return this.aggregatorQueue;
  }

  async #ensureAggregator() {
    return this.#queueAggregatorOp(async () => {
      if (this.aggregatorRunning) return;
      this.aggregatorRunning = true; // set first so concurrent joins don't double-spawn
      try {
        await this.runner.start(AGGREGATOR_BOT_ID, { BOT_ROLE: 'aggregator' });
        this.aggregatorStartedAt = Date.now();
      } catch (err) {
        this.aggregatorRunning = false;
        console.error('[fleet] failed to start aggregator:', err.message);
      }
    });
  }

  async #stopAggregator() {
    return this.#queueAggregatorOp(async () => {
      if (!this.aggregatorRunning) return;
      this.aggregatorRunning = false;
      this.aggregatorMetrics = null;
      this.aggregatorStartedAt = null;
      this.aggregatorLastJoinedAt = null;
      await this.runner.stop(AGGREGATOR_BOT_ID);
    });
  }

  /**
   * The aggregator has no health-replace path — its metrics are deliberately
   * excluded from the shouldReplace fleet in the /metrics handler below, since
   * it isn't one of `bots`. That means nothing but an explicit
   * #stopAggregator() call ever clears aggregatorRunning, so two different
   * ways the running container can become USELESS both need to be reaped:
   *
   *   1. The process itself died (lost the sidecar's aggregator-claim race on
   *      a rejoin, crashed, OOM'd, …) — detected via metrics silence, since
   *      the aggregator POSTs on its own cadence and a long enough gap past
   *      its startup grace period means it's gone.
   *   2. The process is still very much alive and reporting normally, but its
   *      Jitsi CONFERENCE is gone out from under it — a moderator's "End
   *      meeting for all" destroys the room; the aggregator's peer-state WS
   *      closes correctly, but nothing tells its own Jitsi session to leave
   *      or rejoin, so it just sits there forever, connected to a dead room.
   *      Live-observed: a fast-enough human rejoin cancels the meeting-end
   *      teardown (a human is present again) before it can free the orphaned
   *      container. Detected via sustained diag.jitsiJoined:false — not a
   *      single reading, which a normal ICE reconnect blip can also cause.
   *
   * Either way: reap + immediately respawn if a human is still around to want
   * one. runner.stop() on an already-dead container is safe (docker-runner's
   * stop/rm are self-catching), so reaping never fails on the cleanup side.
   */
  async #reapDeadAggregator() {
    if (!this.aggregatorRunning) return;
    const age = Date.now() - (this.aggregatorStartedAt || 0);
    if (age < this.cfg.aggregatorStartupGraceMs) return; // hasn't had a chance to report yet

    const lastMetricsAt = this.aggregatorMetrics ? this.aggregatorMetrics.receivedAt : this.aggregatorStartedAt;
    const metricsStaleMs = Date.now() - lastMetricsAt;
    const metricsStale = metricsStaleMs >= this.cfg.aggregatorStaleMs;

    const lastJoinedAt = this.aggregatorLastJoinedAt || this.aggregatorStartedAt;
    const orphanedMs = Date.now() - lastJoinedAt;
    const orphaned = orphanedMs >= this.cfg.jitsiJoinGraceMs;

    if (!metricsStale && !orphaned) return; // alive and either reporting or genuinely still joined
    const reason = metricsStale
      ? `metrics stale for ${metricsStaleMs}ms`
      : `orphaned from its Jitsi conference for ${orphanedMs}ms (room likely destroyed/ended)`;
    console.warn(`[fleet] aggregator ${reason}; reaping and respawning`);
    await this.#stopAggregator();
    const humansPresent = [...this.presentIndices.values()].some((p) => !p.isBot);
    if (humansPresent) await this.#ensureAggregator();
  }

  /** Aggregator liveness + latest sample, for observability (not health). */
  aggregatorStatus() {
    return { running: this.aggregatorRunning, metrics: this.aggregatorMetrics ?? null };
  }

  #nextBotId() {
    while (this.bots.has(this._nextBotId)) this._nextBotId++;
    return this._nextBotId++;
  }

  async #startBot(botId, ownerIndex) {
    const clusterOrdinal = this.#lowestFreeOrdinal(ownerIndex);
    this.bots.set(botId, {
      botId,
      ownerIndex,
      // Mirror of the sidecar-assigned index. Authoritative assignment happens
      // at the bot's hello; both sides pick the lowest cluster ordinal not held
      // by a live bot of this owner (gap-refill), so the SET of suffixes agrees
      // — the fleet is the only spawner for this owner.
      clusterIndex: `${ownerIndex}${suffixFor(clusterOrdinal)}`,
      name: breedNameFor(botId, this.cfg.sessionSeed),
      script: this.#variationFor(botId),
      startedAt: Date.now(),
    });
    try {
      await this.runner.start(botId, { BOT_OWNER_INDEX: ownerIndex });
    } catch (err) {
      this.bots.get(botId).startError = String(err.message || err);
      console.error(`[fleet] failed to start bot ${botId}:`, err.message);
    }
  }

  async #stopBot(botId) {
    this.bots.delete(botId);
    this.metrics.delete(botId);
    this.botLastJoinedAt.delete(botId);
    await this.runner.stop(botId);
  }

  // ---------- script distribution (unchanged from the conductor) ----------

  #variationFor(botId) {
    const m = this.metrics.get(botId);
    const latencies = [...this.metrics.values()].map((x) => x.latencyMs).filter((x) => x >= 0);
    const master = this.cfg.varyHydra
      ? { strudel: this.master.strudel, hydra: randomMasterScript(this.cfg.sessionSeed + botId + 1).hydra }
      : this.master;
    return variationFor(botId, master, {
      botCount: Math.max(1, this.bots.size || 1),
      roles: this.cfg.roles,
      wclMs: latencies.length ? worstCaseLatency(latencies) : 0,
      latencyMs: m?.latencyMs ?? 0,
      jitterMs: m?.jitterMs ?? 0,
      staggerSubdivisions: this.cfg.staggerSubdivisions,
    });
  }

  #redistribute() {
    for (const bot of this.bots.values()) bot.script = this.#variationFor(bot.botId);
  }

  setMasterScript(json) {
    const res = validateMasterScript(json);
    if (!res.ok) return res;
    this.master = { strudel: json.strudel, hydra: json.hydra };
    this.#redistribute();
    return { ok: true };
  }

  /** Admin config changes. maxBots is a ceiling here, not a target size. */
  async applyConfig(overrides) {
    this.cfg = mergeConfig(overrides, this.cfg);
    this.activeCeiling = Math.min(this.activeCeiling, this.cfg.maxBots);
    if (this.bots.size > this.activeCeiling) await this.#shrinkTo(this.activeCeiling);
    this.#redistribute();
  }

  async #shrinkTo(target) {
    // Newest bots go first; owners keep their earliest cluster members.
    const ids = [...this.bots.keys()].sort((a, b) => b - a);
    for (const id of ids) {
      if (this.bots.size <= target) break;
      await this.#stopBot(id);
    }
  }

  /** Same shape createAdminServer/mcp-observer already consume, plus cluster fields. */
  listBots() {
    return [...this.bots.values()].map((b) => ({
      botId: b.botId,
      name: b.name,
      ownerIndex: b.ownerIndex,
      clusterIndex: b.clusterIndex,
      script: b.script,
      startedAt: b.startedAt,
      lastMetrics: this.metrics.get(b.botId) ?? null,
    }));
  }

  // ---------- health (policy functions preserved verbatim) ----------

  /**
   * A player bot's counterpart to #reapDeadAggregator's orphan check: alive
   * and reporting normally (shouldReplace already covers process-level
   * unhealthiness) but its Jitsi conference is gone, most commonly because
   * the room was destroyed ("End meeting for all") and a fast rejoin left it
   * behind. Gated the same way — sustained absence since it was last
   * confirmed joined (or since it started, if never joined at all, so a bot
   * still in the middle of its normal startup isn't falsely flagged), not a
   * single reading.
   */
  #isJitsiOrphaned(botRecord, botId) {
    const lastJoinedAt = this.botLastJoinedAt.get(botId) ?? botRecord.startedAt;
    return (Date.now() - lastJoinedAt) >= this.cfg.jitsiJoinGraceMs;
  }

  // Public so tests (and operators via a REPL) can force a tick.
  async healthTick() {
    // Ahead of the player-bot early-return below: a room can hold only the
    // aggregator (no clusters spawned yet), and this check must still run.
    await this.#reapDeadAggregator();

    const fleet = [...this.metrics.values()];
    if (fleet.length === 0) return;

    const summary = {
      medianFps: percentile(fleet.map((m) => m.fps ?? 30), 50),
      maxRamMb: Math.max(...fleet.map((m) => (m.ramBytes ?? 0) / 1e6)),
      medianLatencyMs: percentile(fleet.map((m) => m.latencyMs ?? 0), 50) || 1,
    };
    this.activeCeiling = computeMaxBots(summary, this.cfg);
    if (this.bots.size > this.activeCeiling) await this.#shrinkTo(this.activeCeiling);

    for (const m of fleet) {
      const existing = this.bots.get(m.botId);
      if (!existing) continue;
      const verdict = this.#isJitsiOrphaned(existing, m.botId)
        ? { replace: true, reason: `orphaned from its Jitsi conference (room likely destroyed/ended)` }
        : shouldReplace(m, fleet, this.cfg);
      if (verdict.replace) {
        console.warn(`[fleet] replacing bot ${m.botId}: ${verdict.reason}`);
        const ownerIndex = existing.ownerIndex;
        await this.#stopBot(m.botId);
        if (this.bots.size < this.activeCeiling) await this.#startBot(m.botId, ownerIndex);
      }
    }
  }

  // ---------- HTTP (assignment/metrics contract preserved) ----------

  #listen() {
    this.server = http.createServer((req, res) => this.#route(req, res));
    return new Promise((resolve) => {
      this.server.listen(this.cfg.conductorPort, () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  #route(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const assignment = req.url.match(/^\/assignment\/(\d+)$/);
    if (req.method === 'GET' && assignment) {
      const bot = this.bots.get(Number(assignment[1]));
      if (!bot) return send(404, { error: 'unknown bot' });
      return send(200, { script: bot.script, botCount: this.bots.size });
    }

    if (req.method === 'POST' && req.url === '/metrics') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const m = JSON.parse(raw);
          // The aggregator reports too, but it lives outside the fleet: keep its
          // sample out of the health summary (percentiles/replacement) — just
          // record it for observability.
          if (m.role === 'aggregator') {
            this.aggregatorMetrics = { ...m, receivedAt: Date.now() };
            if (m.diag && m.diag.jitsiJoined) this.aggregatorLastJoinedAt = Date.now();
            return send(200, { ok: true });
          }
          if (typeof m.botId !== 'number') return send(400, { error: 'botId required' });
          this.metrics.set(m.botId, { ...m, receivedAt: Date.now() });
          if (m.diag && m.diag.jitsiJoined) this.botLastJoinedAt.set(m.botId, Date.now());
          return send(200, { ok: true });
        } catch {
          return send(400, { error: 'invalid JSON' });
        }
      });
      return undefined;
    }

    return send(404, { error: 'not found' });
  }
}

// 0-based cluster ordinal → letter suffix; mirrors
// latency-instrument/room-indices.js (a…z, za…zz, zza…).
export function suffixFor(ordinal) {
  const zs = Math.floor(ordinal / 26);
  return 'z'.repeat(zs) + 'abcdefghijklmnopqrstuvwxyz'[ordinal % 26];
}

// Inverse of suffixFor: letter suffix (a…z, za…zz, zza…) → 0-based ordinal.
// Mirrors latency-instrument/room-indices.js's suffixToOrdinal for the valid
// z*[a-z] suffixes the fleet itself produces.
export function ordinalForSuffix(suffix) {
  const zs = suffix.length - 1;
  return zs * 26 + 'abcdefghijklmnopqrstuvwxyz'.indexOf(suffix[suffix.length - 1]);
}

// ws-backed sidecar connector for production (tests inject fakes).
export function makeWsSidecarConnector(WebSocketImpl) {
  return (url, { onOpen, onMessage }) => {
    let ws = null;
    let closed = false;
    const open = () => {
      ws = new WebSocketImpl(url);
      ws.on('open', () => onOpen((msg) => ws.send(JSON.stringify(msg))));
      ws.on('message', (data) => {
        try { onMessage(JSON.parse(data.toString())); } catch {}
      });
      ws.on('close', () => { if (!closed) setTimeout(open, 2000); });
      ws.on('error', () => { try { ws.close(); } catch {} });
    };
    open();
    return {
      send: (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      close: () => { closed = true; try { ws.close(); } catch {} }
    };
  };
}
