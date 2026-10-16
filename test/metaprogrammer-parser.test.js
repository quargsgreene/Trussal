import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMetaprogram,
  resolveEffectParams,
  buildDefaultProgram,
  mosaicEnabled
} from './helpers/metaprogram.js';
// The unwrapped parser, for the directive-requirement tests themselves.
import { parseMetaprogram as parseMetaprogramRaw } from '../src/audio-net/MetaprogrammerParser.js';

test("the wrong directive is named, not guessed past", () => {
  const res = parseMetaprogramRaw("'personal editor'\n$ participants <0>\n");
  assert.ok(res.errors.some(e => /not a metaprogram/.test(e.message)));
});

test("a correct 'metaprogram editor' directive parses, single or double quoted", () => {
  assert.equal(parseMetaprogramRaw("'metaprogram editor'\n$ participants <0>\n").valid, true);
  assert.equal(parseMetaprogramRaw('"metaprogram editor"\n$ participants <0>\n').valid, true);
});

test("the legacy 'metaprogram' directive alias still parses", () => {
  assert.equal(parseMetaprogramRaw("'metaprogram'\n$ participants <0>\n").valid, true);
  assert.equal(parseMetaprogramRaw('"metaprogram"\n$ participants <0>\n').valid, true);
});

function ok(text) {
  const res = parseMetaprogram(text);
  assert.deepEqual(res.errors, [], `expected no errors for:\n${text}`);
  return res.ast;
}

function bad(text, pattern) {
  const res = parseMetaprogram(text);
  assert.ok(res.errors.length > 0, `expected errors for:\n${text}`);
  if (pattern) {
    assert.ok(
      res.errors.some(e => pattern.test(e.message)),
      `expected an error matching ${pattern}, got:\n${res.errors.map(e => e.message).join('\n')}`
    );
  }
  return res.errors;
}

// --- mini surface notation (Strudel-style $: … .method(…)) ----------------

test('mini: the spec example parses to the same AST as its mondo equivalent', () => {
  const mini = ok('$: participants("<0 1>").cycles("wcl", 10).room("wcl", 30)');
  const mondo = ok('$ participants <0 1>\n# cycles "wcl" 10\n# room "wcl" 30\n');
  assert.deepEqual(mini.participants.stacks[0].elements.map(e => e.token),
    mondo.participants.stacks[0].elements.map(e => e.token));
  assert.deepEqual(mini.cycles, mondo.cycles);
  assert.deepEqual(mini.chain.map(c => c.fn), mondo.chain.map(c => c.fn));
  assert.deepEqual(resolveEffectParams(mini.chain[0]), resolveEffectParams(mondo.chain[0]));
});

test('mini: [ … ] subdivides, exactly as the bare mondo form does', () => {
  assert.equal(ok('$: participants("[0 1 2]")').participants.mode, 'subdivide');
});

test("mixing mini and mondo in one buffer is a parse error", () => {
  bad('$: participants("<0>")\n# cycles "wcl" 10', /entirely in one notation/);
});


test('mondo: (cat …) is the same sequence as <…>', () => {
  const a = ok('$ (cat 0 1a 2zzz)\n# cycles "wcl" 3\n');
  assert.equal(a.participants.mode, 'alternate');
  assert.deepEqual(a.participants.stacks[0].elements.map(e => e.token), ['0', '1a', '2zzz']);
});


test('mondo: (fast N X) and (slow N X) are X*N / X/N', () => {
  assert.deepEqual(ok('$ (fast 2 (seq 0 1))\n').participants.modifiers, [{ op: '*', value: 2 }]);
  assert.deepEqual(ok('$ (slow 3 (cat 0 1))\n').participants.modifiers, [{ op: '/', value: 3 }]);
});

test('mosaic: the aggregator tiles unless the program says otherwise', () => {
  assert.equal(mosaicEnabled(ok('$ participants <0>\n')), true);
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic\n')), true);
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic true\n')), true);
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic false\n')), false);
});

test('mosaic: an unparseable program falls back to the default rather than dark', () => {
  assert.equal(mosaicEnabled(null), true);
  assert.equal(mosaicEnabled({}), true);
});

test('structural errors: unclosed and mismatched brackets, missing participants', () => {
  bad('$ participants <0 1\n', /unclosed sequence/);
  bad('$ participants <0 1]\n', /mismatched/);
  bad('# cycles "wcl"\n', /missing '\$'/);
  bad('', /missing '\$'/);
  bad('$ participants <>\n', /empty sequence/);
});

test('whitelisted pattern functions parse; anything else is rejected', () => {
  ok('$ participants <0>\n# shuffle 4\n# degrade\n# degradeBy 0.5\n# undegrade\n# undegradeBy 0.1\n# hush\n');
  bad('$ participants <0>\n# lpf 200\n', /not a JPattern function/);
  bad('$ participants <0>\n# osc 10\n', /not a JPattern function/);   // Hydra
  bad('$ participants <0>\n# range 0 1\n', /not a JPattern function/);
});

