import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';
import { resolveInhabitMap } from '../src/inhabit-core.js';

const program = (...lines) => ["'metaprogram editor'", '$ participants <0 1 2>', ...lines].join('\n');
const parse = (...lines) => parseMetaprogram(program(...lines));
const messages = (r) => r.errors.map((e) => e.message).join(' | ');

test('# inhabit takes a host and one guest', () => {
  const r = parse('# inhabit 0 1');
  assert.equal(r.valid, true, messages(r));
  assert.deepEqual(r.ast.inhabit.map(({ hosts, slow, guests }) => ({ hosts, slow, guests })), [{ hosts: ['0'], slow: 1, guests: ['1'] }]);
});

test('# inhabit takes a host pattern with rests, a /n, and a guest set of humans and bots', () => {
  const r = parse('# inhabit <0 ~ 3a>/4 [1 2b]');
  assert.equal(r.valid, true, messages(r));
  assert.deepEqual(r.ast.inhabit[0].hosts, ['0', '~', '3a']);
  assert.equal(r.ast.inhabit[0].slow, 4);
  assert.deepEqual(r.ast.inhabit[0].guests, ['1', '2b']);
});

test('a bot may host and a bot may be a guest', () => {
  const r = parse('# inhabit 0a 1', '# inhabit 2 0b');
  assert.equal(r.valid, true, messages(r));
  assert.deepEqual(resolveInhabitMap(r.ast.inhabit, 0), { 1: '0a', '0b': '2' });
});

test('several guests may share a host across lines', () => {
  const r = parse('# inhabit 0 1', '# inhabit 0 2');
  assert.equal(r.valid, true, messages(r));
  assert.deepEqual(resolveInhabitMap(r.ast.inhabit, 0), { 1: '0', 2: '0' });
});

test('the mini spelling .inhabit("…", "…") lowers to the same thing', () => {
  const r = parseMetaprogram(["'metaprogram editor'", '$: participants("<0 1>")', '.inhabit("<0 ~>", "[1 2b]")'].join('\n'));
  assert.equal(r.valid, true, messages(r));
  assert.deepEqual(r.ast.inhabit[0].hosts, ['0', '~']);
  assert.deepEqual(r.ast.inhabit[0].guests, ['1', '2b']);
  const quoted = parseMetaprogram(["'metaprogram editor'", '$: participants("<0 1>").inhabit("0", "1")'].join('\n'));
  assert.equal(quoted.valid, true, messages(quoted));
  assert.deepEqual(quoted.ast.inhabit[0].guests, ['1']);
});

test('# inhabit stays out of the effects chain', () => {
  const r = parse('# inhabit 0 1', '# crush "wcl" 1');
  assert.deepEqual(r.ast.chain.map((c) => c.fn), ['crush']);
});

test('a program without # inhabit has an empty list', () => {
  assert.deepEqual(parse().ast.inhabit, []);
});

for (const [line, pattern] of [
  ['# inhabit 0 0', /cannot inhabit themselves/],
  ['# inhabit <0 1> 1', /cannot inhabit themselves/],
  ['# inhabit [0 1] 2', /one host at a time/],
  ['# inhabit 0 <1 2>', /guests are a set/],
  ['# inhabit 0 ~', /must be a participant token, not a rest/],
  ['# inhabit 0 [1 1]', /listed twice/],
  ['# inhabit 0 []', /empty inhabit guest set/],
  ['# inhabit <> 1', /empty inhabit host pattern/],
  ['# inhabit <0 1>*2 3', /only '\/n' slows/],
  ['# inhabit <0 [1 2]> 3', /one host per step/],
  ['# inhabit 0', /got 'end of line'/],
  ['# inhabit x 1', /expected a host/],
  ['# inhabit "2B" 1', /not a participant token/],
  ['# inhabit 0 1 2', /unexpected argument/],
  ['# inhabit <0 1', /unclosed inhabit host pattern/],
]) {
  test(`${line} is refused`, () => {
    const r = parse(line);
    assert.equal(r.valid, false);
    assert.match(messages(r), pattern);
  });
}

test('a guest named in two # inhabit lines is refused', () => {
  const r = parse('# inhabit 0 1', '# inhabit 2 [3 1]');
  assert.equal(r.valid, false);
  assert.match(messages(r), /already a guest in an earlier # inhabit line/);
});

test('an error in # inhabit does not swallow the next statement', () => {
  const r = parse('# inhabit 0 0', '# crush "wcl" 1');
  assert.deepEqual(r.ast.chain.map((c) => c.fn), ['crush']);
});
