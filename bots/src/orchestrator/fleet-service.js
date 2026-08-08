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
 * The service is MULTI-ROOM. A Trussal room name is free-form, so there is no
 * meaningful room to configure ahead of time; the fleet instead holds one
 * relay-wide control connection (`?role=control`) that names the rooms holding
 * participants, and opens a per-room bus connection for each. Every meeting
 * therefore gets its own aggregator, roster shadow and meeting-end countdown,
 * and bot containers are pointed at their room through JITSI_URL. Every method
 * that acts on a meeting names its room explicitly — there is no configured
 * room and no default (see requireRoom).
 *
 * The container runner and the sidecar socket factory are injected so tests
 * drive the full lifecycle with fakes.
 */

import http from 'node:http';
import { mergeConfig } from '../shared/config.js';
import { breedNameFor } from '../shared/dog-breeds.js';
import { worstCaseLatency, percentile } from '../shared/stats.js';
import { randomMasterScript, validateMasterScript, variationFor } from '../script-gen/index.js';
import { botScriptFor, captureClusterSource, scriptToEditorCode } from '../script-gen/cluster-source.js';
import { defaultBotConfig, flag, parseBotConfig } from '../../../src/bot-config.js';
import { shouldReplace, computeMaxBots } from './health.js';
import { SampleStore } from './sample-store.js';

// Container id for a room's aggregator. Aggregators run outside the per-owner
// cluster id space (never assigned by #nextBotId, never counted against the
// ceiling); one room's aggregator keeps the historical trussal-bot-99999 name
// and further rooms count DOWN from here (see #allocateAggregatorId).
export const AGGREGATOR_BOT_ID = 99999;

// Request header carrying the relay control-channel secret. Hyphenated, not
// underscored: nginx drops underscored headers by default, which would silently
// turn every control connection into an unauthenticated one.
export const CONTROL_TOKEN_HEADER = 'x-trussal-control-token';

