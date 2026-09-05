import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendRendererCalls, stripCalls, keepMatchingStatements } from '../src/silent-voice-core.js';
import { REACTION_CALL_RE } from '../src/reactions-core.js';
import { PANEL_CALL_RE } from '../src/panel-bg-core.js';
import { FILE_CALL_RE } from '../src/file-cycles-core.js';

test('appendRendererCalls attaches the renderer only to a matching statement', () => {
  const code = '$: reaction("su").fast(4)\nother: s("bd sd")';
  const out = appendRendererCalls(code, REACTION_CALL_RE, '._rxRender()');
  assert.match(out, /\$: reaction\("su"\)\.fast\(4\)\n\._rxRender\(\)/);
  assert.doesNotMatch(out, /s\("bd sd"\)\n\._rxRender\(\)/);
});

test('appendRendererCalls is a no-op when nothing matches', () => {
  const code = '$: s("bd sd")';
  assert.equal(appendRendererCalls(code, PANEL_CALL_RE, '._pbRender()'), code);
});

test('stripCalls drops a whole statement, leaving the rest intact', () => {
  const code = '$: reaction("su")\nother: s("bd sd")';
  const out = stripCalls(code, REACTION_CALL_RE);
  assert.doesNotMatch(out, /reaction/);
  assert.match(out, /other: s\("bd sd"\)/);
});

test('stripCalls on an all-matching program leaves nothing behind', () => {
  assert.equal(stripCalls('$: panel("cat.png")', PANEL_CALL_RE), '');
});

test('keepMatchingStatements keeps only the matching statement per paragraph', () => {
  const code = '$: image("cat.png")\nother: s("bd sd")\n\nthird: s("hh*4")';
  const out = keepMatchingStatements(code, FILE_CALL_RE);
  assert.match(out, /image\("cat\.png"\)/);
  assert.doesNotMatch(out, /s\("bd sd"\)/);
  assert.doesNotMatch(out, /s\("hh\*4"\)/);
});

test('keepMatchingStatements drops a paragraph with no match entirely', () => {
  assert.equal(keepMatchingStatements('other: s("bd sd")', FILE_CALL_RE), '');
});
