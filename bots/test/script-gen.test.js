import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateCode, validateMasterScript } from '../src/script-gen/validate.js';
import { randomMasterScript } from '../src/script-gen/generator.js';
import { frequencyBand, variationFor } from '../src/script-gen/variation.js';

// ---------- validation ----------

test('validateCode accepts valid JS (incl. top-level await) and rejects syntax errors', () => {
  assert.equal(validateCode('s("bd sd").fast(2)').ok, true);
  assert.equal(validateCode('await initHydra()\nosc(10).out(o0)').ok, true);
  const bad = validateCode('s("bd sd".fast(2)'); // unbalanced paren
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Syntax|Unexpected|missing/i);
});

test('validateMasterScript enforces the JSON contract from the spec', () => {
  const good = { strudel: 's("bd sd")', hydra: 'await initHydra()\nosc(8).out(o0)' };
  assert.equal(validateMasterScript(good).ok, true);

  assert.equal(validateMasterScript({ strudel: 's("bd")' }).ok, false, 'hydra required');
  assert.equal(validateMasterScript({ strudel: 42, hydra: 'await initHydra()' }).ok, false, 'strings required');
  assert.equal(
    validateMasterScript({ strudel: 's("bd")', hydra: 'osc(8).out(o0)' }).ok,
    false,
    'hydra must start with await initHydra() per the spec',
  );
  assert.equal(
    validateMasterScript({ strudel: 's("bd"', hydra: 'await initHydra()' }).ok,
    false,
    'syntactically broken strudel rejected',
  );
});

// ---------- random generation ----------

test('randomMasterScript is deterministic per seed and always self-valid', () => {
  const a = randomMasterScript(7);
  const b = randomMasterScript(7);
  const c = randomMasterScript(8);
  assert.deepEqual(a, b, 'same seed → same script');
  assert.notDeepEqual(a, c, 'different seed → different script');
  assert.equal(validateMasterScript(a).ok, true, 'generated scripts must pass our own validator');
  assert.ok(a.hydra.startsWith('await initHydra('));
});

// ---------- per-bot variation ----------

test('frequencyBand splits 80–8000 Hz log-evenly with contiguous coverage', () => {
  const bands = Array.from({ length: 5 }, (_, i) => frequencyBand(i, 5));
  assert.ok(Math.abs(bands[0].lo - 80) < 1e-6);
  assert.ok(Math.abs(bands[4].hi - 8000) < 1e-6);
  for (let i = 1; i < 5; i++) {
    assert.ok(Math.abs(bands[i].lo - bands[i - 1].hi) < 1e-6, 'bands are contiguous');
  }
  // Log-even: each band spans the same ratio.
  const r0 = bands[0].hi / bands[0].lo;
  const r4 = bands[4].hi / bands[4].lo;
  assert.ok(Math.abs(r0 - r4) < 1e-6);
});

const master = { strudel: 's("bd sd hh sd")', hydra: 'await initHydra()\nosc(10).out(o0)' };
const baseOpts = {
  botCount: 4,
  wclMs: 200,
  latencyMs: 50,
  jitterMs: 10,
  staggerSubdivisions: 1,
};

