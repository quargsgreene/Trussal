import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isHexColor,
  normalizeHex,
  effectiveAnchors,
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  WEB_SAFE_FONTS,
} from '../src/theme-context.js';

test('isHexColor accepts 3- and 6-digit hex, with or without #', () => {
  for (const ok of ['#111', '#111111', 'abc', 'AABBCC', ' #1a2b3c ']) {
    assert.equal(isHexColor(ok), true, ok);
  }
  for (const bad of ['#12', '#1234', 'red', 'rgb(0,0,0)', '#nothex', '', null, 42]) {
    assert.equal(isHexColor(bad), false, String(bad));
  }
});

test('normalizeHex expands shorthand and lower-cases, else ""', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('DEF'), '#ddeeff');
  assert.equal(normalizeHex('#1A2B3C'), '#1a2b3c');
  assert.equal(normalizeHex('not a colour'), '');
});

test('effectiveAnchors falls back to the documented defaults', () => {
  assert.deepEqual(effectiveAnchors(undefined), {
    primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY,
  });
  assert.deepEqual(effectiveAnchors({ primary: '', secondary: '' }), {
    primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY,
  });
});

test('a filled colour field replaces its anchor', () => {
  assert.deepEqual(effectiveAnchors({ primary: '#fafafa', secondary: '#202020' }), {
    primary: '#fafafa', secondary: '#202020',
  });
});

test('dark mode swaps the resolved pair', () => {
  assert.deepEqual(effectiveAnchors({ darkMode: true }), {
    primary: DEFAULT_SECONDARY, secondary: DEFAULT_PRIMARY,
  });
  // swap happens AFTER the fields are resolved
  assert.deepEqual(effectiveAnchors({ darkMode: true, primary: '#fafafa', secondary: '#202020' }), {
    primary: '#202020', secondary: '#fafafa',
  });
});

test('the font list is non-empty and every entry has a label and a value', () => {
  assert.ok(WEB_SAFE_FONTS.length >= 3);
  for (const f of WEB_SAFE_FONTS) {
    assert.equal(typeof f.label, 'string');
    assert.ok(f.value.length > 0);
  }
});
