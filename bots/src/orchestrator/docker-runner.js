/**
 * Production container runner: one Docker container per bot (spec), driven
 * through the docker CLI rather than a Docker SDK dependency — the conductor
 * container mounts /var/run/docker.sock and shells out, which keeps the
 * dependency surface at zero and the commands identical to what an operator
 * would type when debugging.
 *
 * Containers are named trussal-bot-<id> so start/stop is idempotent by id,
 * matching the Conductor's contract of an injected { start, stop } runner —
 * plus isRunning, which the aggregator reap path consults to tell a booting
 * container apart from one that died before it could report.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The `docker run` argv for one bot. Pure and exported so tests can pin the
 * per-role device split without a docker daemon in reach.
 */
export function dockerRunArgs({ botId, image = 'trussal-bot', env = {}, extraEnv = {} } = {}) {
  const role = extraEnv.BOT_ROLE ?? env.BOT_ROLE ?? 'player';
  const envFlags = Object.entries({ ...env, ...extraEnv, BOT_ID: String(botId) })
    .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return [
    'run', '-d',
    '--name', `trussal-bot-${botId}`,
    // Host network: the spec's Jitsi URL is literally http://localhost/0,
    // which must resolve to the VM (where Jitsi listens), not to the
    // container. Bots therefore also reach the conductor via
    // localhost:7700 (published by compose).
    '--network', 'host',
    // ALSA loopback: snd-aloop is a kernel module loaded on the host (two
    // cards × 8 substreams); the entrypoint claims this bot's own subdevice
    // from BOT_ID. The aggregator runs no rig — and must never render the
    // room to a sound card either — so it gets no sound devices at all: even
    // a missing null-ALSA default inside its container then has no device
    // node to reach the host's speakers through.
    ...(role === 'aggregator' ? [] : ['--device', '/dev/snd']),
    // jackd runs realtime inside the container; without rtprio/memlock
    // ulimits it falls back with a warning and xruns under load.
    '--ulimit', 'rtprio=99',
    '--ulimit', 'memlock=-1',
    '--shm-size', '1gb', // Chromium renders Hydra WebGL; default 64MB shm crashes tabs
    ...envFlags,
    image,
  ];
}

export function makeDockerRunner({
  image = 'trussal-bot',
  env = {},
} = {}) {
  const name = (botId) => `trussal-bot-${botId}`;

  return {
    async start(botId, extraEnv = {}) {
      // Remove any stale container with this name first (replacement path).
      await run('docker', ['rm', '-f', name(botId)]).catch(() => {});
      await run('docker', dockerRunArgs({ botId, image, env, extraEnv }));
    },

    async stop(botId) {
      // Graceful stop FIRST (SIGTERM + grace), so the bot's own SIGTERM handler
      // runs bot.stop() -> leave the Jitsi conference + browser.close(). A hard
      // `rm -f` (SIGKILL) skips that, leaving a ghost XMPP session that keeps the
      // room alive so meetings can't end. `-t 15` is ample: a conference leave +
      // browser teardown is a few seconds. Then remove the (now stopped) container.
      await run('docker', ['stop', '-t', '15', name(botId)]).catch(() => {});
      await run('docker', ['rm', '-f', name(botId)]).catch(() => {});
    },

    // Liveness for the aggregator reap path (fleet-service's
    // #reapDeadAggregator): whether the container still exists and is running.
    // Only "no such object/container" proves absence; any other failure
    // (daemon busy, inspect timing out) is UNKNOWN and is re-thrown so the
    // caller treats the container as alive rather than reaping on a hiccup.
    // The one caller only consults this after runner.start() has returned,
    // never during the window where start()'s own leading `docker rm -f`
    // would fake absence.
    async isRunning(botId) {
      try {
        const { stdout } = await run('docker', [
          'container', 'inspect', '--format', '{{.State.Running}}', name(botId),
        ]);
        return stdout.trim() === 'true';
      } catch (err) {
        const said = String((err && (err.stderr || err.message)) || '');
        if (/no such (object|container)/i.test(said)) return false;
        throw err;
      }
    },
  };
}
