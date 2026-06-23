/**
 * Production entrypoint: conductor + admin/config API in one process. They
 * share the Conductor instance directly (the config API mutates session
 * state through conductor.applyConfig / setMasterScript), so there is no
 * second source of truth to drift.
 */

import { mergeConfig } from '../shared/config.js';
import { Conductor } from './conductor.js';
import { makeDockerRunner } from './docker-runner.js';
import { createAdminServer } from '../config-api/server.js';

const cfg = mergeConfig({
  ...(process.env.MAX_BOTS ? { maxBots: Number(process.env.MAX_BOTS) } : {}),
  ...(process.env.SESSION_SEED ? { sessionSeed: Number(process.env.SESSION_SEED) } : {}),
  ...(process.env.JITSI_URL ? { jitsiUrl: process.env.JITSI_URL } : {}),
  ...(process.env.JAMULUS_SERVER ? { jamulusServer: process.env.JAMULUS_SERVER } : {}),
  ...(process.env.VARY_HYDRA ? { varyHydra: process.env.VARY_HYDRA === 'true' } : {}),
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

const conductor = new Conductor(cfg, { runner });
await conductor.start();
console.log(`[conductor] listening on :${conductor.port}, fleet of ${cfg.maxBots}`);

const admin = createAdminServer(conductor);
admin.listen(cfg.adminPort, '0.0.0.0', () => {
  console.log(`[admin] page on http://0.0.0.0:${cfg.adminPort} (reachable outside the VM)`);
});

const shutdown = async () => {
  admin.close();
  await conductor.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
