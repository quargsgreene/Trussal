import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Conductor } from '../src/orchestrator/conductor.js';
import { createAdminServer } from '../src/config-api/server.js';
import { mergeConfig } from '../src/shared/config.js';

function makeFakeRunner() {
  return { start: async () => {}, stop: async () => {} };
}

async function withAdmin(fn, overrides = {}) {
  const conductor = new Conductor(
    mergeConfig({ maxBots: 3, conductorPort: 0, ...overrides }),
    { runner: makeFakeRunner() },
  );
  await conductor.start();
  const server = createAdminServer(conductor);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, conductor);
  } finally {
    server.close();
    await conductor.stop();
  }
}

test('GET / serves the unstyled admin page with slider, role checkboxes and thresholds', async () => {
  await withAdmin(async (base) => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.doesNotMatch(html, /<style|class=|style=/, 'spec: no styling');
    assert.match(html, /type="range"[^>]*max="10"/, 'bot count slider capped at 10');
    for (const role of ['frequencyBands', 'staggeredRound', 'unison', 'stereoTiles']) {
      assert.match(html, new RegExp(`type="checkbox"[^>]*name="${role}"`), `checkbox for ${role}`);
    }
    assert.match(html, /name="fpsMin"/, 'user-determined fps cutoff');
    assert.match(html, /name="memLimitMb"/, 'user-determined memory threshold');
    assert.match(html, /type="file"/, 'master script JSON upload');
    assert.match(html, /<dialog/, 'per-bot code inspector modal');
  });
});

test('GET /api/bots exposes each bot exact code for the inspector modal', async () => {
  await withAdmin(async (base) => {
    const res = await fetch(`${base}/api/bots`);
    assert.equal(res.status, 200);
    const bots = await res.json();
    assert.equal(bots.length, 3);
    for (const b of bots) {
      assert.ok(b.name, 'breed name');
      assert.ok(b.script.strudel, 'exact strudel code');
      assert.ok(b.script.hydra.startsWith('await initHydra('), 'exact hydra code');
      assert.equal(typeof b.script.entryDelayMs, 'number');
    }
  });
});

test('GET /api/config returns current settings; POST applies slider/checkbox changes', async () => {
  await withAdmin(async (base, conductor) => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.maxBots, 3);

    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxBots: 2, roles: { stereoTiles: true }, fpsMin: 20 }),
    });
    assert.equal(res.status, 200);
    assert.equal(conductor.listBots().length, 2);
    assert.equal(conductor.cfg.roles.stereoTiles, true);
    assert.equal(conductor.cfg.fpsMin, 20);

    const bad = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bogusKey: 1 }),
    });
    assert.equal(bad.status, 400, 'unknown config keys rejected with the validation message');
  });
});

test('POST /api/master-script validates the JSON and redistributes on success', async () => {
  await withAdmin(async (base, conductor) => {
    const bad = await fetch(`${base}/api/master-script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strudel: 's("bd"', hydra: 'await initHydra()' }),
    });
    assert.equal(bad.status, 400);
    const err = await bad.json();
    assert.match(err.error, /strudel/i, 'validation error surfaced to the page');

    const good = await fetch(`${base}/api/master-script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strudel: 's("arpy*4")', hydra: 'await initHydra()\nosc(2).out(o0)' }),
    });
    assert.equal(good.status, 200);
    assert.ok(conductor.listBots()[0].script.strudel.includes('arpy*4'));
  });
});
