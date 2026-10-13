import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasTextCycles,
  splitStatements,
  encodeMiniText,
  rewriteTextCalls,
  sanitizeDeclarations,
  sanitizeHref,
  peerTextClass,
} from '../src/text-cycles-core.js';


test('rewrite mints the whole chain and reports the atom table', () => {
  const src = '$: typeface("Times New Roman").word("<I like \\~ squirrels>").size("<12px 24px>*2")';
  const { code, atoms } = rewriteTextCalls(src, { peer: 'abc' });
  assert.match(code, /typeface\("tc0 tc1 tc2"\)/);
  assert.match(code, /word\("<tc3 tc4 tc5 tc6>"\)/);
  assert.match(code, /size\("<tc7 tc8>\*2"\)/);
  assert.equal(atoms.tc5.text, '~');
  assert.equal(atoms.tc5.peer, 'abc');
  assert.equal(atoms.tc7.text, '12px');
});

test('single quotes stay one literal phrase, no mini and no escaping', () => {
  const { code, atoms } = rewriteTextCalls(`$: word('I like ~ squirrels?')`);
  assert.match(code, /word\("tc0"\)/);
  assert.equal(atoms.tc0.text, 'I like ~ squirrels?');
});

test('audio statements are untouched, so borrowed controls keep their meaning', () => {
  const src = '$: s("bd").room(2).size(4)\n$: word("hi").size("12px")';
  const { code } = rewriteTextCalls(src);
  assert.match(code, /s\("bd"\)\.room\(2\)\.size\(4\)/);
  assert.match(code, /word\("tc0"\)\.size\("tc1"\)/);
});

test('interpolated template literals are left for runtime but still render', () => {
  const src = '$: word(`<${a} b>`)';
  const { code, atoms } = rewriteTextCalls(src);
  assert.match(code, /word\(`<\$\{a\} b>`\)/);
  assert.deepEqual(atoms, {});
  assert.match(code, /\._tcRender\(\)/);
});

test('the renderer is attached to text statements only', () => {
  const { code } = rewriteTextCalls('$: s("bd*4")\n$: word("hi")');
  assert.equal(code.match(/_tcRender/g).length, 1);
  assert.match(code, /s\("bd\*4"\)\n\$: word\("tc0"\)\n\._tcRender\(\)/);
});

test('a trailing comment does not swallow the renderer', () => {
  const { code } = rewriteTextCalls('$: word("hi") // a note');
  assert.match(code, /\/\/ a note\n\._tcRender\(\)/);
});

test('a capability declaration in the next paragraph is never swept into the word() statement', () => {
  const src = [
    'await initTextCycles()',
    '',
    '$: word("hi")',
    '',
    'await initCss()',
    '',
    '$: s("bd sd")',
  ].join('\n');
  const { code } = rewriteTextCalls(src);
  assert.doesNotMatch(code, /await\s+initCss\(\)\._tcRender/, 'the declaration never gets the text renderer appended');
  assert.match(code, /\n\._tcRender\(\)\n\nawait initCss\(\)/, 'the word voice keeps its own renderer, cleanly separated');
  assert.match(code, /\$: s\("bd sd"\)$/, 'rewriteTextCalls leaves the audio pattern untouched');
});

test('w and t aliases rewrite; longer names are not eaten by shorter ones', () => {
  const { code, atoms } = rewriteTextCalls('$: t("Courier").w("hey")');
  assert.match(code, /t\("tc0"\)\.w\("tc1"\)/);
  assert.equal(atoms.tc0.text, 'Courier');
  assert.equal(atoms.tc1.text, 'hey');
});

test('statements split on labels and flag word calls', () => {
  const stmts = splitStatements('$: s("bd")\n$: word("hi")\n  .color("red")');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0].hasWord, false);
  assert.equal(stmts[1].hasWord, true);
});


test('slow() does not read as the w alias', () => {
  assert.equal(splitStatements('$: s("bd").slow(2)')[0].hasWord, false);
});

test('declarations parse from a string or an object', () => {
  assert.deepEqual(sanitizeDeclarations('color: blue; margin: 50%'), [['color', 'blue'], ['margin', '50%']]);
  assert.deepEqual(sanitizeDeclarations({ color: '#333333' }), [['color', '#333333']]);
});

test('declarations that could fetch or break out of the rule are dropped', () => {
  assert.deepEqual(sanitizeDeclarations('background: url(http://evil/x)'), []);
  assert.deepEqual(sanitizeDeclarations('color: red} body{display:none'), []);
  assert.deepEqual(sanitizeDeclarations('color: expression(alert(1))'), []);
  assert.deepEqual(sanitizeDeclarations('width: 1px</style><script>'), []);
  assert.deepEqual(sanitizeDeclarations('behavior: x; color: blue'), [['color', 'blue']]);
});

test('layout declarations are allowed — disruption is the point', () => {
  assert.deepEqual(sanitizeDeclarations('margin: 50%'), [['margin', '50%']]);
  assert.deepEqual(sanitizeDeclarations({ 'text-emphasis': '"x"' }), [['text-emphasis', '"x"']]);
});

test('a bare domain gets https; script schemes are refused', () => {
  assert.equal(sanitizeHref('google.com'), 'https://google.com');
  assert.equal(sanitizeHref('https://ca.gov'), 'https://ca.gov');
  assert.equal(sanitizeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(sanitizeHref('javascript:alert(1)'), null);
  assert.equal(sanitizeHref('data:text/html,<script>'), null);
  assert.equal(sanitizeHref(''), null);
});

test('each participant gets a distinct, selector-safe class', () => {
  assert.equal(peerTextClass('abc123'), 'tc-p-abc123');
  assert.notEqual(peerTextClass('a b'), peerTextClass('ab'));
  assert.match(peerTextClass('!!!'), /^tc-p-/);
});