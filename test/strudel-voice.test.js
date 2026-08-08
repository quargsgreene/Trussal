import test from 'node:test';
import assert from 'node:assert/strict';

import { wrapAsVoice } from '../src/strudel-voice.js';

// Real syntax check (matches bots/src/script-gen/validate.js's own approach):
// parse-only via the Function constructor, never invoked.
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

test('strudel-voice: multiple labeled voices with a suffix never collapse into one grouping expression', () => {
  // This is the bots crash: variation.js used to wrap the WHOLE multi-voice
  // master in one `(...)`, which is a SyntaxError the moment there is more
  // than one top-level statement — exactly what a css()+audio combo produces.
  const code = '$: css(`.foo{color:red}`)\n     .fast(3)\n\n$: n("<0 1 2 3 4>*8").s("gm_lead_6_voice")';
  const out = wrapAsVoice(code, '.delay(.4).gain(.5)');
  assert.ok(isValidJs(out), out);
  assert.equal((out.match(/\.delay\(\.4\)\.gain\(\.5\)/g) || []).length, 2, 'fx applied per voice');
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
