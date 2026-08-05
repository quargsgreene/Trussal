import test from 'node:test';
import assert from 'node:assert/strict';

import {
  botScriptFor,
  captureClusterSource,
  dropTextStatements,
  masterFromPerformerCode,
} from '../src/script-gen/cluster-source.js';
import { validateCode } from '../src/script-gen/validate.js';

const capture = (code) => captureClusterSource(code, { seed: 7 }).source;

// --- Deriving the master from a performer's editor ---------------------------

test('plain Strudel becomes a master with no hydra', () => {
  assert.deepEqual(masterFromPerformerCode('s("bd sd")'), { strudel: 's("bd sd")', hydra: '' });
});

test('a Hydra block splits at the blank line, as the browser splits it', () => {
  const master = masterFromPerformerCode('await initHydra()\nosc(10).out(o0)\n\ns("bd sd")');
  assert.equal(master.hydra, 'await initHydra()\nosc(10).out(o0)');
  assert.equal(master.strudel, 's("bd sd")');
});

test('the botConfig declaration is not part of what bots play', () => {
  const master = masterFromPerformerCode('botConfig({ harmony: "+7" })\ns("bd sd")');
  assert.equal(master.strudel, 's("bd sd")');
  assert.ok(!master.strudel.includes('botConfig'));
});

test('empty code yields no master', () => {
  assert.equal(masterFromPerformerCode('   '), null);
});

// --- Capture -----------------------------------------------------------------

test('capture records the config and marks it declared', () => {
  const res = captureClusterSource('botConfig({ harmony: "+7" })\ns("bd sd")', { seed: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.source.declared, true);
  assert.equal(res.source.config.harmony, '+7');
});

test('code without a declaration is captured as an exact-copy cluster', () => {
  const res = captureClusterSource('s("bd sd")', { seed: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.source.declared, false);
  assert.equal(res.source.config.harmony, null);
});

test('a broken config is reported but still spawns exact copies', () => {
  const res = captureClusterSource('botConfig({ harmony: "sideways" })\ns("bd sd")', { seed: 1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /harmony/);
  assert.equal(res.source.master.strudel, 's("bd sd")');
  assert.equal(res.source.config.harmony, null, 'the cluster falls back to copies');
});

test('a spawn with no code falls back to the supplied master', () => {
  const fallback = { strudel: 's("hh*4")', hydra: '' };
  const res = captureClusterSource('', { fallbackMaster: fallback, seed: 1 });
  assert.deepEqual(res.source.master, fallback);
});

// --- The default: exact copies ----------------------------------------------

test('a bare botConfig() makes every bot play what the human plays', () => {
  const source = capture('botConfig()\ns("bd sd").cutoff(800)');
  for (const index of [0, 1, 2]) {
    const script = botScriptFor(source, { index, count: 3, seed: 7, botId: index });
    assert.equal(script.strudel, 's("bd sd").cutoff(800)');
  }
});

test('no declaration at all also makes exact copies', () => {
  const source = capture('s("bd sd")');
  const script = botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 });
  assert.equal(script.strudel, 's("bd sd")');
});

// --- Individual properties ---------------------------------------------------

test('paramFactor scales parameters but not mini notation', () => {
  const source = capture('botConfig({ paramFactor: 2 })\ns("bd*2 sd").cutoff(400)');
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.match(script.strudel, /cutoff\(800\)/);
  assert.match(script.strudel, /bd\*2/);
});

test('random:"params" varies per bot but rebuilds identically for one bot', () => {
  const source = capture('botConfig({ random: "params" })\ns("bd").cutoff(400)');
  const a = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 });
  const b = botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 });
  assert.notEqual(a.strudel, b.strudel, 'different bots must differ');
  assert.deepEqual(botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 }), a);
});

test('random:"full" abandons the human code for the curated palette', () => {
  // A patch with a signature the palette cannot coincidentally contain — the
  // palette does include "bd sd", so testing for that would pass either way.
  const source = capture('botConfig({ random: "full" })\ns("cp:3 rim:7").cutoff(1234)');
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(!script.strudel.includes('cp:3'), 'the human patch is replaced');
  assert.ok(!script.strudel.includes('1234'), 'including its parameters');
  assert.equal(validateCode(script.strudel).ok, true, 'and the replacement is valid');
  assert.equal(validateCode(script.hydra).ok, true);
});

