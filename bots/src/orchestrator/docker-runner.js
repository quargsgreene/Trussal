/**
 * Production container runner: one Docker container per bot (spec), driven
 * through the docker CLI rather than a Docker SDK dependency — the conductor
 * container mounts /var/run/docker.sock and shells out, which keeps the
 * dependency surface at zero and the commands identical to what an operator
 * would type when debugging.
 *
 * Containers are named trussal-bot-<id> so start/stop is idempotent by id,
 * matching the Conductor's contract of an injected { start, stop } runner.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function makeDockerRunner({
  image = 'trussal-bot',
  env = {},
} = {}) {
  const name = (botId) => `trussal-bot-${botId}`;

  return {
    async start(botId) {
      // Remove any stale container with this name first (replacement path).
      await run('docker', ['rm', '-f', name(botId)]).catch(() => {});
      const envFlags = Object.entries({ ...env, BOT_ID: String(botId) })
        .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      await run('docker', [
        'run', '-d',
        '--name', name(botId),
        // Host network: the spec's Jitsi URL is literally http://localhost/0,
        // which must resolve to the VM (where Jitsi listens), not to the
        // container. Bots therefore also reach the conductor via
        // localhost:7700 (published by compose).
        '--network', 'host',
        // ALSA loopback: snd-aloop is a kernel module loaded on the host
        // (two cards × 8 substreams); the entrypoint claims this bot's own
        // subdevice from BOT_ID.
        '--device', '/dev/snd',
        // jackd runs realtime inside the container; without rtprio/memlock
        // ulimits it falls back with a warning and xruns under load.
        '--ulimit', 'rtprio=99',
        '--ulimit', 'memlock=-1',
        '--shm-size', '1gb', // Chromium renders Hydra WebGL; default 64MB shm crashes tabs
        ...envFlags,
        image,
      ]);
    },

    async stop(botId) {
      await run('docker', ['rm', '-f', name(botId)]).catch(() => {});
    },
  };
}