test('unison role leaves pattern untransformed except gain staging + fx chain', () => {
  const v = variationFor(2, master, { ...baseOpts, roles: { unison: true } });
  assert.ok(v.strudel.includes(master.strudel), 'master code embedded');
  assert.match(v.strudel, /\.gain\(/, 'gain staging always applied');
  assert.match(v.strudel, /\.delaytime\(0\.38\)/, 'fx chain maps own latency to an audible echo');
  assert.equal(v.entryDelayMs, 0);
  assert.doesNotMatch(v.strudel, /\.hpf\(|\.pan\(|\.late\(/);
});

test('frequencyBands role applies the bot\'s band and a matching hydra hue shift', () => {
  const v = variationFor(1, master, { ...baseOpts, roles: { frequencyBands: true } });
  assert.match(v.strudel, /\.hpf\(\d+(\.\d+)?\)\.lpf\(\d+(\.\d+)?\)/);
  assert.match(v.hydra, /hue\(/, 'visual EM band mirrors the audio band');
});

test('frequencyBands role never emits .hue(0) for the lowest-band bot', () => {
  const v = variationFor(0, master, { ...baseOpts, roles: { frequencyBands: true } });
  assert.ok(!v.hydra.includes('.hue(0)'), '.hue(0) is a Hydra no-op and must not appear in generated code');
  assert.equal(v.hydra, master.hydra, 'no other transform applies, so the pipeline is unchanged');
});

test('staggeredRound role delays entry by index × WCL subdivision', () => {
  const v0 = variationFor(0, master, { ...baseOpts, roles: { staggeredRound: true } });
  const v3 = variationFor(3, master, { ...baseOpts, roles: { staggeredRound: true } });
  assert.equal(v0.entryDelayMs, 0);
  assert.equal(v3.entryDelayMs, 600, '3 × 200ms WCL');
  assert.match(v3.strudel, /\.late\(/, 'musical offset in-pattern too');
});

test('stereoTiles role pans across the stereo image and crops/shifts hydra tiles', () => {
  const v0 = variationFor(0, master, { ...baseOpts, roles: { stereoTiles: true } });
  const v3 = variationFor(3, master, { ...baseOpts, roles: { stereoTiles: true } });
  assert.match(v0.strudel, /\.pan\(0\)/, 'leftmost bot hard left');
  assert.match(v3.strudel, /\.pan\(1\)/, 'rightmost bot hard right');
  assert.match(v3.hydra, /scrollX\(/, 'hydra tile shifted to compose the whole');
});

test('roles are non mutually exclusive: combined roles all apply', () => {
  const v = variationFor(1, master, {
    ...baseOpts,
    roles: { frequencyBands: true, staggeredRound: true, stereoTiles: true },
  });
  assert.match(v.strudel, /\.hpf\(/);
  assert.match(v.strudel, /\.pan\(/);
  assert.ok(v.entryDelayMs > 0);
});

test('every variation output is itself syntactically valid', () => {
  for (let i = 0; i < 4; i++) {
    const v = variationFor(i, master, {
      ...baseOpts,
      roles: { frequencyBands: true, staggeredRound: true, unison: true, stereoTiles: true },
    });
    assert.equal(validateCode(v.strudel).ok, true, `bot ${i} strudel valid`);
    assert.equal(validateCode(v.hydra).ok, true, `bot ${i} hydra valid`);
  }
});

// Reproduces a live incident: a performer combining an audio voice with a
// separate $: css(...) voice (exactly what CSS Cycles' own docs show) made
// every bot in the fleet crash-loop with "pattern did not start after
// evaluation" — variationFor used to wrap the whole multi-voice master in one
// `(...)` grouping expression, which is a SyntaxError once the master is more
// than one top-level statement.
test('a master with a separate css() voice alongside the audio voice still produces valid, playable code', () => {
  const multiVoiceMaster = {
    strudel: '$: css(`.foo {\n     &:hover { color: red }\n   }`)\n     .fast(3)\n\n$: n("<0 1 2 3 4>*8").s("gm_lead_6_voice")',
    hydra: 'await initHydra()\nosc(10).out(o0)',
  };
  const v = variationFor(1, multiVoiceMaster, { ...baseOpts, roles: { unison: true } });
  assert.equal(validateCode(v.strudel).ok, true, v.strudel);
  assert.match(v.strudel, /\$: \(css\(/, 'the css voice survives, still its own labeled statement');
  assert.match(v.strudel, /\$: \(n\(/, 'the audio voice survives, still its own labeled statement');
  assert.match(v.strudel, /\.gain\(/, 'gain staging still applied');
});
