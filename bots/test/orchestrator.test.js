import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldReplace, computeMaxBots } from '../src/orchestrator/health.js';
import { Conductor } from '../src/orchestrator/conductor.js';
import { mergeConfig } from '../src/shared/config.js';

const cfg = mergeConfig({});

// ---------- pure replacement policy ----------

function fleetOf(latencies, rams) {
  return latencies.map((latencyMs, i) => ({
    botId: i, latencyMs, ramBytes: rams[i], errors: [],
  }));
}

test('shouldReplace: ≥95th percentile latency vs the fleet → replace', () => {
  const fleet = fleetOf(
    [50, 52, 51, 49, 53, 50, 51, 52, 50, 900],
    Array(10).fill(100e6),
  );
  const verdict = shouldReplace(fleet[9], fleet, cfg);
  assert.equal(verdict.replace, true);
  assert.match(verdict.reason, /latency/);
  assert.equal(shouldReplace(fleet[0], fleet, cfg).replace, false);
});

test('shouldReplace: ≥95th percentile RAM vs the fleet → replace', () => {
  const fleet = fleetOf(
    Array(10).fill(50),
    [...Array(9).fill(100e6), 2e9],
  );
  const verdict = shouldReplace(fleet[9], fleet, cfg);
  assert.equal(verdict.replace, true);
  assert.match(verdict.reason, /ram/i);
});

test('shouldReplace: runtime/syntax eval errors → replace immediately, any fleet size', () => {
  const bot = { botId: 0, latencyMs: 10, ramBytes: 1e6, errors: ['SyntaxError: nope'] };
  const verdict = shouldReplace(bot, [bot], cfg);
  assert.equal(verdict.replace, true);
  assert.match(verdict.reason, /error/i);
});

test('shouldReplace: healthy-but-relatively-worst bot is NOT replaced (absolute floors)', () => {
  // Everyone is objectively fine; bot 9 is merely the worst of a good fleet.
  const fleet = fleetOf(
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 25],
    [...Array(9).fill(40e6), 60e6],
  );
  assert.equal(shouldReplace(fleet[9], fleet, cfg).replace, false,
    '25ms latency / 60MB ram is healthy regardless of percentile rank');
});

test('shouldReplace: small fleet never triggers percentile replacement', () => {
  const fleet = fleetOf([10, 900], [1e6, 2e9]);
  assert.equal(shouldReplace(fleet[1], fleet, cfg).replace, false);
});

// ---------- pure scale-down policy ----------

test('computeMaxBots: healthy fleet keeps the spec ceiling of 10', () => {
  const n = computeMaxBots({ medianFps: 30, maxRamMb: 300, medianLatencyMs: 40 }, cfg);
  assert.equal(n, 10);
});

test('computeMaxBots: fps below the user cutoff scales the fleet down proportionally', () => {
  const n = computeMaxBots({ medianFps: cfg.fpsMin / 2, maxRamMb: 300, medianLatencyMs: 40 }, cfg);
  assert.ok(n < 10 && n >= 1, `got ${n}`);
});

test('computeMaxBots: memory above the user threshold scales down', () => {
  const n = computeMaxBots({ medianFps: 30, maxRamMb: cfg.memLimitMb * 2, medianLatencyMs: 40 }, cfg);
  assert.ok(n < 10 && n >= 1);
});

test('computeMaxBots: unusually poor connectivity scales down; never below 1', () => {
  const n = computeMaxBots({ medianFps: 30, maxRamMb: 300, medianLatencyMs: 5000 }, cfg);
  assert.ok(n < 10 && n >= 1);
  const worst = computeMaxBots({ medianFps: 0.1, maxRamMb: 1e6, medianLatencyMs: 1e6 }, cfg);
  assert.equal(worst, 1, 'floor is one bot, never zero');
});

// ---------- conductor lifecycle (fake runner, real HTTP) ----------

function makeFakeRunner() {
  const calls = { started: [], stopped: [] };
  return {
    calls,
    start: async (botId) => calls.started.push(botId),
    stop: async (botId) => calls.stopped.push(botId),
  };
}