test('harmony spreads a cluster into a voicing, leaving bot 0 at pitch', () => {
  const source = capture('botConfig({ harmony: "+3" })\nnote("c3")');
  assert.equal(botScriptFor(source, { index: 0, count: 3, seed: 7, botId: 0 }).strudel, 'note("c3")');
  assert.match(botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 }).strudel, /\.add\(note\(3\)\)/);
  assert.match(botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 }).strudel, /\.add\(note\(6\)\)/);
});

test('diatonic harmony reads the human scale', () => {
  const source = capture('botConfig({ harmony: "diatonic" })\nn("0 2 4").scale("C:minor")');
  const script = botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 });
  assert.match(script.strudel, /\.add\(n\(2\)\)/);
});

test('colorScheme appends a hydra postlude without disturbing the preamble', () => {
  const source = capture('botConfig({ colorScheme: "triadic" })\nawait initHydra()\nosc(10).out(o0)\n\ns("bd")');
  const script = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 });
  assert.match(script.hydra, /^await initHydra\(\)/);
  assert.match(script.hydra, /src\(o0\)\.hue\(0\.333\)\.out\(o0\)$/);
});

test('colorScheme on a bot with no hydra adds nothing', () => {
  const source = capture('botConfig({ colorScheme: "triadic" })\ns("bd")');
  assert.equal(botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 }).hydra, '');
});

// --- textParrot --------------------------------------------------------------

test('text statements are dropped unless textParrot is set', () => {
  const code = 'botConfig()\nawait initTextCycles()\n\n$: word("hello")\n$: s("bd sd")';
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(!script.strudel.includes('word('), 'a cluster must not repeat its author\'s words');
  assert.match(script.strudel, /s\("bd sd"\)/, 'the audio voice survives');
});

test('textParrot:true keeps them', () => {
  const code = 'botConfig({ textParrot: true })\nawait initTextCycles()\n\n$: word("hello")\n$: s("bd sd")';
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.match(script.strudel, /word\("hello"\)/);
});

test('dropTextStatements leaves a wordless pattern untouched', () => {
  assert.equal(dropTextStatements('s("bd sd")'), 's("bd sd")');
});

// --- Composition -------------------------------------------------------------

test('properties compose, and the result is still valid code', () => {
  const code = [
    'botConfig({ paramFactor: 2, harmony: "+5", colorScheme: "complementary" })',
    'await initHydra()',
    'osc(10, 0.1).out(o0)',
    '',
    'note("c3 e3").cutoff(400)',
  ].join('\n');
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });

  assert.match(script.strudel, /cutoff\(800\)/, 'paramFactor applied');
  assert.match(script.strudel, /\.add\(note\(5\)\)/, 'harmony applied');
  assert.match(script.hydra, /osc\(20, 0\.2\)/, 'paramFactor reaches hydra');
  assert.match(script.hydra, /hue\(0\.5\)/, 'colour applied');
  assert.equal(validateCode(script.strudel).ok, true);
  assert.equal(validateCode(script.hydra).ok, true);
});

test('every generated script parses, across the property matrix', () => {
  const configs = [
    'botConfig()',
    'botConfig({ random: "params" })',
    'botConfig({ random: "full" })',
    'botConfig({ paramFactor: 0.5 })',
    'botConfig({ harmony: "diatonic" })',
    'botConfig({ harmony: "-13" })',
    'botConfig({ harmony: "random" })',
    'botConfig({ colorScheme: "square" })',
    'botConfig({ colorScheme: "monochromatic" })',
    'botConfig({ textParrot: true })',
  ];
  const body = 'await initHydra()\nosc(10, 0.1).out(o0)\n\nn("0 2 4").scale("C:minor").cutoff(600)';

  for (const decl of configs) {
    const source = capture(`${decl}\n${body}`);
    for (let index = 0; index < 3; index++) {
      const script = botScriptFor(source, { index, count: 3, seed: 7, botId: index });
      assert.equal(validateCode(script.strudel).ok, true, `${decl} bot ${index} strudel`);
      assert.equal(validateCode(script.hydra).ok, true, `${decl} bot ${index} hydra`);
    }
  }
});
