import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStrudelButtons,
  toggleStrudelSnippet,
  isStrudelSnippetActive,
  STRUDEL_BTN_MARKER
} from '../src/editor-router-core.js';
import { normalizePeerCode } from '../src/hydra-code.js';
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

const BUFFER = `'personal editor'
$: s("bd*4")

*btn: sound("piano:2")
.note("a4 b4 c4")`;

test('editor-router-core: a *name: declaration is a button, continuation lines included', () => {
  assert.deepEqual(parseStrudelButtons(BUFFER), [
    { voiceCode: 'btn: sound("piano:2")\n.note("a4 b4 c4")', label: 'btn', active: false }
  ]);
});

test('editor-router-core: an anonymous $ button is labelled by its code', () => {
  const [b] = parseStrudelButtons(`'personal editor'\n*$: s("hh*8").gain(.4)`);
  assert.equal(b.voiceCode, '$: s("hh*8").gain(.4)');
  assert.equal(b.label, 's("hh*8").gain(.4)');
});

test('editor-router-core: a declaration with no code is not a button', () => {
  assert.deepEqual(parseStrudelButtons(`'personal editor'\n*btn:`), []);
});

test('editor-router-core: pressing writes the voice as its own marked paragraph', () => {
  const [b] = parseStrudelButtons(BUFFER);
  const on = toggleStrudelSnippet(BUFFER, b.voiceCode);
  assert.equal(on, `${BUFFER}\n\nbtn: sound("piano:2")\n.note("a4 b4 c4")${STRUDEL_BTN_MARKER}\n`);
  assert.equal(isStrudelSnippetActive(on, b.voiceCode), true);
  assert.equal(parseStrudelButtons(on)[0].active, true);
});

test('editor-router-core: pressing again takes the voice back out', () => {
  const [b] = parseStrudelButtons(BUFFER);
  const off = toggleStrudelSnippet(toggleStrudelSnippet(BUFFER, b.voiceCode), b.voiceCode);
  assert.equal(off, `${BUFFER}\n`);
  assert.equal(parseStrudelButtons(off)[0].active, false);
});

test('editor-router-core: taking a voice out keeps the paragraphs around it apart', () => {
  const voice = `btn: s("cp")${STRUDEL_BTN_MARKER}`;
  assert.equal(toggleStrudelSnippet(`a\n\n${voice}\n\nb`, 'btn: s("cp")'), 'a\n\nb');
  assert.equal(toggleStrudelSnippet(`a\n\n${voice}\nb`, 'btn: s("cp")'), 'a\n\nb');
});

test('editor-router-core: a hand-written voice is not mistaken for the button\'s', () => {
  const buf = `'personal editor'\nbtn: s("cp")\n\n*btn: s("cp")`;
  assert.equal(parseStrudelButtons(buf)[0].active, false);
  assert.ok(toggleStrudelSnippet(buf, 'btn: s("cp")').startsWith(buf));
});

test('editor-router-core: a $: button is a no-op in a mondo buffer, a named one is not', () => {
  const mondo = `'personal editor'\n$ s "bd*4"\n# gain .5\n\n*$: s("hh")\n*hat: s("hh")`;
  assert.equal(toggleStrudelSnippet(mondo, '$: s("hh")'), mondo);
  const named = toggleStrudelSnippet(mondo, 'hat: s("hh")');
  assert.notEqual(named, mondo);
  assert.ok(isValidJs(normalizePeerCode(named)));
});

test('editor-router-core: a pressed buffer still evaluates once a remote effects chain is wrapped on', () => {
  // strudel-voice.js wraps each paragraph as `label: (body)fx` for a remote
  // peer — the shape a `//` marker or a glued-on voice would break.
  let buf = BUFFER + '\n*$: s("hh*8")';
  for (const b of parseStrudelButtons(buf)) buf = toggleStrudelSnippet(buf, b.voiceCode);
  for (const fx of ['', '.hpf(80).delay(.4).gain(.5)']) {
    const program = wrapAsVoice(normalizePeerCode(buf), fx);
    assert.ok(isValidJs(program), program);
  }
});
