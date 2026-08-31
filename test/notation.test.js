import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectNotation, mondoToMini, miniToMondo, toConsumableNotation,
} from '../src/notation.js';

// --- detectNotation ------------------------------------------------------

test('detectNotation: the opener decides for the whole buffer', () => {
  assert.equal(detectNotation('$: participants("<0 1>").cycles("wcl", 10)'), 'mini');
  assert.equal(detectNotation('$ participants <0 1>\n# cycles "wcl" 10'), 'mondo');
  assert.equal(detectNotation('# cycles "wcl" 10'), 'mondo');            // a bare chain line is still mondo
  assert.equal(detectNotation('s("bd sd")'), null);                      // plain Strudel — no voice marker
  assert.equal(detectNotation('$: s("bd")'), 'mini');                    // Strudel labelled voice
  assert.equal(detectNotation(''), null);
});

test('detectNotation: a buffer that mixes the two is "mixed"', () => {
  assert.equal(detectNotation('$: a("<0>")\n# b 1'), 'mixed');
  assert.equal(detectNotation('$ a <0>\n$: b("x")'), 'mixed');
});

test('detectNotation: mid-line "#" (Strudel control-merge) is not a mondo marker', () => {
  assert.equal(detectNotation('s("bd") # gain("0.8")'), null);
});

test('detectNotation: a full-line comment never decides', () => {
  assert.equal(detectNotation('// $ participants <0>\ns("bd")'), null);
});

// --- mondo -> mini (personal / bot) ------------------------------------

test('mondoToMini: the spec example, line for line', () => {
  assert.equal(
    mondoToMini('$ typeface "Monaco"\n# word "something"'),
    '$: typeface("Monaco")\n.word("something")',
  );
});

test('mondoToMini: a bare <…> / […] token becomes a quoted mini string', () => {
  assert.equal(mondoToMini('$ n <0 1 2>\n# room 2'), '$: n("<0 1 2>")\n.room(2)');
  assert.equal(mondoToMini('$ s [bd sd]'), '$: s("[bd sd]")');
});

test('mondoToMini: a quoted string, a bare word and a JS expression pass through', () => {
  assert.equal(mondoToMini('$ s "gm_lead_6_voice"\n# lpf sine'), '$: s("gm_lead_6_voice")\n.lpf(sine)');
  assert.equal(mondoToMini('# lpf (sine.range(200,2000))'), '.lpf((sine.range(200,2000)))');
});

test('mondoToMini: a Hydra preamble, blank lines and comments are untouched', () => {
  const src = 'await initHydra()\n\n// a voice\n$ n <0 1>\n# s "piano"';
  assert.equal(mondoToMini(src), 'await initHydra()\n\n// a voice\n$: n("<0 1>")\n.s("piano")');
});

test('mondoToMini: a single-line backtick arg (CSS Cycles) is one token', () => {
  assert.equal(
    mondoToMini('$ css `.x { color: red }`\n# fast 3'),
    '$: css(`.x { color: red }`)\n.fast(3)',
  );
});

test('mondoToMini: live() with a device label and a mini struct', () => {
  assert.equal(
    mondoToMini('$ live "Scarlett 2i2 (Focusrite)"\n# struct <x ~ x>'),
    '$: live("Scarlett 2i2 (Focusrite)")\n.struct("<x ~ x>")',
  );
});

// --- mini -> mondo (metaprogram) -------------------------------------

test('miniToMondo: the spec example, one-liner and multi-line both', () => {
  const want = '$ participants <0 1>\n# cycles "wcl" 10\n# room "wcl" 30';
  assert.equal(miniToMondo('$: participants("<0 1>").cycles("wcl", 10).room("wcl", 30)'), want);
  assert.equal(miniToMondo('$: participants("<0 1>")\n.cycles("wcl", 10)\n.room("wcl", 30)'), want);
});

test('miniToMondo: only a "<…>"/"[…]" string is unquoted; a metric stays quoted', () => {
  assert.equal(miniToMondo('$: participants("[0 1 2]").cycles("wcpl", 3)'),
    '$ participants [0 1 2]\n# cycles "wcpl" 3');
});

test('miniToMondo: non-$: lines pass through', () => {
  assert.equal(miniToMondo('// note\n$: participants("<0>")'), '// note\n$ participants <0>');
});

// --- toConsumableNotation -------------------------------------------

test('toConsumableNotation lowers to the target editor\'s form, or flags a mix', () => {
  assert.equal(toConsumableNotation('$ x <0>\n# y 1', 'mini').text, '$: x("<0>")\n.y(1)');
  assert.equal(toConsumableNotation('$: x("<0>").y(1)', 'mondo').text, '$ x <0>\n# y 1');
  assert.equal(toConsumableNotation('s("bd")', 'mini').text, 's("bd")');       // pass-through
  assert.ok(toConsumableNotation('$: a("x")\n# b 1', 'mini').error);
});
