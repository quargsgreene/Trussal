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

// Mint that records atoms in order, so a test can assert both the emitted
// pattern shape and the literal text carried out-of-band.
function recorder() {
  const seen = [];
  const mint = (text) => {
    seen.push(text);
    return `tc${seen.length - 1}`;
  };
  return { seen, mint };
}

// --- declaration ------------------------------------------------------------

test('initTextCycles declares text presence, initHydra does not', () => {
  assert.equal(hasTextCycles('await initTextCycles()\n\n$: word("hi")'), true);
  assert.equal(hasTextCycles('await initHydra()\n\n$: s("bd")'), false);
  assert.equal(hasTextCycles('$: word("hi")'), false);
});

// --- mini escaping ----------------------------------------------------------

test('operators stay live, words are minted', () => {
  const { seen, mint } = recorder();
  assert.equal(encodeMiniText('<I like@2 ~ squirrels?>', mint), '<tc0 tc1@2 ~ tc2?>');
  assert.deepEqual(seen, ['I', 'like', 'squirrels']);
});

test('escaped ~ and ? become literal text instead of rest and degrade', () => {
  const { seen, mint } = recorder();
  // The exact pattern from the feature request.
  assert.equal(encodeMiniText('<I like \\~ squirrels \\?>', mint), '<tc0 tc1 tc2 tc3 tc4>');
  assert.deepEqual(seen, ['I', 'like', '~', 'squirrels', '?']);
});

test('an escape binds to the adjacent word rather than standing alone', () => {
  const { seen, mint } = recorder();
  assert.equal(encodeMiniText('<squirrels\\? ok>', mint), '<tc0 tc1>');
  assert.deepEqual(seen, ['squirrels?', 'ok']);
});

test('emoji survive, though krill rejects them as bare atoms', () => {
  const { seen, mint } = recorder();
  assert.equal(encodeMiniText('<🐿 🎵>', mint), '<tc0 tc1>');
  assert.deepEqual(seen, ['🐿', '🎵']);
});

test('case is preserved exactly', () => {
  const { seen, mint } = recorder();
  encodeMiniText('McDONALD i', mint);
  assert.deepEqual(seen, ['McDONALD', 'i']);
});

test('numeric operator arguments are structure, not text', () => {
  const { seen, mint } = recorder();
  assert.equal(encodeMiniText('<12px 24px>*2', mint), '<tc0 tc1>*2');
  assert.deepEqual(seen, ['12px', '24px']);
  const r2 = recorder();
  assert.equal(encodeMiniText('a?0.3 b!3 c/2', r2.mint), 'tc0?0.3 tc1!3 tc2/2');
});

test('euclid arguments pass through untouched', () => {
  const { mint } = recorder();
  assert.equal(encodeMiniText('hi(3,8)', mint), 'tc0(3,8)');
});

test('a dot inside a word is text; a lone dot stays a subdivision', () => {
  const r1 = recorder();
  assert.equal(encodeMiniText('google.com', r1.mint), 'tc0');
  assert.deepEqual(r1.seen, ['google.com']);
  const r2 = recorder();
  assert.equal(encodeMiniText('a . b', r2.mint), 'tc0 . tc1');
});

test('colons and hashes are literal, not sample index or comment', () => {
  const { seen, mint } = recorder();
  encodeMiniText('color:#ffffff', mint);
  assert.deepEqual(seen, ['color:#ffffff']);
});

test('a trailing backslash is literal rather than eating the terminator', () => {
  const { seen, mint } = recorder();
  encodeMiniText('back\\', mint);
  assert.deepEqual(seen, ['back\\']);
});

// --- the real grammar -------------------------------------------------------
//
// Parsed with the vendored krill parser rather than a hand-rolled model of it,
// so a fork rebuild that changes the grammar fails here instead of in a set.

