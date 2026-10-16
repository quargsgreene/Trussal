import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPLAY_NAME_STORAGE_KEY,
  PREJOIN_NAME_INPUT_ID,
  normaliseDisplayName,
  readStoredDisplayName,
  writeStoredDisplayName,
  shouldOwnPrejoin,
  prejoinMarkup,
} from '../src/prejoin-core.js';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test('normaliseDisplayName trims and rejects non-strings', () => {
  assert.equal(normaliseDisplayName('  Ada  '), 'Ada');
  assert.equal(normaliseDisplayName('   '), '');
  assert.equal(normaliseDisplayName(''), '');
  assert.equal(normaliseDisplayName(null), '');
  assert.equal(normaliseDisplayName(undefined), '');
  assert.equal(normaliseDisplayName(42), '');
});

test('writeStoredDisplayName stores the trimmed name and returns it', () => {
  const s = fakeStorage();
  assert.equal(readStoredDisplayName(s), '');
  assert.equal(writeStoredDisplayName(s, '  Ada  '), 'Ada');
  assert.equal(readStoredDisplayName(s), 'Ada');
});

test('writeStoredDisplayName clears the key for an empty name', () => {
  const s = fakeStorage();
  writeStoredDisplayName(s, 'Ada');
  assert.equal(writeStoredDisplayName(s, '   '), '');
  assert.equal(readStoredDisplayName(s), '');
  assert.equal(s._map.has(DISPLAY_NAME_STORAGE_KEY), false);
});

test('storage helpers tolerate a missing store', () => {
  assert.equal(readStoredDisplayName(null), '');
  assert.equal(writeStoredDisplayName(null, 'Ada'), 'Ada');
});

test('storage helpers tolerate a store that throws (disabled storage)', () => {
  const throwing = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); }, removeItem() { throw new Error('disabled'); } };
  assert.equal(readStoredDisplayName(throwing), '');
  assert.equal(writeStoredDisplayName(throwing, ' Ada '), 'Ada');
});

test('shouldOwnPrejoin: every client owns it except the unattended ones', () => {
  assert.equal(shouldOwnPrejoin(), true);
  assert.equal(shouldOwnPrejoin({}), true);
  assert.equal(shouldOwnPrejoin({ isBot: true }), false);
  assert.equal(shouldOwnPrejoin({ isAggregator: true }), false);
});

test('prejoinMarkup carries the contract the rest of the bundle keys off', () => {
  const html = prejoinMarkup({ initialName: 'Ada' });
  assert.match(html, new RegExp(`id="${PREJOIN_NAME_INPUT_ID}"`));
  assert.match(html, /type="submit"/);
  assert.match(html, /value="Ada"/);
  assert.match(html, /Join meeting/);
});

test('prejoinMarkup escapes a hostile display name', () => {
  const html = prejoinMarkup({ initialName: '"><script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'), 'no raw script tag survives');
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('prejoinMarkup takes a custom button label', () => {
  assert.match(prejoinMarkup({ buttonLabel: 'Enter' }), /Enter/);
});

test('prejoinMarkup carries no inline style attributes', () => {
  // Styling lives in prejoin.css; the markup is class-only so the two can be
  // authored and reviewed separately.
  assert.ok(!/style="/.test(prejoinMarkup({ initialName: 'x' })));
});
