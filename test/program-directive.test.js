import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readDirective, hasDirective, stripDirective, ensureDirective, retagDirective,
  PERSONAL, METAPROGRAM, BOT, BREAKOUT,
} from '../src/program-directive.js';

test('reads each kind from a leading single- or double-quoted line', () => {
  assert.equal(readDirective("'personal editor'\ns(\"bd\")").kind, 'personal');
  assert.equal(readDirective('"metaprogram editor"\n$ participants <0>').kind, 'metaprogram');
  assert.equal(readDirective("'bot editor'\nn(\"0 2\")").kind, 'bot');
  assert.equal(readDirective("'breakout room'\n$ participants <0>").kind, 'breakout');
});


test('a missing or unrecognised directive is an error, not a guess', () => {
  assert.equal(readDirective('$ participants <0>\n# cycles wcl 20').kind, null);
  assert.equal(readDirective('s("bd sd")').kind, null);
  assert.equal(readDirective('').kind, null);
  assert.equal(readDirective("'meta program'\n$ participants <0>").kind, null);
  assert.equal(readDirective("'personal'\ns(\"bd\")").kind, null);
});

test('a quoted phrase that is not the whole first line does not count', () => {
  assert.equal(readDirective('n("metaprogram editor")').kind, null);
  assert.equal(readDirective("s('bot editor' + x)").kind, null);
});


test('stripDirective blanks a legacy directive line too', () => {
  assert.equal(stripDirective("'bot program'\nn(\"0 2\")"), '\nn("0 2")');
});

test('stripDirective leaves an already-invalid buffer untouched', () => {
  assert.equal(stripDirective('s("bd")'), 's("bd")');
});

test('retagDirective swaps a personal editor buffer for a bot editor one body-for-body', () => {
  assert.equal(retagDirective("'personal editor'\nn(\"0 2\")", 'bot'), "'bot editor'\nn(\"0 2\")");
  // …upgrading a legacy alias on the way through.
  assert.equal(retagDirective("'personal program'\nn(\"0 2\")", 'bot'), "'bot editor'\nn(\"0 2\")");
});

test('hasDirective is a straight kind check', () => {
  assert.ok(hasDirective("'personal editor'\nx", 'personal'));
  assert.ok(!hasDirective("'personal editor'\nx", 'bot'));
});