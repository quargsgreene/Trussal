/**
 * Single source of truth for runtime configuration.
 *
 * Every knob the admin page exposes (bot count, stratification roles, fps
 * floor, memory ceiling) lives here with its default, so the config API,
 * conductor, and bots can never disagree about defaults. mergeConfig rejects
 * unknown keys to catch typos at the API boundary instead of silently
 * ignoring an operator's setting.
 */

export const STRATIFICATION_ROLES = Object.freeze({
  FREQUENCY_BANDS: 'frequencyBands',
  STAGGERED_ROUND: 'staggeredRound',
  UNISON: 'unison',
  STEREO_TILES: 'stereoTiles',
});

export const defaultConfig = Object.freeze({
  // Network endpoints (spec)
  jitsiUrl: 'http://localhost/0',
  jamulusServer: 'trussal.duckdns.org:22000',

  // Bandwidth guards for self-hosted Jitsi on a home network. Bots are
  // senders: they never need to watch each other, so channelLastN=0 cuts
  // the n×(n-1) download fan-out to zero; the bridge only fans out to
  // human viewers. Send side is capped at 360p / ~800 kbps / 15 fps.
  jitsiChannelLastN: 0,
  jitsiVideoHeight: 360,
  jitsiStartBitrateKbps: 800,
  captureFps: 15,

  // Fleet
  maxBots: 10,           // hard ceiling from the spec; health policy scales DOWN from this
  sessionSeed: 1,        // drives deterministic dog-breed names & random script gen
  varyHydra: false,      // when true, each bot gets its own Hydra visual (deterministic
                         // per bot) instead of all sharing the master script's hydra

  // Stratification roles: non mutually exclusive (spec), so a set of flags
  roles: Object.freeze({
    frequencyBands: false,
    staggeredRound: false,
    unison: true,
    stereoTiles: false,
  }),
  staggerSubdivisions: 1, // subdivisions of WCL used by role 2

  // Health policy thresholds (user-adjustable from the admin page)
  fpsMin: 15,             // below this, fleet scales down
  memLimitMb: 900,        // per-bot RSS ceiling before fleet scales down
  percentileCutoff: 95,   // latency/RAM outlier replacement threshold
  // Absolute floors for percentile replacement: in any fleet with spread,
  // SOMEONE always sits at p95, so without floors the policy perpetually
  // executes the relatively-worst healthy bot. A bot must be ≥p95 AND
  // objectively bad to be replaced.
  replaceLatencyFloorMs: 150,
  replaceRamFloorMb: 400,

  // Conductor internals
  metricsIntervalMs: 2000,
  healthTickMs: 5000,
  conductorPort: 7700,    // bots POST metrics here
  adminPort: 7777,        // admin page, bound 0.0.0.0 so it is reachable outside the VM

  // Fleet service (Net Cycles): per-user bot clusters driven by in-room
  // requests relayed through the latency sidecar.
  sidecarWsUrl: 'ws://localhost:8081/ws', // peer-state bus the fleet listens on
  fleetRoom: '0',                          // room whose requests this fleet serves
  ownerLeaveGraceMs: 120000,               // cluster lives this long (2 min) after its owner leaves, meeting continuing
  meetingEndGraceMs: 15000,                // all humans gone → teardown (XMPP constraints)
  // The aggregator has no health-replace path (its metrics are deliberately
  // kept out of the shouldReplace fleet, since it isn't one of `bots`) — if
  // its container dies on its own (e.g. it lost the sidecar's aggregator-claim
  // race and self-exited, or crashed), aggregatorRunning would otherwise stay
  // stuck true forever, since nothing but an explicit #stopAggregator() call
  // ever clears it. #reapDeadAggregator in fleet-service.js instead treats a
  // long enough silence on its metrics reports as death and respawns it.
  aggregatorStartupGraceMs: 15000,         // no metrics expected before this (docker run + Chromium + Jitsi join)
  aggregatorStaleMs: 8000,                 // silence beyond this, past the startup grace, is treated as dead
});

export function mergeConfig(overrides = {}, base = defaultConfig) {
  const out = { ...base, roles: { ...base.roles } };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in base)) throw new TypeError(`unknown config key: ${key}`);
    if (key === 'roles') {
      for (const [role, on] of Object.entries(value)) {
        if (!(role in base.roles)) throw new TypeError(`unknown role: ${role}`);
        out.roles[role] = Boolean(on);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
