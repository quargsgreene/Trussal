import test from 'node:test';
import assert from 'node:assert/strict';

import { wrapAsVoice } from '../src/strudel-voice.js';
function isValidJs(code) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`"use strict"; return (async () => {\n${code}\n});`);
    return true;
  } catch {
    return false;
  }
}

test('strudel-voice: a bare pattern with no label becomes an anonymous voice', () => {
  const out = wrapAsVoice('s("bd sd")', '');
  assert.equal(out, '$: (s("bd sd"))');
  assert.ok(isValidJs(out));
});

test('strudel-voice: fx is appended after the anonymous voice', () => {
  const out = wrapAsVoice('s("bd sd")', '.gain(.5)');
  assert.equal(out, '$: (s("bd sd")).gain(.5)');
  assert.ok(isValidJs(out));
});

test('strudel-voice: an already-labeled voice passes through when fx is empty', () => {
  const out = wrapAsVoice('$: s("bd sd")', '');
  assert.equal(out, '$: s("bd sd")');
});

test('strudel-voice: fx wraps the FULL multi-line body of a label, not just its first line', () => {
  // The old per-line regex spliced the suffix in after the first line,
  // breaking any chain (or template literal) that continued past it.
  const code = `$: css(\`.foo {
     &:hover { color: red }
   }\`)
     .color("<#fff #000>")
     .fast(3)`;
  const out = wrapAsVoice(code, '.gain(.5)');
  assert.ok(isValidJs(out), out);
  assert.ok(out.trimEnd().endsWith('.gain(.5)'), 'fx lands once, at the very end');
  assert.equal((out.match(/\.gain\(/g) || []).length, 1);
});

test('strudel-voice: a trailing UNLABELED pattern after a label is wrapped, not dropped', () => {
  // This is the audio-silent bug: a performer's one "real" voice, left
  // unlabeled because it needs no name, sitting after a $: css(...) voice.
  const code = '$: css(`.foo{color:red}`)\n\nn("<0 1 2 3 4>*8").s("piano")';
  const out = wrapAsVoice(code, '');
  assert.match(out, /\$: \(n\("<0 1 2 3 4>\*8"\)\.s\("piano"\)\)/, 'the trailing pattern got its own anonymous voice');
  assert.ok(isValidJs(out));
});

test('strudel-voice: a capability declaration stays bare, not wrapped as a pattern', () => {
  const out = wrapAsVoice('await initTextCycles()\n$: word("hi")', '');
  assert.ok(out.startsWith('await initTextCycles()\n'), 'the declaration is not wrapped in $: (...)');
  assert.doesNotMatch(out, /\$: \(await initTextCycles/);
  assert.ok(isValidJs(out));
});

test('strudel-voice: the exact shape captured live — Hydra split off, text+css declared inline with their own voices, trailing unlabeled audio pattern', () => {
  // What survives hydra-code.js's splitHydraCode().strudel for a performer who
  // wrote Hydra + Text Cycles + CSS Cycles + Strudel in one editor, exactly as
  // captured from a live room's peer-state bus.
  const code = [
    'await initTextCycles()',
    '$: typeface(\'Times New Roman\').word("<I like squirrels>")',
    '     .weight("400 200")',
    '',
    'await initCss()',
    '$: css(`.foo { color: red }`)',
    '     .fast(4)',
    '',
    'n("<0 1 2 3 4>*8").s("gm_lead_6_voice")',
  ].join('\n');
  const out = wrapAsVoice(code, '');
  assert.ok(isValidJs(out), out);
  // Declarations stay bare.
  assert.doesNotMatch(out, /\$: \(await init/);
  // Both labeled voices survive intact.
  assert.match(out, /\$: typeface\(/);
  assert.match(out, /\$: css\(/);
  // The trailing plain pattern is no longer orphaned.
  assert.match(out, /\$: \(n\("<0 1 2 3 4>\*8"\)\.s\("gm_lead_6_voice"\)\)/);
});

test('strudel-voice: declarations with a trailing expression and no label still work (existing behaviour)', () => {
  const out = wrapAsVoice('let x = 5\nn(x)', '.gain(.5)');
  assert.equal(out, 'let x = 5\n$: (n(x)).gain(.5)');
  assert.ok(isValidJs(out));
});

test('strudel-voice: empty input is returned unchanged', () => {
  assert.equal(wrapAsVoice('', ''), '');
  assert.equal(wrapAsVoice('   ', ''), '   ');
});

test('strudel-voice: several labeled voices in one paragraph each get their own wrapper', () => {
  // The JPattern slot gate is appended to every voice, so fx is never empty
  // in a room. Wrapping from the first label to the end nested the second
  // `$:` inside the first one's parens and took the whole program down.
  const code = '$: s("bd*4")\n  .gain(.8)\n$: s("hh*8")\nmelody: n("0 2 4").s("piano")';
  const out = wrapAsVoice(code, '.gain(_jpGate("p"))');
  assert.ok(isValidJs(out), out);
  assert.equal(out, [
    '$: (s("bd*4")\n  .gain(.8)).gain(_jpGate("p"))',
    '$: (s("hh*8")).gain(_jpGate("p"))',
    'melody: (n("0 2 4").s("piano")).gain(_jpGate("p"))',
  ].join('\n'));
});

test('strudel-voice: label-looking lines inside strings, templates and brackets are not split on', () => {
  const code = [
    '$: css(`.x {',
    'color: red',
    '}`).fast(2)',
    '$: s("bd").every(2, (p) => {',
    'x: return p.fast(2)',
    '})',
  ].join('\n');
  const out = wrapAsVoice(code, '.gain(.5)');
  assert.ok(isValidJs(out), out);
  assert.equal((out.match(/\.gain\(\.5\)/g) || []).length, 2, 'exactly the two real voices are wrapped');
  assert.match(out, /\ncolor: red\n/, 'the template body is untouched');
});

test('strudel-voice: // comments never swallow the wrapper or become a voice', () => {
  const fx = '.gain(.5)';
  for (const code of [
    '// my beat\n$: s("bd*4")',
    '$: s("bd*4") // kick',
    '// just a note',
    's("bd*4") // unlabeled, commented',
    '// tokyo: rain\n$: s("bd")\n$: s("hh") // hats',
    'let x = 2\nn(x) // tail',
  ]) {
    const out = wrapAsVoice(code, fx);
    assert.ok(isValidJs(out), `${code}\n→\n${out}`);
    assert.doesNotMatch(out, /\$: \(\/\//, `a comment is never wrapped as a voice: ${out}`);
  }
  assert.equal(wrapAsVoice('// just a note', fx), '// just a note');
});

test('strudel-voice: blank lines inside a statement are layout, not paragraph breaks', () => {
  // The strudel.cc shape that silently took the program down: blank lines
  // inside a chain, inside a spaced-out arrange(...)/stack(...), and between
  // a labeled voice and its trailing .gain(...). Each was split off as its
  // own `$: (...)` fragment — `$: (.slow(8))`, `$: ([8, stack()` — a
  // SyntaxError in the combined program.
  const code = [
    'let dehisence = s("dehisence:1")',
    '',
    '.slow(8)',
    '',
    '//.rarely(x=>x.ply(2))',
    '',
    'let hats = s("hh*8").',
    '',
    'gain(.5)',
    '',
    'setcpm(128/4)',
    '',
    'let song = arrange(',
    '',
    '  [8, dehisence],',
    '',
    '  [8, stack(',
    '',
    '    dehisence,',
    '',
    '    hats,',
    '',
    '  )],',
    '',
    ')',
    '',
    'everything: arrange(',
    '  [16, song.cpm(120/4)]',
    ')',
    '',
    '.gain(slider(1, 0, 1, 0.1))',
  ].join('\n');
  for (const fx of ['', '.gain(_jpGate("p"))']) {
    const out = wrapAsVoice(code, fx);
    assert.ok(isValidJs(out), out);
    assert.doesNotMatch(out, /\$: \(\s*[.,\[\])]/, `no voice is a statement fragment: ${out}`);
    // Only the tempo call and the one real voice are voices.
    assert.deepEqual(out.match(/^[$\w]+:/gm), ['$:', 'everything:']);
  }
  const out = wrapAsVoice(code, '.gain(.5)');
  assert.ok(out.trimEnd().endsWith('.gain(slider(1, 0, 1, 0.1))).gain(.5)'), 'fx wraps the voice including its trailing chain');
});

test('strudel-voice: with no label, the last statement is the voice and everything above it stays bare', () => {
  const cases = [
    // A multi-line declaration: its chain lines are not the expression.
    ['let a = s("bd")\n  .fast(2)\na', 'let a = s("bd")\n  .fast(2)\n$: (a).gain(.5)'],
    ['let a = s("bd")\n\n.fast(2)\n\na.room(1)', 'let a = s("bd")\n\n.fast(2)\n$: (a.room(1)).gain(.5)'],
    // Statements that are not declarations, as strudel.cc programs open.
    ['setcpm(120/4)\n\ns("bd*4")\n  .bank("tr909")', 'setcpm(120/4)\n$: (s("bd*4")\n  .bank("tr909")).gain(.5)'],
    ["await samples('github:tidalcycles/dirt-samples')\ns(\"bd\")", "await samples('github:tidalcycles/dirt-samples')\n$: (s(\"bd\")).gain(.5)"],
    // A trailing comment stays with the voice above it.
    ['let x = 2\nn(x)\n// the end', 'let x = 2\n$: (n(x)\n// the end\n).gain(.5)'],
  ];
  for (const [code, expected] of cases) {
    const out = wrapAsVoice(code, '.gain(.5)');
    assert.equal(out, expected);
    assert.ok(isValidJs(out), out);
  }
  // Declarations only: nothing to play, returned as written.
  assert.equal(wrapAsVoice('let a = s("bd")\n\n.fast(2)', '.gain(.5)'), 'let a = s("bd")\n\n.fast(2)');
});
