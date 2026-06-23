/**
 * The Conductor: single source of truth for the session.
 *
 * Responsibilities:
 *  - owns the master script (random or user-provided, always validated),
 *  - derives each bot's exact variation (also what the admin inspector
 *    modal shows via listBots()),
 *  - serves assignments to booting bots and collects their metrics over
 *    plain HTTP (node:http — bots are on the same docker network; no
 *    framework needed for two routes),
 *  - applies the health policy every tick: replace outliers/erroring bots,
 *    shrink the fleet ceiling under global pressure.
 *
 * The container runner is injected (start/stop by botId) so tests exercise
 * the full replace/scale logic with a fake, and production plugs in the
 * docker-compose runner.
 */

import http from 'node:http';
import { mergeConfig } from '../shared/config.js';
import { breedNameFor } from '../shared/dog-breeds.js';
import { worstCaseLatency, percentile } from '../shared/stats.js';
import { randomMasterScript, validateMasterScript, variationFor } from '../script-gen/index.js';
import { shouldReplace, computeMaxBots } from './health.js';

export class Conductor {
  constructor(cfg, { runner }) {
    if (!runner) throw new TypeError('a container runner {start, stop} is required');
    this.cfg = cfg;
    this.runner = runner;
    this.master = randomMasterScript(cfg.sessionSeed);
    this.bots = new Map();      // botId → { botId, name, script, startedAt }
    this.metrics = new Map();   // botId → latest metrics sample
    this.server = null;
    this.port = null;
    this.tick = null;
    this.activeCeiling = cfg.maxBots; // health policy can pull this below cfg.maxBots
  }

  // ---------- lifecycle ----------

  async start() {
    await this.#listen();
    for (let id = 0; id < this.cfg.maxBots; id++) await this.#startBot(id);
    this.tick = setInterval(() => this.#healthTick().catch(() => {}), this.cfg.healthTickMs);
  }

  async stop() {
    clearInterval(this.tick);
    for (const id of [...this.bots.keys()]) await this.#stopBot(id);
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  async #startBot(botId) {
    this.bots.set(botId, {
      botId,
      name: breedNameFor(botId, this.cfg.sessionSeed),
      script: this.#variationFor(botId),
      startedAt: Date.now(),
    });
    try {
      await this.runner.start(botId);
    } catch (err) {
      // A failed container start (missing image, dead daemon) must not take
      // the conductor down with it — the admin page is how the operator
      // diagnoses exactly this. Leave the slot registered; the next health
      // tick or config change retries it.
      this.bots.get(botId).startError = String(err.message || err);
      console.error(`[conductor] failed to start bot ${botId}:`, err.message);
    }
  }

  async #stopBot(botId) {
    this.bots.delete(botId);
    this.metrics.delete(botId);
    await this.runner.stop(botId);
  }

  // ---------- script distribution ----------

  #variationFor(botId) {
    const m = this.metrics.get(botId);
    const latencies = [...this.metrics.values()].map((x) => x.latencyMs).filter((x) => x >= 0);
    // varyHydra: give each bot its own Hydra visual instead of the shared
    // master's. Seeded per bot (sessionSeed + botId) so it is deterministic —
    // a replaced bot reproduces the same visual. Strudel stays the shared
    // master; only the hydra source/mods differ per bot.
    const master = this.cfg.varyHydra
      ? { strudel: this.master.strudel, hydra: randomMasterScript(this.cfg.sessionSeed + botId + 1).hydra }
      : this.master;
    return variationFor(botId, master, {
      botCount: Math.max(1, this.bots.size || this.cfg.maxBots),
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

  /** Validated master-script swap; { ok, error? } flows straight to the admin UI. */
  setMasterScript(json) {
    const res = validateMasterScript(json);
    if (!res.ok) return res;
    this.master = { strudel: json.strudel, hydra: json.hydra };
    this.#redistribute();
    return { ok: true };
  }

  /** Admin config changes (bot count slider, role checkboxes, thresholds). */
  async applyConfig(overrides) {
    this.cfg = mergeConfig(overrides, this.cfg);
    this.activeCeiling = Math.min(this.activeCeiling, this.cfg.maxBots);
    await this.#resizeFleet(this.cfg.maxBots);
    this.#redistribute();
  }

  async #resizeFleet(target) {
    const ids = [...this.bots.keys()].sort((a, b) => a - b);
    for (const id of ids.filter((i) => i >= target)) await this.#stopBot(id);
    for (let id = 0; id < target; id++) {
      if (!this.bots.has(id)) await this.#startBot(id);
    }
  }

  /** Exact per-bot running code — backs the admin page's inspector modals. */
  listBots() {
    return [...this.bots.values()].map((b) => ({
      botId: b.botId,
      name: b.name,
      script: b.script,
      startedAt: b.startedAt,
      lastMetrics: this.metrics.get(b.botId) ?? null,
    }));
  }

  // ---------- health ----------

  async #healthTick() {
    const fleet = [...this.metrics.values()];
    if (fleet.length === 0) return;

    // 1. Global pressure → shrink the ceiling (spec: scale down from 10).
    const summary = {
      medianFps: percentile(fleet.map((m) => m.fps ?? 30), 50),
      maxRamMb: Math.max(...fleet.map((m) => (m.ramBytes ?? 0) / 1e6)),
      medianLatencyMs: percentile(fleet.map((m) => m.latencyMs ?? 0), 50) || 1,
    };
    this.activeCeiling = computeMaxBots(summary, this.cfg);
    if (this.bots.size > this.activeCeiling) await this.#resizeFleet(this.activeCeiling);

    // 2. Per-bot outliers/errors → terminate and replace immediately.
    for (const m of fleet) {
      if (!this.bots.has(m.botId)) continue;
      const verdict = shouldReplace(m, fleet, this.cfg);
      if (verdict.replace) {
        console.warn(`[conductor] replacing bot ${m.botId}: ${verdict.reason}`);
        await this.#stopBot(m.botId);
        if (this.bots.size < this.activeCeiling) await this.#startBot(m.botId);
      }
    }
  }

  // ---------- HTTP (assignments in, metrics back) ----------

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