test('Conductor: starts maxBots bots with unique scripts, serves assignments over HTTP', async () => {
  const runner = makeFakeRunner();
  const conductor = new Conductor(mergeConfig({ maxBots: 4, conductorPort: 0 }), { runner });
  await conductor.start();
  try {
    assert.deepEqual(runner.calls.started, [0, 1, 2, 3]);

    const port = conductor.port;
    const res = await fetch(`http://127.0.0.1:${port}/assignment/2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.botCount, 4);
    assert.ok(body.script.strudel.length > 0);
    assert.equal(typeof body.script.entryDelayMs, 'number');

    const other = await (await fetch(`http://127.0.0.1:${port}/assignment/3`)).json();
    assert.notEqual(other.script.strudel, body.script.strudel, 'each bot id gets its own variation');
  } finally {
    await conductor.stop();
  }
});

test('Conductor: accepts metrics POSTs and replaces a bot that reports an eval error', async () => {
  const runner = makeFakeRunner();
  const conductor = new Conductor(
    mergeConfig({ maxBots: 4, conductorPort: 0, healthTickMs: 30 }),
    { runner },
  );
  await conductor.start();
  try {
    const port = conductor.port;
    const post = (m) => fetch(`http://127.0.0.1:${port}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(m),
    });
    for (let i = 0; i < 4; i++) {
      await post({ botId: i, latencyMs: 50, ramBytes: 1e8, fps: 30, errors: i === 1 ? ['SyntaxError: bad'] : [] });
    }
    await new Promise((r) => setTimeout(r, 120)); // let a health tick run
    assert.ok(runner.calls.stopped.includes(1), 'bot 1 stopped for eval error');
    assert.ok(runner.calls.started.filter((id) => id === 1).length >= 2, 'bot 1 restarted');
  } finally {
    await conductor.stop();
  }
});

test('Conductor: listBots exposes the exact running code for the admin inspector modal', async () => {
  const runner = makeFakeRunner();
  const conductor = new Conductor(mergeConfig({ maxBots: 3, conductorPort: 0 }), { runner });
  await conductor.start();
  try {
    const bots = conductor.listBots();
    assert.equal(bots.length, 3);
    for (const b of bots) {
      assert.equal(typeof b.botId, 'number');
      assert.ok(b.name.length > 0, 'dog-breed name present');
      assert.ok(b.script.strudel.includes('('), 'exact strudel code exposed');
      assert.ok(b.script.hydra.startsWith('await initHydra('), 'exact hydra code exposed');
    }
  } finally {
    await conductor.stop();
  }
});

test('Conductor: setMasterScript validates, rejects bad scripts, redistributes good ones', async () => {
  const runner = makeFakeRunner();
  const conductor = new Conductor(mergeConfig({ maxBots: 2, conductorPort: 0 }), { runner });
  await conductor.start();
  try {
    const bad = conductor.setMasterScript({ strudel: 's("bd"', hydra: 'await initHydra()' });
    assert.equal(bad.ok, false);

    const before = conductor.listBots()[0].script.strudel;
    const good = conductor.setMasterScript({ strudel: 's("arpy*8")', hydra: 'await initHydra()\nosc(3).out(o0)' });
    assert.equal(good.ok, true);
    const after = conductor.listBots()[0].script.strudel;
    assert.notEqual(before, after);
    assert.ok(after.includes('arpy*8'));
  } finally {
    await conductor.stop();
  }
});

test('Conductor: applyConfig scaling down stops surplus bots; scaling up starts new ones', async () => {
  const runner = makeFakeRunner();
  const conductor = new Conductor(mergeConfig({ maxBots: 4, conductorPort: 0 }), { runner });
  await conductor.start();
  try {
    await conductor.applyConfig({ maxBots: 2 });
    assert.ok(runner.calls.stopped.includes(2) && runner.calls.stopped.includes(3));
    assert.equal(conductor.listBots().length, 2);

    await conductor.applyConfig({ maxBots: 3 });
    assert.equal(conductor.listBots().length, 3);
  } finally {
    await conductor.stop();
  }
});