test('room requires a metric keyword; scale and pinned amount are optional', () => {
  // Bare `# room wcl` → live wcl at scale 1.
  let ast = ok('$ participants <0>\n# room "wcl"\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 1, fixedMetric: null });
  // `# room wcl 2` → decay 2 × live wcl.
  ast = ok('$ participants <0>\n# room "wcl" 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedMetric: null });
  // Any worst-case metric may drive the decay, as it may drive crush.
  for (const metric of ['wcl', 'wcj', 'wcpl', 'wcrtt']) {
    ast = ok(`$ participants <0>\n# room "${metric}" 2\n`);
    assert.equal(resolveEffectParams(ast.chain[0]).metric, metric);
  }
  // The retired bare-number form is still a parse error.
  bad('$ participants <0>\n# room\n', /needs a quoted metric keyword/);
  bad('$ participants <0>\n# room 2\n', /needs a quoted metric keyword/);
  bad('$ participants <0>\n# room 2 0.4\n', /needs a quoted metric keyword/);
  bad('$ participants <0>\n# room wcx 2\n', /needs a quoted metric keyword/);
});


test('`*`-prefixed statements are inert button declarations, not program', () => {
  // A declared voice does not join the ring, and a declared effect does not
  // join the chain — the button is what puts them there.
  const ast = ok(`$ participants <0>
*$ participants <2a 2b>
# cycles "wcl" 20
*# crush "wcl" 2 // a declaration may carry a comment
`);
  assert.deepEqual(ast.participants.stacks[0].elements.map(e => e.token), ['0']);
  assert.deepEqual(ast.chain, []);
  // Whitespace around the '*' and the sigil is allowed, as it is on statements.
  ok('$ participants <0>\n  *  $ participants <1>\n');
  // Declarations do not stand in for the required scheduling sequence.
  bad('*$ participants <0>\n', /missing '\$'/);
  // A declaration never swallows the statements below it.
  bad('$ participants <0>\n*# crush "wcl" 2\n# lpf 200\n', /not a JPattern function/);
  // A bare '*' is still junk: it declares nothing.
  bad('$ participants <0>\n* crush "wcl" 2\n', /expected '\$' or '#'/);
  // A declaration ending the text, with no newline after it.
  ok('$ participants <0>\n*# crush "wcl" 2');
  ok('$ participants <0>\n*$');
});

test('comments and blank lines anywhere are ignored', () => {
  ok('// leading comment\n\n$ participants <0 1> // trailing\n\n// between\n# cycles "wcpl"\n');
});

// --- Data-pack references --------------------------------------------------

const PARTS = '$ participants <0>\n';

test('a data reference is accepted wherever a pattern argument is', () => {
  const ast = ok(`${PARTS}# crush "wcl" Weather:3`);
  assert.match(JSON.stringify(ast), /"type":"dataRef","name":"Weather","index":3/);
});

test('a data reference works as a term inside a pattern', () => {
  const ast = ok(`${PARTS}# crush "wcl" <Weather:1 4>`);
  assert.match(JSON.stringify(ast), /"type":"dataRef","name":"Weather","index":1/);
});

test('a data reference does not loosen what a pattern may hold', () => {
  bad(`${PARTS}# crush "wcl" <"wcl" Weather:1>`, /pattern expects positive numbers/);
});

test('# cycles reads fixed numbers, so it names the limit rather than reporting an object', () => {
  const errors = bad(`${PARTS}# cycles "wcl" Weather:3`, /cannot read 'Weather:3'/);
  assert.ok(!errors.some(e => /\[object Object\]/.test(e.message)),
    'the token is reported as it was written');
});

test('the colon binds an identifier to digits and nothing else', () => {
  ok(`${PARTS}# cycles "wcl" 20`, 'a plain numeric argument is untouched');
  bad(`${PARTS}# crush "wcl" :3`);
});

// --- # ring (consistent-hash turn ordering) ----------------------------------

test('a bare # ring parses to a hash-mode ring node; an unwritten # ring stays null', () => {
  assert.equal(ok(PARTS).ring, null);
  assert.deepEqual(ok(`${PARTS}# ring`).ring, { mode: 'hash', weights: {} });
  assert.deepEqual(ok(`${PARTS}# ring explicit`).ring, { mode: 'explicit', weights: {} });
});

test('# ring takes optional w <token> <weight> pairs', () => {
  assert.deepEqual(ok(`${PARTS}# ring w 0 3 1 2`).ring,
    { mode: 'hash', weights: { '0': 3, '1': 2 } });
});

test('the default program has no # ring, so a fresh room orders participants manually', () => {
  const text = buildDefaultProgram();
  assert.doesNotMatch(text, /# ring/, 'the hash ring is opt-in, never the default');
  const { ast, valid } = parseMetaprogram(text);
  assert.ok(valid, 'the default program parses');
  assert.equal(ast.ring, null, 'no ring node -> the written $ participants order is walked');
});
