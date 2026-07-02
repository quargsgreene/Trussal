/**
 * Container entrypoint for one bot. Everything arrives via environment
 * variables (set by docker-compose / the conductor) because a container
 * restart must reproduce the bot exactly.
 *
 * The bot fetches its script from the conductor (not from env) so a replaced
 * bot always gets the CURRENT master variation, then starts the metrics
 * report loop. Latency is measured as the HTTP round-trip of each metrics
 * POST — the same path Jamulus audio takes off-box, and free of extra ping
 * infrastructure.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { Bot } from './bot.js';
import { ffmpegBedArgs } from './ffmpeg-bed.js';
import { jamulusArgs, jamulusIniContent } from './jamulus.js';
import { breedNameFor } from '../shared/dog-breeds.js';
import { gainForBotCount } from '../shared/audio-math.js';
import { frequencyBand } from '../script-gen/variation.js';

const env = (key, fallback) => process.env[key] ?? fallback;

const botId = Number(env('BOT_ID', '0'));
const sessionSeed = Number(env('SESSION_SEED', '1'));
const conductorUrl = env('CONDUCTOR_URL', 'http://conductor:7700');
const jitsiUrl = env('JITSI_URL', 'http://localhost/0');
const jamulusServer = env('JAMULUS_SERVER', 'trussal.duckdns.org:22000');
const executablePath = env('CHROMIUM_PATH', '/usr/bin/chromium');
const metricsIntervalMs = Number(env('METRICS_INTERVAL_MS', '2000'));

const name = breedNameFor(botId, sessionSeed);

async function fetchAssignment() {
  const res = await fetch(`${conductorUrl}/assignment/${botId}`);
  if (!res.ok) throw new Error(`conductor refused assignment: ${res.status}`);
  return res.json(); // { script: {strudel, hydra, entryDelayMs}, botCount }
}

function startSidecars(botCount) {
  const { lo, hi } = frequencyBand(botId % botCount, botCount);
  const bed = spawn('ffmpeg', ffmpegBedArgs({
    loFreq: Math.round(lo),
    hiFreq: Math.round(hi),
    gain: gainForBotCount(botCount),
    // Set by the entrypoint to this bot's own loopback subdevice.
    alsaDevice: env('ALSA_PLAYBACK_DEVICE', 'plughw:Loopback,0,0'),
  }), { stdio: 'inherit' });
  // Debian's jamulus package installs the binary as capital-J "Jamulus".
  const iniFile = `/tmp/jamulus-bot-${botId}.ini`;
  writeFileSync(iniFile, jamulusIniContent(name));
  const jamulus = spawn('Jamulus', jamulusArgs({ server: jamulusServer, name, iniFile }), { stdio: 'inherit' });
  for (const proc of [bed, jamulus]) {
    proc.on('error', (err) => {
      // Missing binary/spawn failure: exit loudly (conductor replace policy)
      // instead of letting the unhandled 'error' event produce a bare crash.
      console.error(`[bot ${botId}] sidecar failed to start:`, err.message);
      process.exit(1);
    });
  }
  return [bed, jamulus];
}

async function main() {
  const { script, botCount } = await fetchAssignment();
  const sidecars = startSidecars(botCount);
  const bandwidth = {
    channelLastN: Number(env('JITSI_CHANNEL_LAST_N', '0')),
    videoHeight: Number(env('JITSI_VIDEO_HEIGHT', '360')),
    startBitrateKbps: Number(env('JITSI_START_BITRATE_KBPS', '800')),
    captureFps: Number(env('CAPTURE_FPS', '15')),
  };
  const ownerIndex = env('BOT_OWNER_INDEX', '');
  const bot = new Bot({ botId, name, jitsiUrl, script, executablePath, bandwidth, ownerIndex }, { launcher: puppeteer });
  await bot.start();

  let lastLatencyMs = 0;
  let jitterMs = 0;
  setInterval(async () => {
    try {
      const m = await bot.sampleMetrics();
      const t0 = Date.now();
      await fetch(`${conductorUrl}/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...m, latencyMs: lastLatencyMs, jitterMs }),
      });
      const newLatency = Date.now() - t0;
      // RFC 3550 running jitter: J += (|D| - J) / 16
      jitterMs = jitterMs + (Math.abs(newLatency - lastLatencyMs) - jitterMs) / 16;
      lastLatencyMs = newLatency;
    } catch (err) {
      console.error(`[bot ${botId}] metrics report failed:`, err.message);
    }
  }, metricsIntervalMs);

  const shutdown = async () => {
    sidecars.forEach((p) => p.kill('SIGTERM'));
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // A bot that cannot start must die loudly: the conductor sees the container
  // exit and applies the replacement policy.
  console.error(`[bot ${botId}] fatal:`, err);
  process.exit(1);
});
