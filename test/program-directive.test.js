import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readDirective, hasDirective, stripDirective, ensureDirective, retagDirective,
  PERSONAL, METAPROGRAM, BOT,
} from '../src/program-directive.js';

test('reads each kind from a leading single- or double-quoted line', () => {
  assert.equal(readDirective("'personal program'\ns(\"bd\")").kind, 'personal');
  assert.equal(readDirective('"metaprogram"\n$ participants <0>').kind, 'metaprogram');
  assert.equal(readDirective("'bot program'\nn(\"0 2\")").kind, 'bot');
});

test('allows blank lines and comments above the directive', () => {
  const src = '\n// a note\n\n   \n\'metaprogram\'\n$ participants <0>';
  const info = readDirective(src);
  assert.equal(info.kind, 'metaprogram');
  assert.equal(info.lineIndex, 4);
});

test('a missing or unrecognised directive is an error, not a guess', () => {
  assert.equal(readDirective('$ participants <0>\n# cycles wcl 20').kind, null);
  assert.equal(readDirective('s("bd sd")').kind, null);
  assert.equal(readDirective('').kind, null);
  assert.equal(readDirective("'meta program'\n$ participants <0>").kind, null);
});

test('a quoted phrase that is not the whole first line does not count', () => {
  assert.equal(readDirective('n("metaprogram")').kind, null);
  assert.equal(readDirective("s('bot program' + x)").kind, null);
});

test('stripDirective blanks the line in place, preserving line numbers', () => {
  const src = "'personal program'\nawait initHydra()\n\ns(\"bd\")";
  const out = stripDirective(src);
  assert.equal(out, '\nawait initHydra()\n\ns("bd")');
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripDirective leaves an already-invalid buffer untouched', () => {
  assert.equal(stripDirective('s("bd")'), 's("bd")');
});

test('ensureDirective prepends only when absent', () => {
  assert.equal(ensureDirective('$ participants <0>', 'metaprogram'), "'metaprogram'\n$ participants <0>");
  const already = "'metaprogram'\n$ participants <0>";
  assert.equal(ensureDirective(already, 'metaprogram'), already);
});

test('retagDirective swaps a personal program for a bot program body-for-body', () => {
  assert.equal(retagDirective("'personal program'\nn(\"0 2\")", 'bot'), "'bot program'\nn(\"0 2\")");
});

test('hasDirective is a straight kind check', () => {
  assert.ok(hasDirective("'personal program'\nx", 'personal'));
  assert.ok(!hasDirective("'personal program'\nx", 'bot'));
});

test('phrase constants are the exact strings', () => {
  assert.equal(PERSONAL, 'personal program');
  assert.equal(METAPROGRAM, 'metaprogram');
  assert.equal(BOT, 'bot program');
});
