import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WRITING_SYSTEMS,
  PAGE_ROWS,
  PER_ROW,
  writingSystem,
  systemPages,
  keyDef,
  keyLabel,
  composeHangul,
} from '../src/writing-systems-core.js';

test('the menu lists every writing system asked for, Latin first', () => {
  const ids = WRITING_SYSTEMS.map((ws) => ws.id);
  assert.equal(ids[0], 'latin');
  for (const id of [
    'latin-ext', 'arabic', 'hebrew', 'syllabics', 'north-brahmic', 'south-brahmic', 'thaana',
    'armenian', 'cyrillic', 'georgian', 'greek', 'hangul', 'mongolian', 'tifinagh', 'thai',
    'perso-arabic', 'osage', 'cherokee', 'hanzi', 'kana', 'emoji',
  ]) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(writingSystem('nope').id, 'latin');
});

test('every page fits on the keyboard and no page repeats a key', () => {
  for (const ws of WRITING_SYSTEMS) {
    for (const page of systemPages(ws)) {
      assert.ok(page.rows.length >= 1 && page.rows.length <= PAGE_ROWS, `${ws.id}/${page.id} rows`);
      for (const row of page.rows) assert.ok(row.length <= (page.perRow || PER_ROW) && row.length > 0);
      const keys = page.rows.flat().map((kd) => kd.k);
      assert.equal(new Set(keys).size, keys.length, `${ws.id}/${page.id} repeats a key`);
      for (const k of keys) assert.ok(k && !/\s/.test(k), `${ws.id}/${page.id} has a blank key`);
    }
  }
});

test('long pages are split into numbered parts with unique ids', () => {
  const pages = systemPages(writingSystem('emoji'));
  assert.ok(pages.some((p) => /Faces \d/.test(p.label)));
  assert.equal(new Set(pages.map((p) => p.id)).size, pages.length);
});

test('cased scripts shift to capitals; ß shifts to ẞ; marks sit on a dotted circle', () => {
  assert.equal(keyDef('ж', { cased: true }).s, 'Ж');
  assert.equal(keyDef('ß', { cased: true }).s, 'ẞ');
  assert.equal(keyDef('𐓘', { cased: true }).s, '𐒰');
  assert.equal(keyDef('ㅂ', { shift: { 'ㅂ': 'ㅃ' } }).s, 'ㅃ');
  assert.equal(keyDef('ა').s, undefined);
  assert.equal(keyLabel('َ'), '◌َ');
  assert.equal(keyLabel('‌'), 'ZWNJ');
});

test('Hangul jamo compose into syllables as they are typed', () => {
  const type = (jamo) => {
    let text = '';
    for (const j of jamo) {
      const prev = text.slice(-1);
      const joined = composeHangul(prev, j);
      text = joined == null ? text + j : text.slice(0, -1) + joined;
    }
    return text;
  };
  assert.equal(type('ㅎㅏㄴㄱㅡㄹ'), '한글');
  assert.equal(type('ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ'), '안녕하세요');
  assert.equal(type('ㄱㅗㅏ'), '과');
  assert.equal(type('ㄷㅏㄹㄱ'), '닭');
  assert.equal(type('ㄷㅏㄹㄱㅇㅣ'), '닭이');
  assert.equal(type('ㄷㅏㄹㄱㅣ'), '달기');
  assert.equal(type('ㅏ'), 'ㅏ');
  assert.equal(composeHangul('a', 'ㅏ'), null);
});
