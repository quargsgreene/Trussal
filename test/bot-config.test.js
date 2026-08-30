import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOT_CONFIG_KEYS,
  defaultBotConfig,
  findBotConfigCall,
  flag,
  hasBotConfig,
  parseBotConfig,
  parseHarmony,
  parseObjectLiteral,
  stripBotConfig,
  validateBotConfig,
} from '../src/bot-config.js';

test('detects a botConfig declaration', () => {
  assert.equal(hasBotConfig('botConfig()'), true);
  assert.equal(hasBotConfig('botConfig({ random: "full" })'), true);
  assert.equal(hasBotConfig('s("bd sd")'), false);
});

test('does not claim someone else\'s symbol', () => {
  assert.equal(hasBotConfig('myBotConfig({ random: "full" })'), false);
  assert.equal(hasBotConfig('x.botConfig({ random: "full" })'), false);
});

test('finds the call across multiple lines', () => {
  const code = [
    's("bd sd")',
    'botConfig({',
    '  random: "params",',
    '  paramFactor: 2',
    '})',
    'note("c3")',
  ].join('\n');
  const found = findBotConfigCall(code);
  assert.ok(found);
  assert.match(found.argText, /random/);
  assert.match(found.argText, /paramFactor/);
});

test('a closing paren inside a quoted value does not end the argument', () => {
  const found = findBotConfigCall('botConfig({ harmony: "diatonic :) slow" })\ns("bd")');
  assert.equal(found.unbalanced, false);
  assert.equal(found.argText, '{ harmony: "diatonic :) slow" }');
});

test('stripping removes the declaration and its line', () => {
  const code = 's("bd sd")\nbotConfig({ random: "full" })\nnote("c3")';
  assert.equal(stripBotConfig(code), 's("bd sd")\nnote("c3")');
});

test('stripping swallows a trailing semicolon', () => {
  assert.equal(stripBotConfig('botConfig();\ns("bd")'), 's("bd")');
});

test('stripping preserves the blank line a Hydra preamble splits on', () => {
  const code = 'await initHydra()\nosc(10).out(o0)\n\nbotConfig({ samples: true })\ns("bd sd")';
  const stripped = stripBotConfig(code);
  assert.equal(stripped, 'await initHydra()\nosc(10).out(o0)\n\ns("bd sd")');
  assert.ok(stripped.includes('\n\n'), 'the preamble boundary must survive');
});

test('stripping a block with no declaration is a no-op', () => {
  const code = 's("bd sd")\nnote("c3")';
  assert.equal(stripBotConfig(code), code);
});

test('a bare botConfig() is every property at null', () => {
  const parsed = parseBotConfig('botConfig()');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.config, defaultBotConfig());
  for (const key of BOT_CONFIG_KEYS) assert.equal(parsed.config[key], null);
});

test('no declaration is reported as absent, not as defaults', () => {
  const parsed = parseBotConfig('s("bd sd")');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.present, false);
});

test('accepts editor-habit object literals', () => {
  const cases = [
    '{ random: "full" }',
    "{ random: 'full' }",
    '{ "random": "full" }',
    '{ random: "full", }',
    '{random:"full"}',
  ];
  for (const text of cases) {
    const parsed = parseObjectLiteral(text);
    assert.equal(parsed.ok, true, `${text} should parse`);
    assert.deepEqual(parsed.value, { random: 'full' });
  }
});

test('parses every scalar type', () => {
  const parsed = parseObjectLiteral('{ paramFactor: 1.5, retroactive: true, samples: false, harmony: null }');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    paramFactor: 1.5, retroactive: true, samples: false, harmony: null,
  });
});

test('parses a negative number', () => {
  const parsed = parseObjectLiteral('{ paramFactor: -0.25 }');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { paramFactor: -0.25 });
});

test('rejects an unknown property by name', () => {
  const parsed = parseBotConfig('botConfig({ randomize: "full" })');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /randomize is not a known property/);
});

test('rejects an out-of-range enum value and lists the valid ones', () => {
  const parsed = parseBotConfig('botConfig({ colorScheme: "greenish" })');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /complementary/);
});

test('rejects a wrong-typed property', () => {
  assert.equal(parseBotConfig('botConfig({ paramFactor: "two" })').ok, false);
  assert.equal(parseBotConfig('botConfig({ retroactive: "yes" })').ok, false);
  assert.equal(parseBotConfig('botConfig({ random: true })').ok, false);
});

test('accepts every documented random and colorScheme value', () => {
  for (const value of ['params', 'full']) {
    assert.equal(parseBotConfig(`botConfig({ random: "${value}" })`).ok, true, value);
  }
  const schemes = [
    'complementary', 'monochromatic', 'analogous', 'triadic',
    'tetradic', 'square', 'random',
  ];
  for (const value of schemes) {
    assert.equal(parseBotConfig(`botConfig({ colorScheme: "${value}" })`).ok, true, value);
  }
});

test('an explicit null property is legal and means no effect', () => {
  const parsed = parseBotConfig('botConfig({ harmony: null })');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.harmony, null);
});

test('harmony accepts diatonic, random, and signed semitone counts', () => {
  assert.deepEqual(parseHarmony('diatonic'), { type: 'diatonic' });
  assert.deepEqual(parseHarmony('random'), { type: 'random' });
  assert.deepEqual(parseHarmony('+2'), { type: 'interval', semitones: 2 });
  assert.deepEqual(parseHarmony('-13'), { type: 'interval', semitones: -13 });
  assert.equal(parseHarmony(null), null);
});

test('harmony rejects an unsigned interval', () => {
  const parsed = parseBotConfig('botConfig({ harmony: "2" })');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /signed semitone count/);
});

test('validateBotConfig fills absent properties with null', () => {
  const valid = validateBotConfig({ samples: true });
  assert.equal(valid.ok, true);
  assert.equal(valid.config.samples, true);
  assert.equal(valid.config.harmony, null);
  assert.deepEqual(Object.keys(valid.config).sort(), [...BOT_CONFIG_KEYS].sort());
});

test('validateBotConfig rejects a non-object argument', () => {
  assert.equal(validateBotConfig(null).ok, false);
  assert.equal(validateBotConfig([1, 2]).ok, false);
  assert.equal(validateBotConfig('full').ok, false);
});

test('flag treats null as off, matching "unset has no effect"', () => {
  assert.equal(flag(true), true);
  assert.equal(flag(false), false);
  assert.equal(flag(null), false);
});

test('reports a malformed argument instead of ignoring the call', () => {
  const parsed = parseBotConfig('botConfig({ random: full })');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unquoted value "full"/);
});

test('reports an unbalanced call', () => {
  const parsed = parseBotConfig('botConfig({ random: "full" }');
  assert.equal(parsed.ok, false);
});
