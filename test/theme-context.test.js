import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isHexColor,
  normalizeHex,
  effectiveAnchors,
  isFontScale,
  normalizeFontScale,
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  DEFAULT_FONT_SCALE,
  MIN_FONT_SCALE,
  MAX_FONT_SCALE,
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

test('isFontScale accepts in-range numbers and numeric strings, rejects the rest', () => {
  for (const ok of [1, 2, MIN_FONT_SCALE, MAX_FONT_SCALE, '1.5', '3']) {
    assert.equal(isFontScale(ok), true, String(ok));
  }
  for (const bad of [0, -1, MAX_FONT_SCALE + 0.1, 'huge', '', null, undefined, NaN]) {
    assert.equal(isFontScale(bad), false, String(bad));
  }
});

test('normalizeFontScale coerces and clamps, else falls back to the default', () => {
  assert.equal(normalizeFontScale(2), 2);
  assert.equal(normalizeFontScale('1.5'), 1.5);
  assert.equal(normalizeFontScale(0), MIN_FONT_SCALE);       // clamped up
  assert.equal(normalizeFontScale(999), MAX_FONT_SCALE);     // clamped down
  assert.equal(normalizeFontScale('not a number'), DEFAULT_FONT_SCALE);
  assert.equal(normalizeFontScale(''), DEFAULT_FONT_SCALE);
  assert.equal(normalizeFontScale(undefined), DEFAULT_FONT_SCALE);
});

test('the font list is non-empty and every entry has a label and a value', () => {
  assert.ok(WEB_SAFE_FONTS.length >= 3);
  for (const f of WEB_SAFE_FONTS) {
    assert.equal(typeof f.label, 'string');
    assert.ok(f.value.length > 0);
  }
});
