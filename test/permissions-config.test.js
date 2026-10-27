import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePermissionsConfig,
  defaultPermissionsConfig,
  stripPermissionsConfig,
  hasPermissionsConfig,
  sanitizePermissionsConfig,
  allowsInhabitFrom,
  allowsClipping,
  permissionsConfigsEqual,
  PERMISSIONS_CONFIG_STATEMENT_PATTERN,
} from '../src/permissions-config.js';
import { parseBotConfig } from '../src/bot-config.js';
import { normalizePeerCode } from '../src/hydra-code.js';

const editor = (...lines) => ["'personal editor'", ...lines].join('\n');

test('no declaration means everyone may inhabit and clip', () => {
  const r = parsePermissionsConfig(editor('$: s("bd")'));
  assert.deepEqual(r, { ok: true, present: false, config: { allowInhabitFrom: 'all', allowClipping: true } });
});

test('allowInhabitFrom takes "all", "none" or a list of participants, humans and bots', () => {
  assert.equal(parsePermissionsConfig('permissionsConfig({ allowInhabitFrom: "none" })').config.allowInhabitFrom, 'none');
  assert.equal(parsePermissionsConfig("permissionsConfig({ allowInhabitFrom: 'all' })").config.allowInhabitFrom, 'all');
  const r = parsePermissionsConfig('permissionsConfig({ "allowInhabitFrom": ["1", 2b, "1"] })');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.config.allowInhabitFrom, ['1', '2b']);
  assert.equal(r.config.allowClipping, true, 'an unwritten property keeps its default');
});

test('allowClipping takes a boolean', () => {
  const r = parsePermissionsConfig('permissionsConfig({ allowClipping: false })');
  assert.deepEqual(r.config, { allowInhabitFrom: 'all', allowClipping: false });
});

for (const [code, pattern] of [
  ['permissionsConfig({ allowInhabitFrom: "some" })', /allowInhabitFrom must be "all", "none", or a list/],
  ['permissionsConfig({ allowInhabitFrom: ["Ada"] })', /'Ada' is not a participant token/],
  ['permissionsConfig({ allowClipping: "no" })', /allowClipping must be true or false/],
  ['permissionsConfig({ allowClips: false })', /allowClips is not a known property/],
  ['permissionsConfig({ allowClipping: false }', /unclosed/],
  ['permissionsConfig({ allowClipping: nope })', /unquoted value/],
  ['permissionsConfig([1])', /expected "\{"/],
]) {
  test(`${code} is refused with a message`, () => {
    const r = parsePermissionsConfig(code);
    assert.equal(r.ok, false);
    assert.equal(r.present, true);
    assert.match(r.error, pattern);
  });
}

test('the declaration is stripped before Strudel sees the code, and botConfig still parses beside it', () => {
  const code = editor(
    'permissionsConfig({ allowInhabitFrom: ["1"], allowClipping: false })',
    'botConfig({ spawn: 2 })',
    '$: s("bd sd")',
  );
  assert.equal(hasPermissionsConfig(code), true);
  assert.doesNotMatch(stripPermissionsConfig(code), /permissionsConfig/);
  assert.equal(parseBotConfig(code).config.spawn, 2);
  const lowered = normalizePeerCode(code);
  assert.doesNotMatch(lowered, /permissionsConfig|botConfig/);
  assert.match(lowered, /s\("bd sd"\)/);
});

test('a method or a longer name is not the declaration', () => {
  assert.equal(hasPermissionsConfig('x.permissionsConfig({})'), false);
  assert.equal(hasPermissionsConfig('myPermissionsConfig({})'), false);
});

test('the statement pattern the bot REPL strips with removes the whole call and nothing else', () => {
  const re = new RegExp(PERMISSIONS_CONFIG_STATEMENT_PATTERN.source, PERMISSIONS_CONFIG_STATEMENT_PATTERN.flags);
  const code = 'permissionsConfig({ allowClipping: false, allowInhabitFrom: ["1", "2b"] });\n$: s("bd")';
  assert.equal(code.replace(re, (m, lead) => lead), '\n$: s("bd")');
  assert.equal('$: s("bd")'.replace(re, (m, lead) => lead), '$: s("bd")');
});

test('a config from the wire is cleaned to a complete one, never thrown on', () => {
  assert.deepEqual(sanitizePermissionsConfig({ allowInhabitFrom: ['1'], allowClipping: false }), { allowInhabitFrom: ['1'], allowClipping: false });
  assert.deepEqual(sanitizePermissionsConfig({ allowInhabitFrom: 'everyone' }), defaultPermissionsConfig());
  assert.deepEqual(sanitizePermissionsConfig(null), defaultPermissionsConfig());
});

test('the checks', () => {
  assert.equal(allowsInhabitFrom(null, '1'), true);
  assert.equal(allowsInhabitFrom({ allowInhabitFrom: 'none' }, '1'), false);
  assert.equal(allowsInhabitFrom({ allowInhabitFrom: ['1', '2b'] }, '2b'), true);
  assert.equal(allowsInhabitFrom({ allowInhabitFrom: ['1', '2b'] }, '2'), false);
  assert.equal(allowsClipping(null), true);
  assert.equal(allowsClipping({ allowClipping: false }), false);
  assert.equal(permissionsConfigsEqual(null, defaultPermissionsConfig()), true);
  assert.equal(permissionsConfigsEqual({ allowInhabitFrom: 'none', allowClipping: true }, null), false);
});
