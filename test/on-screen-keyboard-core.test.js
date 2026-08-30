import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Trie,
  KEYWORDS,
  buildKeywordTrie,
  KEYWORD_TRIE,
  wordPrefixAt,
  predictCompletions,
} from '../src/on-screen-keyboard-core.js';

// --- Trie ------------------------------------------------------------------

test('trie: predicts every word under a prefix, weight-ordered', () => {
  const t = new Trie();
  t.insert('note', 10);
  t.insert('noise', 7);
  t.insert('nonsense', 1);
  assert.deepEqual(t.predict('no', 5), ['note', 'noise', 'nonsense']);
});

test('trie: an empty prefix predicts nothing', () => {
  assert.deepEqual(KEYWORD_TRIE.predict('', 5), []);
});

test('trie: a prefix off the tree predicts nothing', () => {
  assert.deepEqual(KEYWORD_TRIE.predict('zzz', 5), []);
});

test('trie: the prefix itself is included when it is a stored word', () => {
  assert.ok(KEYWORD_TRIE.predict('note', 5).includes('note'));
});

test('trie: limit caps the result count', () => {
  const t = new Trie();
  for (const w of ['sa', 'sb', 'sc', 'sd', 'se']) t.insert(w, 1);
  assert.equal(t.predict('s', 3).length, 3);
});

test('trie: insert keeps the highest weight seen for a word', () => {
  const t = new Trie();
  t.insert('x', 2);
  t.insert('xy', 9);
  t.insert('x', 5);
  assert.deepEqual(t.predict('x', 5), ['xy', 'x']); // xy(9) before x(5)
});

// --- wordPrefixAt ---------------------------------------------------------

test('prefix: identifier ending at the caret', () => {
  assert.equal(wordPrefixAt('s("bd").sl', 10), 'sl');
});

test('prefix: caret mid-string only sees text before it', () => {
  assert.equal(wordPrefixAt('note.fast', 3), 'not');
});

test('prefix: trailing whitespace means no word in progress', () => {
  assert.equal(wordPrefixAt('note ', 5), '');
});

test('prefix: trailing punctuation means no word in progress', () => {
  assert.equal(wordPrefixAt('s("bd").', 8), '');
});

test('prefix: leading $ / _ are valid identifier starts', () => {
  assert.equal(wordPrefixAt('$foo', 4), '$foo');
  assert.equal(wordPrefixAt('_bar', 4), '_bar');
});

test('prefix: a digit cannot start the identifier', () => {
  assert.equal(wordPrefixAt('3', 1), '');
  assert.equal(wordPrefixAt('bd3', 3), 'bd3');
});

test('prefix: missing caret falls back to end of text', () => {
  assert.equal(wordPrefixAt('rota'), 'rota');
});

test('prefix: tolerates null / undefined text', () => {
  assert.equal(wordPrefixAt(undefined, 0), '');
  assert.equal(wordPrefixAt(null, 3), '');
});

// --- predictCompletions -------------------------------------------------

test('predict: ranked completions for the word under the caret', () => {
  const code = 's("bd").ro';
  const out = predictCompletions(code, code.length);
  assert.ok(out.includes('room'));
  assert.ok(out.includes('rotate'));
});

test('predict: the exact word already typed is dropped from suggestions', () => {
  const out = predictCompletions('note', 4);
  assert.ok(!out.includes('note'));
  // "note" is a leaf with no children, so nothing to complete -> empty.
  assert.deepEqual(out, []);
});

test('predict: still returns `limit` items when the exact match is filtered', () => {
  // "s" is a stored word AND the prefix of many others; dropping "s" itself
  // must not shrink the row below the limit.
  const out = predictCompletions('s', 1, { limit: 5 });
  assert.equal(out.length, 5);
  assert.ok(!out.includes('s'));
});

test('predict: nothing in progress -> no suggestions', () => {
  assert.deepEqual(predictCompletions('s("bd") ', 8), []);
  assert.deepEqual(predictCompletions('', 0), []);
});

test('predict: an unknown prefix -> no suggestions', () => {
  assert.deepEqual(predictCompletions('qwxz', 4), []);
});

test('predict: accepts a custom trie', () => {
  const trie = buildKeywordTrie();
  trie.insert('roomy', 99);
  const out = predictCompletions('roo', 3, { trie });
  assert.equal(out[0], 'roomy');
});

// --- KEYWORDS integrity -------------------------------------------------

test('keywords: every entry is [string, positiveWeight]', () => {
  for (const entry of KEYWORDS) {
    assert.equal(entry.length, 2);
    assert.equal(typeof entry[0], 'string');
    assert.ok(entry[0].length > 0);
    assert.ok(Number.isFinite(entry[1]) && entry[1] > 0);
  }
});

test('keywords: no duplicate words', () => {
  const words = KEYWORDS.map(([w]) => w);
  assert.equal(new Set(words).size, words.length);
});