// Point a configured Jitsi URL at a different room. The bundle — and the
// aggregator bot, which derives its sidecar/O2/claim URLs the same way — keys
// the room on the URL's LAST path segment, so swapping that segment is exactly
// what moves a container into another meeting.
//
// A trailing slash marks the configured URL as a MOUNT POINT rather than a room
// ("https://host/jitsi/"), so the room is appended instead of replacing the last
// segment. Without that distinction a sub-path deployment has its prefix eaten
// ("https://host/jitsi/" → "https://host/gig") and every bot is pointed outside
// the Jitsi mount and never joins.
export function jitsiUrlForRoom(baseUrl, room) {
  try {
    const url = new URL(baseUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (!url.pathname.endsWith('/')) {
      segments.pop();                     // the configured room, e.g. the "0" in https://host/0
    }
    segments.push(String(room));
    url.pathname = `/${segments.join('/')}`;
    return url.toString();
  } catch {
    return baseUrl; // unparseable config: leave it exactly as the operator set it
  }
}

// Every entry point that acts on one meeting names its room. There is no
// default and no configured room to fall back to: a room name is free-form and
// discovered at runtime, so a fallback would silently redirect containers into
// — or tear down — whatever meeting happened to match the fallback's name
// instead of failing where the mistake is.
function requireRoom(room, where) {
  if (room == null || room === '') throw new TypeError(`${where}: a room name is required`);
  return String(room);
}

// One line a performer can read in their own studio saying what the fleet took
// from their declaration. Every way a botConfig can come to nothing — never
// typed, never sent, rejected — ends in the same visible outcome, a cluster of
// plain copies, and the studio is the only surface the author has: the fleet's
// log lives on a VM they are not looking at while playing.
//
// Only the properties they actually set. A config is mostly nulls by
// construction, so listing all eight would bury the two that matter. Values are
// truncated because `mcp` carries a whole prompt.
export function describeBotConfig(source) {
  if (!source || !source.declared) return 'no botConfig() declared — bots play exact copies';
  const set = Object.entries(source.config ?? {}).filter(([, value]) => value !== null);
  if (!set.length) return 'botConfig() set nothing — bots play exact copies';
  const shown = set.map(([key, value]) => {
    const text = String(value);
    return `${key}=${text.length > 40 ? `${text.slice(0, 39)}…` : text}`;
  });
  return `botConfig applied: ${shown.join(', ')}`;
}

export class FleetService {
  constructor(cfg, { runner, connectSidecar, controlToken = null, compose = null }) {
    if (!runner) throw new TypeError('a container runner {start, stop} is required');
    // Composes a cluster's code from an `mcp` prompt. Injected — and null on a
    // deployment with no model reachable — so the fleet never depends on an LLM
    // being present; a config with `mcp` simply keeps the performer's own code.
    this.compose = compose;
    this.cfg = cfg;
    this.runner = runner;
    this.connectSidecar = connectSidecar || null; // (url, handlers) → { send, close }
    // A dependency, NOT a cfg key: `GET /api/config` serializes cfg wholesale on
    // an unauthenticated port, so a secret stored there would be handed to any
    // caller who can reach :7777 — and `POST /api/config` would let them
    // overwrite it. Keeping it off cfg is what stops the relay's control-channel
    // credential from leaking out of the admin surface.
    this.controlToken = controlToken || null;
    // The fleet-wide fallback master: what a cluster plays when its spawn
    // carried no code, and the palette `random: "full"` draws from. A cluster
    // whose human sent code uses that instead (see #ownerSources).
    this.master = randomMasterScript(cfg.sessionSeed);
    // "<room>\0<ownerIndex>" → { master, config, declared, capturedAt }.
    // One snapshot per human per room, taken when they press spawn: their
    // editor text plus the botConfig(...) it declared. Keyed by room as well as
    // owner because room indices are per-meeting, so index "1" in two rooms is
    // two different people.
    this.ownerSources = new Map();
    // Performers' uploaded samples, for clusters whose config shares them.
    // Held in memory and served on the same :7700 the bots already fetch their
    // assignment from — see sample-store.js for why the bytes travel at all.
    this.samples = new SampleStore();
    this.bots = new Map();     // botId → { botId, room, ownerIndex, name, script, startedAt }
    this.metrics = new Map();  // botId → latest metrics sample
    this.server = null;
    this.port = null;
    this.tick = null;
    this.activeCeiling = cfg.maxBots;

    // The relay-wide control connection that tells us which rooms have people
    // in them. Room names are free-form, so this is the only way to serve more
    // than one configured meeting — see #joinControlBus.
    this.control = null;
    // roomName → per-meeting state (see #roomState). Everything that used to be
    // a single field here is per-room now: one aggregator, one roster shadow,
    // one meeting-end countdown PER MEETING.
    this.rooms = new Map();
    // botId → when diag.jitsiJoined was last observed true, for player bots
    // (the aggregator's equivalent lives on its room state).
    this.botLastJoinedAt = new Map();
    this._nextBotId = 0;
  }

  // ---------- per-room state ----------

  /**
   * Per-meeting state, created on demand the first time a room is heard from.
   * A room's aggregator, roster shadow, owner-teardown timers and meeting-end
   * countdown all belong to one meeting, so they cannot be process-globals the
   * way they were when the fleet served a single configured room.
   */
  #roomState(room) {
    const name = String(room);
    let state = this.rooms.get(name);
    if (!state) {
      state = {
        room: name,
        sidecar: null,
        presentIndices: new Map(), // roomIndex → { isBot, peerId }
        ownerTimers: new Map(),    // ownerIndex → teardown timeout
        meetingEndTimer: null,
        // Cluster indices whose owner declared `retroactive: true` and has since
        // edited their code. Held until that token's own turn comes round, so a
        // bot is never rewritten mid-phrase — see #handlePerformerEdit.
        pendingRelatch: new Set(),
        // One aggregator per room, spawned when the first human is present and
        // torn down with the meeting. Tracked outside `bots` so it never counts
        // against the ceiling or gets health-replaced.
        aggregatorId: null,
        aggregatorRunning: false,
        aggregatorMetrics: null,
        // When this room's aggregator was last confirmed alive: set on a
        // successful start, refreshed by every metrics report.
        // #reapDeadAggregator reads it to tell "hasn't reported yet, still
        // starting up" (age < aggregatorStartupGraceMs) apart from "was alive,
        // has gone silent" (no metrics for aggregatorStaleMs).
        aggregatorStartedAt: null,
        // When diag.jitsiJoined was last observed true (defaults to
        // aggregatorStartedAt at the read site, covering "never yet joined,
        // still within its own startup grace"). A sustained gap since this
        // timestamp — not a single false reading, which a normal ICE reconnect
        // blip can cause — means the bot's Jitsi conference is gone even though
        // the process is alive.
        aggregatorLastJoinedAt: null,
        // Serializes #ensureAggregator/#stopAggregator so a rejoin landing mid-
        // teardown queues behind the in-flight stop instead of racing it.
        // Without this, a rejoin's start() (which force-removes any stale
        // container by name first) can run concurrently with a still-in-flight
        // graceful stop and SIGKILL the old aggregator before its Jitsi leave()
        // completes — a ghost participant that lingers until Jitsi's own
        // presence timeout, alongside the duplicate that just joined.
        aggregatorQueue: Promise.resolve(),
      };
      this.rooms.set(name, state);
    }
    return state;
  }

  // ---------- lifecycle ----------

  async start() {
    await this.#listen();
    if (this.connectSidecar) this.#joinControlBus();
    // One tick at a time. A tick awaits real `docker stop`/`docker run` calls
    // (aggregator reaps, ceiling shrinks, bot replacement) and can easily run
    // longer than healthTickMs, and overlapping ticks would each reap the same
    // room and each shrink against a ceiling the other is still recomputing.
    // Skip rather than queue: every check here is level-triggered, so the next
    // tick re-derives the same conclusion healthTickMs later.
    this.tick = setInterval(() => {
      if (this._ticking) return;
      this._ticking = true;
      this.healthTick()
        .catch(() => {})
        .finally(() => { this._ticking = false; });
    }, this.cfg.healthTickMs);
  }

  async stop() {
    clearInterval(this.tick);
    for (const state of this.rooms.values()) {
      for (const timer of state.ownerTimers.values()) clearTimeout(timer);
      state.ownerTimers.clear();
      if (state.meetingEndTimer) clearTimeout(state.meetingEndTimer);
    }
    // Stop every bot AND every room's aggregator in PARALLEL so the whole fleet
    // leaves within one graceful-stop window (each runner.stop is ~15s), not N
    // of them back to back — the conductor's stop_grace_period has to cover this.
    // allSettled, not all: one bot that fails to stop must NOT abort the teardown
    // of the rest (that would strand bots in the room). Log every outcome so a
    // failed leave is visible in the conductor's logs (the observer reads them).
    const results = await Promise.allSettled([
      ...[...this.bots.keys()].map((id) => this.#stopBot(id)),
      ...[...this.rooms.keys()].map((room) => this.#stopAggregator(room)),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      console.error(`[fleet] teardown: ${failures.length}/${results.length} fleet stops failed:`,
        failures.map((failure) => (failure.reason && failure.reason.message) || failure.reason));
    } else {
      console.log(`[fleet] teardown: all ${results.length} fleet members stopped cleanly`);
    }
    for (const state of this.rooms.values()) {
      if (state.sidecar) { try { state.sidecar.close(); } catch {} state.sidecar = null; }
    }
    if (this.control) { try { this.control.close(); } catch {} this.control = null; }
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  // ---------- sidecar bus ----------

  /**
   * One connection to the relay's control channel (`?role=control`). It replies
   * with the rooms that already hold participants and then announces each new
   * one, which is how the fleet serves whatever meeting people opened: a
   * room name is free-form, so there is nothing to configure ahead of time.
   */
  #joinControlBus() {
    // The relay refuses an unauthenticated control connection outright — it is a
    // directory of every live meeting, on a publicly-proxied path — so the
    // shared secret is not optional. Without it no room is ever discovered and
    // no aggregator spawns; say so at startup rather than looking like a dead
    // socket.
    if (!this.controlToken) {
      console.warn('[fleet] FLEET_CONTROL_TOKEN unset — the relay will refuse room discovery, ' +
        'so no rooms will be served and no aggregator will spawn.');
    }
    const url = `${this.cfg.sidecarWsUrl}?role=control`;
    this.control = this.connectSidecar(url, {
      // In a header rather than the URL — see makeWsSidecarConnector: a query
      // parameter would put the shared secret in nginx's access log.
      headers: this.controlToken ? { [CONTROL_TOKEN_HEADER]: this.controlToken } : null,
      onOpen: () => {},
      onMessage: (msg) => {
        if (msg.type === 'control-denied') {
          console.error('[fleet] the relay REFUSED room discovery — FLEET_CONTROL_TOKEN does not ' +
            'match the sidecar\'s SIDECAR_CONTROL_TOKEN. No aggregator will spawn.');
        } else if (msg.type === 'rooms' && Array.isArray(msg.rooms)) {
          for (const room of msg.rooms) this.attachRoom(room);
        } else if (msg.type === 'room-active' && msg.room != null) {
          this.attachRoom(msg.room);
        }
      },
    });
  }

  /**
   * Start serving `room`: open its peer-state bus connection and route that
   * room's events into this service. Idempotent — the relay re-announces a room
   * on every join, and an already-attached room must not get a second socket.
   * Tests substitute the whole `connectSidecar` factory rather than a
   * per-call connection, so there is no injection seam on this method.
   */
  attachRoom(room) {
    const name = requireRoom(room, 'attachRoom');
    const state = this.#roomState(name);
    if (state.sidecar) return state;
    if (!this.connectSidecar) return state;
    const url = `${this.cfg.sidecarWsUrl}?room=${encodeURIComponent(name)}&role=fleet`;
    state.sidecar = this.connectSidecar(url, {
      onOpen: (send) => send({
        type: 'hello',
        jitsiId: `fleet-${name}`,
        displayName: 'fleet-service',
        isFleet: true
      }),
      onMessage: (msg) => this.handleBusMessage(msg, name).catch((err) => {
        console.error(`[fleet] bus message failed (room ${name}):`, err.message);
      })
    });
    console.log(`[fleet] serving room ${name}`);
    return state;
  }

  /**
   * Stop serving a room once its meeting is over, so idle sockets and dead
   * meeting state don't accumulate for the conductor's whole uptime. Safe
   * against a rejoin that races the teardown: the relay announces the room
   * again on the next join, and the fresh connection's `hello` is answered with
   * a full roster, which #reconcileRoster folds back in.
   */
  #detachRoom(room) {
    const name = String(room);
    const state = this.rooms.get(name);
    if (!state) return;
    // Discard this meeting's pending countdowns along with it. Both capture the
    // room by NAME and re-resolve it when they fire, so a timer that outlived
    // the detach would act on whatever meeting next reuses the name: a stale
    // meetingEndTimer tears down a live room's aggregator and bots, and a stale
    // ownerTimer removes a cluster up to ownerLeaveGraceMs (2 minutes) later.
    for (const timer of state.ownerTimers.values()) clearTimeout(timer);
    state.ownerTimers.clear();
    if (state.meetingEndTimer) { clearTimeout(state.meetingEndTimer); state.meetingEndTimer = null; }
    if (state.sidecar) { try { state.sidecar.close(); } catch {} state.sidecar = null; }
    this.rooms.delete(name);
  }

  // Lookup that never creates. The read/cleanup paths must not resurrect a room
  // that #detachRoom just discarded: a phantom entry has no bus connection, so
  // it can never learn about another join, leave or session-reset, yet healthTick
  // would iterate it forever and roomsStatus() would report it as served.
  #existingRoom(room) {
    return this.rooms.get(String(room));
  }

  #busSend(room, msg) {
    const state = this.rooms.get(String(room));
    if (state && state.sidecar) { try { state.sidecar.send(msg); } catch {} }
  }

  // Exposed for tests (fakes call this directly). The room is REQUIRED: every
  // real caller is a per-room bus connection that knows exactly which meeting
  // the message arrived on.
  async handleBusMessage(msg, room) {
    requireRoom(room, 'handleBusMessage');
    switch (msg.type) {
      case 'roster':
        if (Array.isArray(msg.peers)) this.#reconcileRoster(room, msg.peers);
        break;
      case 'peer-join':
        if (msg.peer) this.#trackPeer(room, msg.peer);
        break;
      case 'peer-leave':
        this.#untrackPeer(room, msg.peerId);
        break;
      case 'fleet-request':
        await this.#handleFleetRequest(room, msg);
        break;
      case 'sample-file': {
        // One of a performer's uploaded samples, forwarded by the relay ahead
        // of their spawn request. Rejections are reported rather than dropped:
        // a sample that never arrived shows up much later as a pattern that
        // plays silence, with nothing to point at.
        const owner = msg.fromIndex != null ? String(msg.fromIndex) : null;
        if (owner == null || typeof msg.data !== 'string') break;
        const res = this.samples.put(room, owner, {
          bank: msg.bank,
          name: msg.name,
          bytes: Buffer.from(msg.data, 'base64'),
        });
        if (!res.ok) {
          this.#busSend(room, {
            type: 'fleet-status', action: 'samples', ownerIndex: owner, reason: res.error,
          });
        }
        break;
      }
      case 'peer-update':
        // A human edited their editor. Only a `retroactive: true` config acts on
        // it; every other edit is left for the next spawn to capture, so a bot
        // keeps playing what its author was playing when it arrived.
        if (msg.patch && typeof msg.patch.pattern === 'string') {
          this.#handlePerformerEdit(room, msg.peerId, msg.patch.pattern);
        }
        break;
      case 'nc-active':
        // The aggregator announcing whose turn is streaming. This is the only
        // turn signal on the bus, and it is what "applies on their next turn"
        // is measured against.
        if (typeof msg.token === 'string') this.#relatchToken(room, msg.token);
        break;
      case 'session-reset': {
        // The relay is authoritative that no real participant remains. Clear
        // the shadow roster instead of trusting it: this branch exists BECAUSE
        // the shadow can be stale (a peer-leave missed during a socket blip),
        // and a ghost human left in it would block the detach in #teardownAll
        // and, worse, keep #evaluateMeetingEnd from ever arming again — pinning
        // the room until a bus reconnect happens to reconcile it.
        const resetState = this.#existingRoom(room);
        if (resetState) resetState.presentIndices.clear();
        // The sidecar broadcasts this when the room becomes fleet-only (every
        // real participant gone) — the meeting is genuinely over, even if a
        // human rejoins fast enough to cancel our own meetingEndGraceMs timer
        // before it fires (see #evaluateMeetingEnd). Without reacting to this
        // directly, old bot clusters (and the old aggregator) would silently
        // carry over into whatever reuses this room name next; a new meeting
        // should start with nothing, and bots should have to be spawned fresh.
        await this.#teardownAll(room, 'session reset — room emptied and reused');
        break;
      }
      default:
        break;
    }
  }

  #trackPeer(room, peer) {
    if (peer.roomIndex == null) return;
    const state = this.#roomState(room);
    const idx = String(peer.roomIndex);
    state.presentIndices.set(idx, { isBot: !!peer.isBot, peerId: peer.peerId });
    // A returning owner cancels their cluster's death sentence.
    if (!peer.isBot && state.ownerTimers.has(idx)) {
      clearTimeout(state.ownerTimers.get(idx));
      state.ownerTimers.delete(idx);
    }
    // A human in the room means there is audio to aggregate.
    if (!peer.isBot) {
      this.#ensureAggregator(room).catch((e) => {
        console.error(`[fleet] failed to start aggregator for room ${room}:`, e.message);
      });
    }
    // A present human cancels any pending meeting-end teardown (recomputed here).
    this.#evaluateMeetingEnd(room);
  }

  #untrackPeer(room, peerId) {
    const state = this.#existingRoom(room);
    if (!state) return;
    for (const [idx, info] of state.presentIndices.entries()) {
      if (info.peerId !== peerId) continue;
      state.presentIndices.delete(idx);
      if (!info.isBot) this.#onOwnerLeft(room, idx);
      return;
    }
  }

  #onOwnerLeft(room, ownerIndex) {
    const state = this.#existingRoom(room);
    if (!state) return;
    if (this.#botsInRoom(room, ownerIndex).length > 0 && !state.ownerTimers.has(ownerIndex)) {
      const t = setTimeout(() => {
        state.ownerTimers.delete(ownerIndex);
        this.removeCluster(ownerIndex, 'all', { reason: 'owner left', room }).catch(() => {});
      }, this.cfg.ownerLeaveGraceMs);
      if (t.unref) t.unref();
      state.ownerTimers.set(ownerIndex, t);
    }
    // Last human gone → the meeting is over; destroy every Puppeteer instance
    // (clusters and the aggregator alike) after the grace period.
    this.#evaluateMeetingEnd(room);
  }

  // The single decision point for meeting-end teardown. Level-triggered on the
  // shadow roster so it is safe to call from any path (peer-leave, roster
  // reconcile, aggregator start): whenever no human remains but the aggregator
  // or a cluster is still up, arm the teardown; a returning human cancels a
  // pending one. XMPP constraints forbid leaving instantly, so the actual fleet
  // leave waits meetingEndGraceMs.
  #evaluateMeetingEnd(room) {
    const state = this.#existingRoom(room);
    if (!state) return;
    const humansPresent = [...state.presentIndices.values()].some((p) => !p.isBot);
    const fleetUp = this.#clusterSize(room) > 0 || state.aggregatorRunning;
    const actions = {
      cancel: () => {                              // a returning human aborts the countdown
        clearTimeout(state.meetingEndTimer);
        state.meetingEndTimer = null;
      },
      arm: () => {                                 // last human gone → start the countdown
        state.meetingEndTimer = setTimeout(() => {
          state.meetingEndTimer = null;
          this.#teardownAll(room, 'meeting ended').catch((err) => {
            console.error('[fleet] meeting-end teardown failed:', err.message);
          });
        }, this.cfg.meetingEndGraceMs);
        if (state.meetingEndTimer.unref) state.meetingEndTimer.unref();
      },
      noop: () => {},
    };
    const decide = () => {
      if (humansPresent && state.meetingEndTimer) return 'cancel';
      if (state.meetingEndTimer && !humansPresent) return 'noop'; // already counting down
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
  #reconcileRoster(room, peers) {
    const state = this.#roomState(room);
    const present = new Set(
      peers.filter((peer) => peer.roomIndex != null).map((peer) => String(peer.roomIndex)),
    );
    const departed = [...state.presentIndices.entries()].filter(([idx]) => !present.has(idx));
    departed.forEach(([idx]) => state.presentIndices.delete(idx));
    const departedOwners = departed.filter(([, info]) => !info.isBot).map(([idx]) => idx);

    peers.forEach((peer) => this.#trackPeer(room, peer));
    departedOwners.forEach((idx) => this.#onOwnerLeft(room, idx));
  }

  async #handleFleetRequest(room, msg) {
    const ownerIndex = msg.fromIndex != null ? String(msg.fromIndex) : null;
    if (ownerIndex == null) return;
    if (msg.action === 'spawn') {
      const count = Math.max(0, Math.floor(Number(msg.count) || 0));
      // Snapshot the requester's editor before starting anything: this is the
      // master their cluster plays and the botConfig(...) that shapes it. A
      // config that fails to parse is surfaced to every studio rather than
      // swallowed — the performer typed it expecting it to take effect.
      const captured = this.#captureOwnerSource(room, ownerIndex, msg.code);
      // Both of these ride WITH the spawn's own status rather than as messages
      // of their own. Sent separately they were true but invisible: the studio
      // keeps the last fleet-status it saw, and spawnCluster's "spawned 2/2"
      // landed a moment later and replaced them — so a rejected config looked
      // exactly like a config that took, which is the whole difficulty of
      // debugging one. `reason` stays what went wrong; `botConfig` is the
      // running commentary that is worth saying even when nothing did.
      const notes = captured.ok ? [] : [captured.error];
      const configNote = captured.ok ? describeBotConfig(captured.source) : null;
      // An `mcp` prompt is composed before any container starts, so every bot
      // in the cluster boots with the finished code rather than starting on the
      // palette and being rewritten a moment later.
      const composed = await this.#composeOwnerSource(room, ownerIndex, captured.source);
      if (composed && !composed.ok) {
        notes.push(`mcp prompt fell back to the built-in palette — ${composed.error}`);
      }
      await this.spawnCluster(ownerIndex, count, { room, notes, configNote });
    } else if (msg.action === 'remove') {
      await this.removeCluster(ownerIndex, msg.targets ?? 'all', { reason: 'owner request', room });
    } else if (msg.action === 'removeOne') {
      await this.removeOneBot(ownerIndex, msg.targets, { reason: 'owner request', room });
    }
  }

  // ---------- clusters ----------

  // Clusters are scoped to a room as well as an owner: the same owner index
  // ('1') exists independently in every concurrent meeting, so an unscoped
  // lookup would let one room's spawn/remove reach into another's bots.
  #botsInRoom(room, ownerIndex = null) {
    const name = String(room);
    return [...this.bots.values()].filter((b) =>
      b.room === name && (ownerIndex === null || b.ownerIndex === ownerIndex));
  }

  #clusterSize(room) {
    return this.#botsInRoom(room).length;
  }

  // Lowest cluster ordinal not currently held by one of this owner's bots IN
  // THIS ROOM. Mirrors the sidecar's lowestFreeBotOrdinal, which is likewise
  // per-room: bot suffixes gap-refill, so a removed bot's suffix is reused by
  // the next spawn rather than climbing. The bot being started is added to
  // `bots` by the caller AFTER this returns, so it never counts itself.
  #lowestFreeOrdinal(room, ownerIndex) {
    const prefix = String(ownerIndex);
    const used = new Set();
    for (const b of this.#botsInRoom(room, ownerIndex)) {
      used.add(ordinalForSuffix(b.clusterIndex.slice(prefix.length)));
    }
    let ordinal = 0;
    while (used.has(ordinal)) ordinal++;
    return ordinal;
  }

  /**
   * Spawn `count` bots on ownerIndex's behalf in `room`. Health measures may
   * interrupt: the active ceiling caps the total fleet ACROSS rooms (it is a
   * VM-wide resource budget, derived from fps/RAM), and a partial spawn reports
   * why.
   *
   * `notes` is what else went wrong on the way here (a rejected botConfig, an
   * mcp prompt that fell back); `configNote` is what the config parsed to, said
   * even when it parsed fine. Both travel in this one status because the studio
   * shows the last fleet-status only.
   */
  async spawnCluster(ownerIndex, count, { room, notes = [], configNote = null } = {}) {
    requireRoom(room, 'spawnCluster');
    const headroom = Math.max(0, this.activeCeiling - this.bots.size);
    const toSpawn = Math.min(count, headroom);
    for (let i = 0; i < toSpawn; i++) {
      const botId = this.#nextBotId();
      await this.#startBot(botId, room, ownerIndex);
    }
    const reason = notes.filter(Boolean);
    if (toSpawn < count) {
      reason.push(`host ceiling ${this.activeCeiling} reached — ${this.bots.size} bots running across all rooms`);
    }
    const status = {
      type: 'fleet-status',
      action: 'spawn',
      ownerIndex,
      requested: count,
      spawned: toSpawn,
      // The room's OWN cluster size — this goes to one room's studio, where a
      // count that silently included other meetings' bots is just wrong.
      fleetSize: this.#clusterSize(room),
      ceiling: this.activeCeiling,
      // What the requester's botConfig came to. Its own field, not folded into
      // `reason`: a config that applied cleanly is not a problem report, and
      // `reason` is what the studio and the sidecar's log both read as one.
      ...(configNote ? { botConfig: configNote } : {}),
      // The ceiling is a VM-wide resource budget shared by every meeting, so
      // say so: otherwise a user whose room holds two bots is told "ceiling 10
      // reached" with nothing in their room to explain it.
      ...(reason.length ? { reason: reason.join(' — ') } : {})
    };
    this.#busSend(room, status);
    return status;
  }

  /**
   * Remove targets ('all' or an array of cluster indices like ['1a','1c'])
   * from ownerIndex's own cluster in `room` only.
   */
  async removeCluster(ownerIndex, targets, { reason = '', room } = {}) {
    requireRoom(room, 'removeCluster');
    const mine = this.#botsInRoom(room, ownerIndex);
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
      fleetSize: this.#clusterSize(room),
      ...(reason ? { reason } : {})
    };
    this.#busSend(room, status);
    return status;
  }

  // Remove a single bot from ownerIndex's cluster by its cluster index (e.g.
  // '1a') — the one index a bot row's × button sends (in `targets`). Delegates
  // to removeCluster's owner-scoped, null-safe subset path: at most one target
  // is honored, an unmatched one removes nothing (removed: 0) rather than
  // throwing, and the freed suffix gap-refills on the next spawn.
  async removeOneBot(ownerIndex, targets, { reason = '', room } = {}) {
    requireRoom(room, 'removeOneBot');
    const one = Array.isArray(targets) ? targets.slice(0, 1) : [];
    return this.removeCluster(ownerIndex, one, { reason, room });
  }

  async #teardownAll(room, reason) {
    for (const bot of this.#botsInRoom(room)) await this.#stopBot(bot.botId);
    await this.#stopAggregator(room);
    // Meeting over: this room's bots are gone, so its derived suffixes reset
    // with them — the next meeting to reuse this name starts fresh at 0a.
    this.#busSend(room, { type: 'fleet-status', action: 'teardown', removed: 'all', reason });
    // Re-read the room only now: a rejoin can land while the stops above are in
    // flight (they await real `docker stop` calls), and that rejoin legitimately
    // starts a fresh aggregator behind the same queue. Detaching on the stale
    // "no one is here" reading would throw away the state of a meeting that just
    // came back to life. Give up the room only when it is still empty afterwards
    // — the relay re-announces it the moment anyone joins again (#detachRoom).
    const state = this.rooms.get(String(room));
    if (!state) return;
    const humansPresent = [...state.presentIndices.values()].some((p) => !p.isBot);
    if (humansPresent || state.aggregatorRunning || this.#clusterSize(room) > 0) return;
    this.#detachRoom(room);
  }


  // ---------- aggregator (one per room, outside the cluster id space) ----------

  // Chains `op` onto aggregatorQueue so it runs only after every previously
  // queued start/stop has fully settled — see the aggregatorQueue comment in
  // the constructor. `op` is used as both the fulfilled and rejected handler
  // so a failed op (e.g. runner.stop() throwing) doesn't permanently wedge the
  // queue for whatever's chained after it; the immediate caller still observes
  // the rejection via the returned promise.
  #queueAggregatorOp(room, op) {
    const state = this.#existingRoom(room);
    if (!state) return Promise.resolve();
    state.aggregatorQueue = state.aggregatorQueue.then(op, op);
    return state.aggregatorQueue;
  }

  /**
   * Container id for a room's aggregator, held for as long as that aggregator
   * runs and released on stop. The first room to need one gets
   * AGGREGATOR_BOT_ID (keeping the familiar trussal-bot-99999 container) and
   * concurrent rooms count down from it. Player ids climb from 0 and are capped
   * by activeCeiling — which computeMaxBots only ever scales DOWN from
   * cfg.maxBots (10 by default) — so the ascending and descending ranges cannot
   * meet, and no two live containers can ever share a docker name.
   */
  #allocateAggregatorId() {
    const taken = new Set(
      [...this.rooms.values()].map((s) => s.aggregatorId).filter((id) => id != null),
    );
    let id = AGGREGATOR_BOT_ID;
    while (taken.has(id)) id--;
    return id;
  }

  async #ensureAggregator(room) {
    return this.#queueAggregatorOp(room, async () => {
      const state = this.#existingRoom(room);
      if (!state || state.aggregatorRunning) return;
      state.aggregatorRunning = true; // set first so concurrent joins don't double-spawn
      const botId = state.aggregatorId ?? this.#allocateAggregatorId();
      state.aggregatorId = botId;
      try {
        // JITSI_URL is what puts the container in THIS meeting: the aggregator
        // bot derives its Jitsi room, sidecar claim, metaprogram bus and O2
        // relay URLs from the last path segment, so pointing it at the room is
        // the whole of what makes it room-agnostic.
        await this.runner.start(botId, {
          BOT_ROLE: 'aggregator',
          JITSI_URL: jitsiUrlForRoom(this.cfg.jitsiUrl, room),
        });
        state.aggregatorStartedAt = Date.now();
      } catch (err) {
        state.aggregatorRunning = false;
        state.aggregatorId = null;
        console.error(`[fleet] failed to start aggregator for room ${room}:`, err.message);
      }
    });
  }

  async #stopAggregator(room) {
    return this.#queueAggregatorOp(room, async () => {
      const state = this.#existingRoom(room);
      if (!state || !state.aggregatorRunning) return;
      const botId = state.aggregatorId;
      state.aggregatorRunning = false;
      state.aggregatorMetrics = null;
      state.aggregatorStartedAt = null;
      state.aggregatorLastJoinedAt = null;
      try {
        await this.runner.stop(botId);
      } finally {
        // Release the container id only once the container is really gone. The
        // aggregatorQueue is PER ROOM, so another room's #ensureAggregator runs
        // concurrently with this stop; #allocateAggregatorId hands out any id no
        // room claims, and runner.start() begins with `docker rm -f` on that
        // name. Freeing the id before `docker stop -t 15` returns would let the
        // other room SIGKILL this container mid-leave() — precisely the ghost
        // XMPP session the queue exists to prevent, and it would then reap the
        // other room's brand-new container with its own trailing `docker rm -f`.
        state.aggregatorId = null;
      }
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
  async #reapDeadAggregator(room) {
    const state = this.#existingRoom(room);
    if (!state || !state.aggregatorRunning) return;
    const age = Date.now() - (state.aggregatorStartedAt || 0);
    if (age < this.cfg.aggregatorStartupGraceMs) return; // hasn't had a chance to report yet

    const lastMetricsAt = state.aggregatorMetrics ? state.aggregatorMetrics.receivedAt : state.aggregatorStartedAt;
    const metricsStaleMs = Date.now() - lastMetricsAt;
    const metricsStale = metricsStaleMs >= this.cfg.aggregatorStaleMs;

    const lastJoinedAt = state.aggregatorLastJoinedAt || state.aggregatorStartedAt;
    const orphanedMs = Date.now() - lastJoinedAt;
    const orphaned = orphanedMs >= this.cfg.jitsiJoinGraceMs;

    if (!metricsStale && !orphaned) return; // alive and either reporting or genuinely still joined
    const reason = metricsStale
      ? `metrics stale for ${metricsStaleMs}ms`
      : `orphaned from its Jitsi conference for ${orphanedMs}ms (room likely destroyed/ended)`;
    console.warn(`[fleet] aggregator for room ${room} ${reason}; reaping and respawning`);
    await this.#stopAggregator(room);
    const humansPresent = [...state.presentIndices.values()].some((p) => !p.isBot);
    if (humansPresent) await this.#ensureAggregator(room);
  }

  /**
   * Aggregator liveness + latest sample for one room, for observability (not
   * health). Name the room: roomsStatus() is the accessor for "what is the
   * fleet serving", and answering that from a guessed default is what made the
   * old single-room accessor useless once rooms became dynamic.
   */
  aggregatorStatus(room) {
    const state = this.rooms.get(requireRoom(room, 'aggregatorStatus'));
    if (!state) return { running: false, metrics: null };
    return { running: state.aggregatorRunning, metrics: state.aggregatorMetrics ?? null };
  }

  /** Every room this fleet is currently serving, with its aggregator status. */
  roomsStatus() {
    return [...this.rooms.values()].map((state) => ({
      room: state.room,
      aggregatorId: state.aggregatorId,
      aggregatorRunning: state.aggregatorRunning,
      participants: state.presentIndices.size,
      bots: this.#clusterSize(state.room),
    }));
  }

  #nextBotId() {
    while (this.bots.has(this._nextBotId)) this._nextBotId++;
    return this._nextBotId++;
  }

  // The room whose aggregator currently holds this container id, or null when
  // no live room claims it.
  #roomForAggregatorId(botId) {
    for (const state of this.rooms.values()) {
      if (state.aggregatorId != null && state.aggregatorId === botId) return state;
    }
    return null;
  }

  async #startBot(botId, room, ownerIndex) {
    const clusterOrdinal = this.#lowestFreeOrdinal(room, ownerIndex);
    this.bots.set(botId, {
      botId,
      room: String(room),
      ownerIndex,
      // Mirror of the sidecar-assigned index. Authoritative assignment happens
      // at the bot's hello; both sides pick the lowest cluster ordinal not held
      // by a live bot of this owner (gap-refill), so the SET of suffixes agrees
      // — the fleet is the only spawner for this owner.
      clusterIndex: `${ownerIndex}${suffixFor(clusterOrdinal)}`,
      name: breedNameFor(botId, this.cfg.sessionSeed),
      script: null,
      startedAt: Date.now(),
    });
    // After the record is stored, not inside it: the script is derived from this
    // bot's own owner and cluster position, which #variationFor reads back out
    // of the map. Computed in the object literal it would look itself up before
    // the entry existed and silently fall back to the fleet-wide master.
    const script = this.#variationFor(botId, room);
    this.bots.get(botId).script = script;
    // The code the container is about to boot with, once — this is the only
    // place it can be read before the bot fetches its assignment, and "the
    // config parsed but the bot plays the plain master" is a different bug from
    // "the config never parsed". Logged per bot because the shaping (harmony
    // voicing, colour position) is measured along the cluster: two bots of the
    // same owner SHOULD differ here.
    const bot = this.bots.get(botId);
    console.log(`[fleet] bot ${botId} (${bot.clusterIndex}) boots with:\n` +
      `  strudel: ${JSON.stringify(script.strudel)}\n` +
      `  hydra:   ${JSON.stringify(script.hydra)}`);
    try {
      await this.runner.start(botId, {
        BOT_OWNER_INDEX: ownerIndex,
        // Same as the aggregator: the room a player bot joins is carried purely
        // by the URL's last path segment.
        JITSI_URL: jitsiUrlForRoom(this.cfg.jitsiUrl, room),
      });
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

  // Scoped to the bot's OWN room. botCount and wclMs shape the generated
  // pattern — frequency bands are carved into botCount slices, stereoTiles
  // renders a botCount-wide composite, gain is staged for botCount sources —
  // so folding in another meeting's bots would detune and mis-tile a room for
  // reasons no one in it can see or fix.
  // Which room index a peerId belongs to, from the roster shadow. peer-update
  // carries only a peerId, but everything about clusters is keyed by index.
  #indexForPeerId(room, peerId) {
    const state = this.#existingRoom(room);
    if (!state || peerId == null) return null;
    for (const [index, entry] of state.presentIndices) {
      if (entry.peerId === peerId) return { index, isBot: !!entry.isBot };
    }
    return null;
  }

  /**
   * A human changed their editor text.
   *
   * The config that governs is the one they just typed, not the one their
   * cluster was built with: setting `retroactive: true` is itself an edit, and
   * it has to be able to take effect on the edit that introduces it. Every
   * other edit is ignored here — the next spawn captures current code anyway,
   * so a non-retroactive edit needs no bookkeeping.
   *
   * Re-latching is deferred, never immediate: the bots are mid-phrase. Each is
   * marked and picks the new script up when its own token next takes a turn.
   */
  #handlePerformerEdit(room, peerId, code) {
    const who = this.#indexForPeerId(room, peerId);
    if (!who || who.isBot) return;

    const parsed = parseBotConfig(code);
    if (!parsed.ok || !flag(parsed.config.retroactive)) return;

    this.#captureOwnerSource(room, who.index, code);
    const state = this.#existingRoom(room);
    if (!state) return;
    for (const bot of this.#botsInRoom(room)) {
      if (bot.ownerIndex === who.index) state.pendingRelatch.add(bot.clusterIndex);
    }
  }

  /**
   * The aggregator says `token` is taking its turn. If that token belongs to a
   * bot waiting on a retroactive update, this is the moment it was waiting for:
   * rebuild its script from its owner's current snapshot and drive the bot's
   * REPL through the same remote-control path a human's edit uses.
   */
  #relatchToken(room, token) {
    const state = this.#existingRoom(room);
    if (!state || !state.pendingRelatch.has(token)) return;
    state.pendingRelatch.delete(token);

    const bot = this.#botsInRoom(room).find((b) => b.clusterIndex === token);
    if (!bot) return;

    bot.script = this.#variationFor(bot.botId, room);
    const target = state.presentIndices.get(token);
    if (!target || !target.peerId) return;

    this.#busSend(room, {
      type: 'remote-control',
      targetPeerId: target.peerId,
      action: 'pattern',
      code: scriptToEditorCode(bot.script),
    });
  }

  // Key for one human's snapshot. Room indices are assigned per meeting, so the
  // room has to be part of the identity or two rooms' "1" would share a cluster
  // source. NUL separates because it cannot occur in a room name, so no name
  // can be crafted that collides with another room's key.
  #ownerSourceKey(room, ownerIndex) {
    return `${room}\u0000${ownerIndex}`;
  }

  /**
   * Snapshot a human's editor + botConfig for their cluster. Called on spawn,
   * and again for a `retroactive: true` config, which is the only thing that
   * re-captures — otherwise a bot keeps playing what its author was playing
   * when it arrived.
   */
  #captureOwnerSource(room, ownerIndex, code) {
    const captured = captureClusterSource(code, {
      fallbackMaster: this.master,
      seed: this.cfg.sessionSeed,
    });
    this.ownerSources.set(this.#ownerSourceKey(room, ownerIndex), captured.source);
    // The last of the three botConfig prints (the browser logs what it sent,
    // the relay logs whether `code` survived the hop). Every way this can go
    // wrong ends in the same visible outcome — a cluster of plain copies — so
    // name which one happened: no code arrived, a code with no declaration, a
    // declaration that was rejected, or a config that took.
    const chars = typeof code === 'string' ? code.length : 0;
    if (!chars) {
      console.log(`[fleet] ${room}/${ownerIndex} spawn carried NO code — falling back to the fleet master`);
    } else if (!captured.ok) {
      console.warn(`[fleet] ${room}/${ownerIndex} spawn: ${captured.error} — cluster falls back to exact copies`);
    } else if (!captured.source.declared) {
      console.log(`[fleet] ${room}/${ownerIndex} spawn: ${chars} chars, no botConfig() declared — exact copies`);
    } else {
      console.log(`[fleet] ${room}/${ownerIndex} spawn: ${chars} chars, botConfig`,
        JSON.stringify(captured.source.config));
    }
    return captured;
  }

  /**
   * Replace a snapshot's master with model-composed code, for a config that
   * carries an `mcp` prompt.
   *
   * Awaited on the spawn path and nowhere else. A rotation slot is a few
   * seconds and a model round-trip is not reliably shorter, so generation never
   * sits on a turn boundary — a retroactive edit reuses whatever was composed
   * at spawn rather than re-prompting mid-set.
   *
   * Failure is reported and survivable: composeScript always returns a script,
   * falling back to the palette, so a cluster spawns either way.
   */
  async #composeOwnerSource(room, ownerIndex, source) {
    const prompt = source?.config?.mcp;
    if (!prompt || !this.compose) return null;

    const result = await this.compose({
      prompt,
      master: source.master,
      seed: this.cfg.sessionSeed,
    }).catch((err) => ({ ok: false, source: 'palette', error: String(err.message || err) }));

    if (result.script) source.master = result.script;
    return result;
  }

  // The snapshot a bot's script is built from, or a default one wrapping the
  // fleet-wide master for a cluster that never sent code.
  #ownerSource(room, ownerIndex) {
    return this.ownerSources.get(this.#ownerSourceKey(room, ownerIndex))
      ?? { master: this.master, config: defaultBotConfig(), declared: false };
  }

  // A bot's ordinal within its OWN cluster, which is what harmony voicings and
  // colour schemes are spread along. Derived from the cluster suffix the bot was
  // assigned ('1a' → 0, '1b' → 1) so it survives a bot being replaced.
  #clusterOrdinalOf(bot) {
    const suffix = String(bot.clusterIndex ?? '').slice(String(bot.ownerIndex ?? '').length);
    if (!/^[a-z]+$/.test(suffix)) return 0;
    let ordinal = 0;
    for (const ch of suffix) ordinal = ordinal * 26 + (ch.charCodeAt(0) - 96);
    return ordinal - 1;
  }

  #variationFor(botId, room) {
    const m = this.metrics.get(botId);
    const roomBots = this.#botsInRoom(room);
    const latencies = roomBots
      .map((b) => this.metrics.get(b.botId))
      .filter(Boolean)
      .map((x) => x.latencyMs)
      .filter((x) => x >= 0);

    const bot = this.bots.get(botId);
    const ownerIndex = bot?.ownerIndex ?? null;
    const source = ownerIndex != null ? this.#ownerSource(room, ownerIndex) : null;
    const cluster = ownerIndex != null
      ? roomBots.filter((b) => b.ownerIndex === ownerIndex)
      : roomBots;

    // What this bot plays: its human's snapshot shaped by their botConfig, or
    // the fleet-wide master when they never sent code. varyHydra stays an
    // admin-side override of the visual only, as before.
    const configured = source && bot
      ? botScriptFor(source, {
        index: this.#clusterOrdinalOf(bot),
        count: Math.max(1, cluster.length || 1),
        seed: this.cfg.sessionSeed,
        botId,
      })
      : this.master;

    const master = this.cfg.varyHydra
      ? {
        strudel: configured.strudel,
        hydra: randomMasterScript(this.cfg.sessionSeed + botId + 1).hydra,
        announceStrudel: configured.announceStrudel,
      }
      : configured;
    return variationFor(botId, master, {
      // The bot being started is not yet in `bots` (see #startBot), matching the
      // previous single-room behaviour where it did not count itself either.
      botCount: Math.max(1, roomBots.length || 1),
      roles: this.cfg.roles,
      wclMs: latencies.length ? worstCaseLatency(latencies) : 0,
      latencyMs: m?.latencyMs ?? 0,
      jitterMs: m?.jitterMs ?? 0,
      staggerSubdivisions: this.cfg.staggerSubdivisions,
    });
  }

  #redistribute() {
    for (const bot of this.bots.values()) bot.script = this.#variationFor(bot.botId, bot.room);
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
    const hit = new Map(); // room → how many of its bots the ceiling took
    for (const id of ids) {
      if (this.bots.size <= target) break;
      const room = this.bots.get(id)?.room;
      await this.#stopBot(id);
      if (room != null) hit.set(room, (hit.get(room) ?? 0) + 1);
    }
    // The ceiling is VM-wide and newest-first, so a shrink driven by ONE busy
    // meeting routinely deletes a different meeting's bots. #stopBot is silent,
    // so without this the other room's studio just shows bots disappearing from
    // myClusterBots() with no explanation anywhere.
    for (const [room, removed] of hit) {
      this.#busSend(room, {
        type: 'fleet-status',
        action: 'remove',
        removed,
        fleetSize: this.#clusterSize(room),
        reason: `host ceiling ${target} reached — bots reduced across all rooms`,
      });
    }
  }

  /** Same shape createAdminServer/mcp-observer already consume, plus cluster fields. */
  listBots() {
    return [...this.bots.values()].map((b) => ({
      botId: b.botId,
      name: b.name,
      room: b.room,
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
    // aggregator (no clusters spawned yet), and this check must still run —
    // for every room being served, since each has its own aggregator. Snapshot
    // the keys first: reaping a room can add or remove entries mid-iteration.
    // In PARALLEL, for the same reason stop() is: a reap awaits `docker stop -t
    // 15` plus a `docker run`, so serialising three stale rooms would stall the
    // whole tick — including the ceiling recomputation and bot replacement
    // below — for a minute, while setInterval keeps firing fresh ticks into it.
    // allSettled so one room's failed reap cannot abort the others'.
    await Promise.allSettled([...this.rooms.keys()].map((room) => this.#reapDeadAggregator(room)));

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
        const { ownerIndex, room } = existing;
        await this.#stopBot(m.botId);
        if (this.bots.size < this.activeCeiling) await this.#startBot(m.botId, room, ownerIndex);
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
      return send(200, {
        script: bot.script,
        botCount: this.bots.size,
        // The owner's uploaded samples, as bank → [path]. Empty unless their
        // botConfig asked to share them; the bot registers whatever is here
        // with Strudel under the same folder names their own code uses, so
        // s("mykit") means the same thing in both editors.
        //
        // Paths, not absolute URLs: how a bot addresses this service is the
        // bot's own CONDUCTOR_URL, which the fleet has no way to know (it is
        // "localhost:7700" from a host-networked container and something else
        // from anywhere else). The bot resolves them against its own base.
        samples: this.samples.manifestFor(bot.room, bot.ownerIndex),
      });
    }

    // Sample bytes for a bot that just read the manifest above. Bots are
    // host-networked on this VM, so this never leaves localhost.
    const sample = req.url.match(/^\/samples\/([^/]+)\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (req.method === 'GET' && sample) {
      const [, room, owner, bank, name] = sample.map(decodeURIComponent);
      const file = this.samples.get(room, owner, bank, name);
      if (!file) return send(404, { error: 'unknown sample' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': file.bytes.length,
      });
      return res.end(file.bytes);
    }

    if (req.method === 'POST' && req.url === '/metrics') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const m = JSON.parse(raw);
          // The aggregator reports too, but it lives outside the fleet: keep its
          // sample out of the health summary (percentiles/replacement) — just
          // record it for observability, against the room whose aggregator id
          // it reports (bot.sampleMetrics always carries botId). A sample from
          // an id no room claims is a container the fleet already reaped and
          // hasn't finished dying; dropping it keeps a zombie from refreshing a
          // live room's liveness clock.
          if (m.role === 'aggregator') {
            const state = this.#roomForAggregatorId(m.botId);
            if (!state) {
              // Almost always a container that outlived the fleet that started
              // it (a conductor restart), still reporting into the void. Say so
              // — swallowing it silently hides a running orphan nothing owns.
              console.warn(`[fleet] aggregator metrics from unclaimed container ${m.botId} ` +
                '— an orphaned aggregator is still running; `docker rm -f trussal-bot-' + m.botId + '`');
              return send(200, { ok: true });
            }
            state.aggregatorMetrics = { ...m, receivedAt: Date.now() };
            if (m.diag && m.diag.jitsiJoined) state.aggregatorLastJoinedAt = Date.now();
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
  return (url, { onOpen, onMessage, headers = null }) => {
    let ws = null;
    let closed = false;
    // Last failure reported for this socket. Both handlers below used to
    // swallow everything they caught, which is how a fleet bus that never
    // connects — or a roster that never parses — produced a room with no
    // aggregator and NOTHING in the log to say why. Reconnection is every 2s,
    // so repeats are collapsed: the first failure is reported, and after that
    // only a change of failure or a recovery.
    let lastFailure = null;
    const reportFailure = (where, err) => {
      const message = `${where}: ${(err && err.message) || err}`;
      if (message === lastFailure) return;
      lastFailure = message;
      console.error(`[fleet] sidecar socket ${url} — ${message}`);
    };
    const open = () => {
      // Headers, not query parameters, carry the control token: nginx's default
      // log format records the full request line, so a secret in the URL is
      // written to the video VM's access log on every (re)connect — and this
      // socket reconnects every 2s while the relay is down. Only the Node
      // conductor opens this channel, so nothing forces it into the query
      // string the way a browser WebSocket would.
      ws = headers ? new WebSocketImpl(url, { headers }) : new WebSocketImpl(url);
      ws.on('open', () => {
        if (lastFailure) {
          console.log(`[fleet] sidecar socket ${url} — recovered`);
          lastFailure = null;
        }
        onOpen((msg) => ws.send(JSON.stringify(msg)));
      });
      ws.on('message', (data) => {
        // A bus message that cannot be parsed or handled is a room whose
        // roster, joins and leaves are silently not arriving — the aggregator
        // simply never spawns. Report it instead of dropping it on the floor.
        try {
          onMessage(JSON.parse(data.toString()));
        } catch (err) {
          reportFailure('message handling failed', err);
        }
      });
      ws.on('close', () => { if (!closed) setTimeout(open, 2000); });
      ws.on('error', (err) => {
        reportFailure('connection failed', err);
        try { ws.close(); } catch (e) { reportFailure('close after error failed', e); }
      });
    };
    open();
    return {
      send: (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      close: () => { closed = true; try { ws.close(); } catch {} }
    };
  };
}
