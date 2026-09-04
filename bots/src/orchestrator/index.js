/**
 * Production entrypoint: fleet service + admin/config API in one process.
 * The FleetService replaces the conductor as primary orchestrator (per-user
 * bot clusters driven by in-room requests over the sidecar) while keeping
 * the conductor's whole external surface — the admin API mutates session
 * state through fleet.applyConfig / setMasterScript, and /api/bots +
 * /api/config keep serving the external mcp-observer verbatim.
 */

import WebSocket from 'ws';
import { mergeConfig } from '../shared/config.js';
import { FleetService, makeWsSidecarConnector } from './fleet-service.js';
import { makeDockerRunner } from './docker-runner.js';
import { createAdminServer } from '../config-api/server.js';

const cfg = mergeConfig({
  ...(process.env.MAX_BOTS ? { maxBots: Number(process.env.MAX_BOTS) } : {}),
  ...(process.env.SESSION_SEED ? { sessionSeed: Number(process.env.SESSION_SEED) } : {}),
  ...(process.env.JITSI_URL ? { jitsiUrl: process.env.JITSI_URL } : {}),
  ...(process.env.JAMULUS_SERVER ? { jamulusServer: process.env.JAMULUS_SERVER } : {}),
  ...(process.env.VARY_HYDRA ? { varyHydra: process.env.VARY_HYDRA === 'true' } : {}),
  ...(process.env.SIDECAR_WS_URL ? { sidecarWsUrl: process.env.SIDECAR_WS_URL } : {}),
  // Multi-shard: one control connection per shard's own sidecar (the edge LB
  // can't route `?role=control` — it has no room). Comma-separated. Unset =
  // single stack.
  ...(process.env.SIDECAR_CONTROL_URLS
    ? { sidecarControlUrls: process.env.SIDECAR_CONTROL_URLS.split(',').map((s) => s.trim()).filter(Boolean) }
    : {}),
});

const runner = makeDockerRunner({
  env: {
    CONDUCTOR_URL: process.env.CONDUCTOR_URL ?? `http://conductor:${cfg.conductorPort}`,
    JITSI_URL: cfg.jitsiUrl,
    JAMULUS_SERVER: cfg.jamulusServer,
    SESSION_SEED: String(cfg.sessionSeed),
    JITSI_CHANNEL_LAST_N: String(cfg.jitsiChannelLastN),
    JITSI_VIDEO_HEIGHT: String(cfg.jitsiVideoHeight),
    JITSI_START_BITRATE_KBPS: String(cfg.jitsiStartBitrateKbps),
    CAPTURE_FPS: String(cfg.captureFps),
  },
});

const fleet = new FleetService(cfg, {
  runner,
  connectSidecar: makeWsSidecarConnector(WebSocket),
  // Passed as a dependency, never merged into cfg: the admin API serves cfg
  // verbatim on an unauthenticated port (see config-api/server.js).
  controlToken: process.env.FLEET_CONTROL_TOKEN || null,
});
await fleet.start();
const discovery = cfg.sidecarControlUrls && cfg.sidecarControlUrls.length
  ? `${cfg.sidecarControlUrls.length} shards (${cfg.sidecarControlUrls.join(', ')})`
  : cfg.sidecarWsUrl;
console.log(`[fleet] listening on :${fleet.port}, ceiling ${cfg.maxBots}, discovering rooms on ${discovery}`);

const admin = createAdminServer(fleet);
admin.listen(cfg.adminPort, '0.0.0.0', () => {
  console.log(`[admin] page on http://0.0.0.0:${cfg.adminPort} (reachable outside the VM)`);
});

const shutdown = async () => {
  admin.close();
  await fleet.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
