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
    this._nextBotId = 0;
    // Never-decreasing per-owner spawn ordinals: mirrors the sidecar's
    // suffix counters exactly (indices are never reused), so clusterIndex
    // matches the index the bot will be assigned at its hello.
    this._ownerSpawnCounts = new Map();
  }

  // ---------- lifecycle ----------

  async start() {
    await this.#listen();
    if (this.connectSidecar) this.#joinBus();
    this.tick = setInterval(() => this.healthTick().catch(() => {}), this.cfg.healthTickMs);
  }

  async stop() {
    clearInterval(this.tick);
    for (const t of this.ownerTimers.values()) clearTimeout(t);
    this.ownerTimers.clear();
    if (this.meetingEndTimer) clearTimeout(this.meetingEndTimer);
    for (const id of [...this.bots.keys()]) await this.#stopBot(id);
    await this.#stopAggregator();
    if (this.sidecar) { try { this.sidecar.close(); } catch {} this.sidecar = null; }
    if (this.server) await new Promise((r) => this.server.close(r));
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
        if (Array.isArray(msg.peers)) {
          for (const p of msg.peers) this.#trackPeer(p);
        }
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
    if (!peer.isBot && this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
    // A human in the room means there is audio to aggregate.
    if (!peer.isBot) this.#ensureAggregator().catch(() => {});
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
    // (clusters and the aggregator alike).
    const humansLeft = [...this.presentIndices.values()].some((p) => !p.isBot);
    if (!humansLeft && (this.bots.size > 0 || this.aggregatorRunning) && !this.meetingEndTimer) {
      this.meetingEndTimer = setTimeout(() => {
        this.meetingEndTimer = null;
        this.#teardownAll('meeting ended').catch(() => {});
      }, this.cfg.meetingEndGraceMs);
      if (this.meetingEndTimer.unref) this.meetingEndTimer.unref();
    }
  }

  async #handleFleetRequest(msg) {
    const ownerIndex = msg.fromIndex != null ? String(msg.fromIndex) : null;
    if (ownerIndex == null) return;
    if (msg.action === 'spawn') {
      const count = Math.max(0, Math.floor(Number(msg.count) || 0));
      await this.spawnCluster(ownerIndex, count);
    } else if (msg.action === 'remove') {
      await this.removeCluster(ownerIndex, msg.targets ?? 'all', { reason: 'owner request' });
    }
  }

  // ---------- clusters ----------

  #clusterIds(ownerIndex) {
    return [...this.bots.values()]
      .filter((b) => b.ownerIndex === ownerIndex)
      .map((b) => b.botId);
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

  async #teardownAll(reason) {
    for (const id of [...this.bots.keys()]) await this.#stopBot(id);
    await this.#stopAggregator();
    this.#busSend({ type: 'fleet-status', action: 'teardown', removed: 'all', reason });
  }

  // ---------- aggregator (one per room, outside the cluster id space) ----------

  async #ensureAggregator() {
    if (this.aggregatorRunning) return;
    this.aggregatorRunning = true; // set first so concurrent joins don't double-spawn
    try {
      await this.runner.start(AGGREGATOR_BOT_ID, { BOT_ROLE: 'aggregator' });
    } catch (err) {
      this.aggregatorRunning = false;
      console.error('[fleet] failed to start aggregator:', err.message);
    }
  }

  async #stopAggregator() {
    if (!this.aggregatorRunning) return;
    this.aggregatorRunning = false;
    this.aggregatorMetrics = null;
    await this.runner.stop(AGGREGATOR_BOT_ID);
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
    const clusterOrdinal = this._ownerSpawnCounts.get(ownerIndex) || 0;
    this._ownerSpawnCounts.set(ownerIndex, clusterOrdinal + 1);
    this.bots.set(botId, {
      botId,
      ownerIndex,
      // Mirror of the sidecar-assigned index (authoritative assignment
      // happens at the bot's hello; ordinals agree because the fleet is the
      // only spawner for this owner and neither side reuses them).
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

  // Public so tests (and operators via a REPL) can force a tick.
  async healthTick() {
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
      const verdict = shouldReplace(m, fleet, this.cfg);
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
            return send(200, { ok: true });
          }
          if (typeof m.botId !== 'number') return send(400, { error: 'botId required' });
          this.metrics.set(m.botId, { ...m, receivedAt: Date.now() });
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
