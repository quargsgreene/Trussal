import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPLAY_NAME_STORAGE_KEY,
  PREJOIN_NAME_INPUT_ID,
  PREJOIN_SCREEN_ID,
  PREMEETING_SCREEN_SELECTORS,
  PREMEETING_SCREEN_SELECTOR,
  prejoinSuppressionCss,
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

test('shouldOwnPrejoin: only when the backend is on and no unattended client', () => {
  assert.equal(shouldOwnPrejoin(), false);
  assert.equal(shouldOwnPrejoin({ libJitsiEnabled: false }), false);
  assert.equal(shouldOwnPrejoin({ libJitsiEnabled: true }), true);
  assert.equal(shouldOwnPrejoin({ libJitsiEnabled: true, isBot: true }), false);
  assert.equal(shouldOwnPrejoin({ libJitsiEnabled: true, isAggregator: true }), false);
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

test('prejoinMarkup keeps the suppressed substrings out of inner classes', () => {
  // The suppression rule hides [class*="prejoin"] / [class*="premeeting"]; the
  // only thing it must spare is our root, which is excluded by id. An inner
  // class carrying the substring would be hidden along with Jitsi's screen.
  const html = prejoinMarkup({ initialName: 'x' });
  assert.ok(!/class="[^"]*(?:prejoin|premeeting)/i.test(html));
});

test('prejoinSuppressionCss hides the native prejoin but spares our root', () => {
  const css = prejoinSuppressionCss();
  assert.match(css, new RegExp(`\\.premeeting-screen:not\\(#${PREJOIN_SCREEN_ID}\\)`));
  assert.match(css, /\[class\*="prejoin"\]/);
  assert.match(css, /display: none !important/);
});

test('PREMEETING_SCREEN_SELECTOR is the shared pre-meeting set the CSS suppresses', () => {
  // meeting-adapter.js's isInMeeting() uses this same string to decide the
  // local user is not yet in the meeting; the suppression rule must cover it.
  assert.match(PREMEETING_SCREEN_SELECTOR, /\.premeeting-screen/);
  assert.match(PREMEETING_SCREEN_SELECTOR, /\[class\*="prejoin"\]/);
  for (const sel of PREMEETING_SCREEN_SELECTORS) {
    assert.ok(prejoinSuppressionCss().includes(`${sel}:not(#${PREJOIN_SCREEN_ID})`));
  }
});