test('every encoded pattern parses under the real krill grammar', async () => {
  const krill = await import('../strudel-fork/packages/mini/krill-parser.js');
  const parses = (s) => {
    // mini2ast takes a QUOTED mini string.
    try { krill.parse(`"${s}"`); return true; } catch { return false; }
  };
  const cases = [
    '<I like@2 ~ squirrels?>',
    '<I like \\~ squirrels \\?>',
    '<🐿 🎵 emoji>',
    'color:#ffffff',
    '<12px 24px 10px 1px>*2',
    '<#346234 #bfe968>',
    '<google.com reddit.com ca.gov devry.edu>',
    '400 200 100 800',
  ];
  for (const src of cases) {
    const encoded = encodeMiniText(src, recorder().mint);
    assert.equal(parses(encoded), true, `encoded form must parse: ${src} -> ${encoded}`);
  }
});

test('the escapes and emoji this module exists for are grammar errors raw', async () => {
  const krill = await import('../strudel-fork/packages/mini/krill-parser.js');
  const parses = (s) => { try { krill.parse(`"${s}"`); return true; } catch { return false; } };
  assert.equal(parses('<I like \\~ squirrels \\?>'), false);
  assert.equal(parses('<🐿 🎵>'), false);
});

// --- call rewriting ---------------------------------------------------------

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
  // .size() here is roomsize on a real audio voice; rewriting it would break
  // reverb for the whole room.
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
  // _tcRender carries the dominant trigger, so landing it on an audio voice
  // would silence that voice.
  const { code } = rewriteTextCalls('$: s("bd*4")\n$: word("hi")');
  assert.equal(code.match(/_tcRender/g).length, 1);
  assert.match(code, /s\("bd\*4"\)\n\$: word\("tc0"\)\n\._tcRender\(\)/);
});

test('a trailing comment does not swallow the renderer', () => {
  const { code } = rewriteTextCalls('$: word("hi") // a note');
  assert.match(code, /\/\/ a note\n\._tcRender\(\)/);
});

// Same class of bug as rewriteCssCalls' capability-declaration test: a bare
// `await initCss()` sitting in its own paragraph right after a word() voice
// used to be swept into the SAME statement (splitStatements has no notion of
// a blank line), so `._tcRender()` landed on the declaration itself —
// `await initCss()._tcRender()` throws outright, taking the whole program
// down.
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

test('a shared counter keeps tokens unique across peers', () => {
  const counter = { n: 0 };
  const a = rewriteTextCalls('$: word("one")', { peer: 'a', counter });
  const b = rewriteTextCalls('$: word("two")', { peer: 'b', counter });
  assert.match(a.code, /word\("tc0"\)/);
  assert.match(b.code, /word\("tc1"\)/);
  assert.equal(b.atoms.tc1.peer, 'b');
});

// --- statement scanning -----------------------------------------------------

test('statements split on labels and flag word calls', () => {
  const stmts = splitStatements('$: s("bd")\n$: word("hi")\n  .color("red")');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0].hasWord, false);
  assert.equal(stmts[1].hasWord, true);
});

test('a chained .word() on a continuation line is still detected', () => {
  const stmts = splitStatements('$: typeface("Courier")\n  .word("hi")');
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].hasWord, true);
});

test('slow() does not read as the w alias', () => {
  assert.equal(splitStatements('$: s("bd").slow(2)')[0].hasWord, false);
});

// --- sanitising -------------------------------------------------------------

test('declarations parse from a string or an object', () => {
  assert.deepEqual(sanitizeDeclarations('color: blue; margin: 50%'), [['color', 'blue'], ['margin', '50%']]);
  assert.deepEqual(sanitizeDeclarations({ color: '#333333' }), [['color', '#333333']]);
});

test('declarations that could fetch or break out of the rule are dropped', () => {
  assert.deepEqual(sanitizeDeclarations('background: url(http://evil/x)'), []);
  assert.deepEqual(sanitizeDeclarations('color: red} body{display:none'), []);
  assert.deepEqual(sanitizeDeclarations('color: expression(alert(1))'), []);
  assert.deepEqual(sanitizeDeclarations('width: 1px</style><script>'), []);
  // Legacy code-executing props go; the valid declaration beside them stays.
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
