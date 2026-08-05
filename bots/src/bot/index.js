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
import WebSocket from 'ws';
import { Bot } from './bot.js';
import { AggregatorBot, AGGREGATOR_SLOT_TAKEN } from './aggregator-bot.js';
import { makeWsSidecarConnector } from '../orchestrator/fleet-service.js';
import { ffmpegBedArgs } from './ffmpeg-bed.js';
import { jamulusArgs, jamulusIniContent } from './jamulus.js';
import { breedNameFor } from '../shared/dog-breeds.js';
import { gainForBotCount } from '../shared/audio-math.js';
import { frequencyBand } from '../script-gen/variation.js';
import { absoluteSampleUrls } from '../shared/sample-urls.js';

const env = (key, fallback) => process.env[key] ?? fallback;

const botId = Number(env('BOT_ID', '0'));
const sessionSeed = Number(env('SESSION_SEED', '1'));
const conductorUrl = env('CONDUCTOR_URL', 'http://conductor:7700');
const jitsiUrl = env('JITSI_URL', 'http://localhost/0');
const jamulusServer = env('JAMULUS_SERVER', 'trussal.duckdns.org:22000');
const executablePath = env('CHROMIUM_PATH', '/usr/bin/chromium');
const metricsIntervalMs = Number(env('METRICS_INTERVAL_MS', '2000'));
// One container per room runs as the aggregator (BOT_ROLE=aggregator): no
// Strudel/Jamulus, it taps every participant and will stream back the mix.
const botRole = env('BOT_ROLE', 'player');

const name = breedNameFor(botId, sessionSeed);

async function fetchAssignment() {
  const res = await fetch(`${conductorUrl}/assignment/${botId}`);
  if (!res.ok) throw new Error(`conductor refused assignment: ${res.status}`);
  return res.json(); // { script: {strudel, hydra, entryDelayMs}, botCount, samples }
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

function bandwidthFromEnv() {
  return {
    channelLastN: Number(env('JITSI_CHANNEL_LAST_N', '0')),
    videoHeight: Number(env('JITSI_VIDEO_HEIGHT', '360')),
    startBitrateKbps: Number(env('JITSI_START_BITRATE_KBPS', '800')),
    captureFps: Number(env('CAPTURE_FPS', '15')),
  };
}

// Report metrics to the conductor on a cadence, measuring latency as the HTTP
// round-trip of each POST. `extra` is merged into the body (the aggregator
// tags role:'aggregator' so the fleet keeps it out of the health summary).
function startMetricsReporting(bot, extra = {}) {
  let lastLatencyMs = 0;
  let jitterMs = 0;
  return setInterval(async () => {
    try {
      const m = await bot.sampleMetrics();
      const t0 = Date.now();
      await fetch(`${conductorUrl}/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...m, ...extra, latencyMs: lastLatencyMs, jitterMs }),
      });
      const newLatency = Date.now() - t0;
      // RFC 3550 running jitter: J += (|D| - J) / 16
      jitterMs = jitterMs + (Math.abs(newLatency - lastLatencyMs) - jitterMs) / 16;
      lastLatencyMs = newLatency;
    } catch (err) {
      console.error(`[bot ${botId}] metrics report failed:`, err.message);
    }
  }, metricsIntervalMs);
}

// The aggregator: no assignment/script, no ffmpeg/Jamulus sidecars. It joins,
// taps every participant into per-room-index ring buffers (its own ingest
// loop), and reports metrics + buffer stats tagged as the aggregator.
async function aggregatorMain() {
  const bot = new AggregatorBot({
    botId,
    name: env('BOT_NAME', 'Aggregator'),
    jitsiUrl,
    executablePath,
    bandwidth: bandwidthFromEnv(),
    ingestIntervalMs: Number(env('INGEST_INTERVAL_MS', '500')),
    playbackIntervalMs: Number(env('PLAYBACK_INTERVAL_MS', '250')),
    slotMs: Number(env('SLOT_MS', '4000')),
    // Per-participant hold window. HOLD_MS (ms) is the ms-measured knob; when
    // unset the per-participant buffers fall back to the RING_BUFFER_SIZE sample
    // count below (default 48000 = 1s @ 48kHz), preserving prior behavior.
    holdMs: env('HOLD_MS', '') ? Number(env('HOLD_MS', '')) : undefined,
    sampleRate: Number(env('SAMPLE_RATE', '48000')),
    // Gain-staging ceiling for the assembled master (full scale = 1.0).
    gainCeiling: Number(env('GAIN_CEILING', '1.0')),
    // Claim the room's single aggregator slot before joining; a losing bot exits
    // without ever joining Jitsi (see AggregatorBot #claimAggregatorSlot).
  }, { launcher: puppeteer, connectSidecar: makeWsSidecarConnector(WebSocket), webSocketImpl: WebSocket }, {}, Number(env('RING_BUFFER_SIZE', '48000')));
  try {
    await bot.start();
  } catch (err) {
    if (err && err.code === AGGREGATOR_SLOT_TAKEN) {
      // Another aggregator already holds the room's slot: this one deliberately
      // never joins. Exit cleanly so the orchestrator doesn't count it as a
      // crash to replace.
      console.log(err.message);
      await bot.stop().catch((e) => console.error(`[aggregator-bot] cleanup after losing claim failed: ${e.message}`));
      process.exit(0);
    }
    throw err; // a genuine start failure is fatal (handled by main().catch)
  }
  startMetricsReporting(bot, { role: 'aggregator' });

  const shutdown = async () => {
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function playerMain() {
  const { script, botCount, samples } = await fetchAssignment();
  const sidecars = startSidecars(botCount);
  const ownerIndex = env('BOT_OWNER_INDEX', '');
  const bot = new Bot(
    {
      botId, name, jitsiUrl, script, executablePath,
      bandwidth: bandwidthFromEnv(), ownerIndex,
      // Bank → absolute URLs. The fleet hands out paths because it cannot know
      // how this container addresses it; resolving them here is what makes
      // CONDUCTOR_URL the single answer to that question.
      samples: absoluteSampleUrls(samples, conductorUrl),
    },
    { launcher: puppeteer },
  );
  await bot.start();
  startMetricsReporting(bot);

  const shutdown = async () => {
    sidecars.forEach((p) => p.kill('SIGTERM'));
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function main() {
  if (botRole === 'aggregator') return aggregatorMain();
  return playerMain();
}

main().catch((err) => {
  // A bot that cannot start must die loudly: the conductor sees the container
  // exit and applies the replacement policy.
  console.error(`[bot ${botId}] fatal:`, err);
  process.exit(1);
});
