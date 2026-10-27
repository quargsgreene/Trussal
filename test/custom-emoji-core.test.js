import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_EMOJI,
  MAX_EMOJI_BYTES,
  emojiNameFromFilename,
  sanitizeEmojiList,
  splitShortcodes,
  speakableShortcodes,
  stripShortcodes,
} from '../src/custom-emoji-core.js';

const png = (name, data = 'iVBORw0KGgo=') => ({ name, mime: 'image/png', data });

test('a filename becomes a shortcode-safe name, numbered when taken', () => {
  assert.equal(emojiNameFromFilename('Party Cat!.GIF'), 'party_cat');
  assert.equal(emojiNameFromFilename('Café.png'), 'cafe');
  assert.equal(emojiNameFromFilename('😀.png'), 'emoji');
  assert.equal(emojiNameFromFilename('cat.png', new Set(['cat', 'cat_2'])), 'cat_3');
});

test('a peer list keeps only valid, small, uniquely named images', () => {
  const big = 'A'.repeat(Math.ceil((MAX_EMOJI_BYTES + 10) / 3) * 4);
  const out = sanitizeEmojiList([
    png('cat'), png('cat'), png('Bad Name'), { name: 'svg', mime: 'image/svg+xml', data: 'AAAA' },
    png('huge', big), png('dog', 'not base64!'), png('ok'), null,
  ]);
  assert.deepEqual(out.map((e) => e.name), ['cat', 'ok']);
  assert.equal(sanitizeEmojiList(Array.from({ length: MAX_EMOJI + 5 }, (_, i) => png(`e${i}`))).length, MAX_EMOJI);
  assert.deepEqual(sanitizeEmojiList('nope'), []);
});

test('only known shortcodes split out of a word', () => {
  const known = (n) => n === 'cat';
  assert.deepEqual(splitShortcodes('hi:cat:there :dog:', known), [{ text: 'hi' }, { emoji: 'cat' }, { text: 'there :dog:' }]);
  assert.deepEqual(splitShortcodes(':cat::cat:', known), [{ emoji: 'cat' }, { emoji: 'cat' }]);
  assert.deepEqual(splitShortcodes('bd:3', known), [{ text: 'bd:3' }]);
});

test('speech reads a shortcode as its name, or skips it', () => {
  assert.equal(speakableShortcodes('hello :party_cat:'), 'hello party cat');
  assert.equal(stripShortcodes('مرحبا :cat:'), 'مرحبا');
  assert.equal(stripShortcodes(':cat:'), '');
});
