import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dockerRunArgs } from '../src/orchestrator/docker-runner.js';

const envPairs = (args) => args.flatMap((a, i) => (a === '-e' ? [args[i + 1]] : []));

// ---------- per-role sound devices ----------

test('dockerRunArgs: a player bot claims the host ALSA device (the rig needs it)', () => {
  const args = dockerRunArgs({ botId: 3 });
  assert.equal(args[args.indexOf('--name') + 1], 'trussal-bot-3');
  assert.equal(args[args.indexOf('--network') + 1], 'host');
  const deviceAt = args.indexOf('--device');
  assert.notEqual(deviceAt, -1);
  assert.equal(args[deviceAt + 1], '/dev/snd');
  assert.equal(args.at(-1), 'trussal-bot'); // the image is last
  assert.ok(envPairs(args).includes('BOT_ID=3'));
});

test('dockerRunArgs: the aggregator never gets sound devices', () => {
  const args = dockerRunArgs({ botId: 99999, extraEnv: { BOT_ROLE: 'aggregator' } });
  assert.ok(!args.includes('--device'), 'the aggregator must not reach any sound card');
  assert.ok(envPairs(args).includes('BOT_ROLE=aggregator'));
});

test('dockerRunArgs: a BOT_ROLE from the runner env counts too', () => {
  const args = dockerRunArgs({ botId: 99998, env: { BOT_ROLE: 'aggregator' } });
  assert.ok(!args.includes('--device'));
});

// ---------- env plumbing ----------

test('dockerRunArgs: extraEnv wins over the runner env and BOT_ID is forced', () => {
  const args = dockerRunArgs({
    botId: 4,
    env: { JAMULUS_SERVER: 'a:1', BOT_ID: '999' },
    extraEnv: { JAMULUS_SERVER: 'b:2' },
  });
  const pairs = envPairs(args);
  assert.ok(pairs.includes('JAMULUS_SERVER=b:2'));
  assert.ok(!pairs.includes('JAMULUS_SERVER=a:1'));
  assert.ok(pairs.includes('BOT_ID=4'));
  assert.ok(!pairs.includes('BOT_ID=999'));
});
