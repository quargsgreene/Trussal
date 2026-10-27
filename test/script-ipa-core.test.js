import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IPA_SYMBOLS, parseIpa } from '../src/ipa-core.js';
import {
  detectScript,
  toIpa,
  needsTransliteration,
  pinyinToIpa,
  CHEROKEE_ROMAN,
  HANZI_PINYIN,
  KANJI_KANA,
} from '../src/script-ipa-core.js';
import { WRITING_SYSTEMS, systemPages } from '../src/writing-systems-core.js';

const sounding = (ipa) => parseIpa(ipa).filter((s) => s.sym).length;

// Everything toIpa emits must be a symbol ipa-core.js parses (or a pause):
// anything else is silently skipped by the IPA voice, i.e. a letter that
// falls silent because of a typo in a table.
const PARSEABLE = new Set([...IPA_SYMBOLS.keys(), ' ']);
function assertParseable(ipa, what) {
  // NFD, then glue ç back together, exactly as parseIpa's normalise() does.
  for (const ch of ipa.normalize('NFD').replace(/ç/g, 'ç')) {
    assert.ok(PARSEABLE.has(ch), `${what} → "${ipa}" contains ${ch} (U+${ch.codePointAt(0).toString(16)})`);
  }
}

// Keys that are not letters, or letters that are silent on their own.
const SILENT_ALONE = new Set([
  'א', 'އ', 'ㅇ', 'ʔ', 'ー', 'っ', 'ッ', 'ゃ', 'ゅ', 'ょ', 'ャ', 'ュ', 'ョ',
  'ْ', 'ް', 'ְ', 'ⵯ', 'ʼ', 'ğ', 'Ğ',
  // Glottal stops — a break, not a sound — and the hard and soft signs.
  'ء', 'أ', 'ؤ', 'ئ', 'ע', 'ޢ', 'อ', 'ъ', 'Ъ', 'ь', 'Ь',
  // Tatweel only stretches the joining line between Arabic letters.
  'ـ',
  // Thai abbreviation and repetition signs.
  'ฯ', 'ๆ',
]);

test('every letter on every writing-system page is spoken, with symbols the IPA voice parses', () => {
  for (const ws of WRITING_SYSTEMS) {
    if (ws.id === 'emoji' || ws.id === 'latin') continue;
    for (const page of systemPages(ws)) {
      for (const kd of page.rows.flat()) {
        const key = kd.k;
        const ipa = toIpa(key);
        assertParseable(ipa, `${ws.id}/${page.id} ${key}`);
        // A letter (not a mark, digit or punctuation) must make a sound.
        if (!/^\p{L}/u.test(key) || SILENT_ALONE.has(key)) continue;
        assert.ok(sounding(ipa) > 0, `${ws.id}/${page.id} ${key} (U+${key.codePointAt(0).toString(16)}) is silent: "${ipa}"`);
      }
    }
  }
});

test('Shift forms of cased scripts are spoken too', () => {
  for (const ws of WRITING_SYSTEMS) {
    if (!ws.cased) continue;
    for (const page of systemPages(ws)) {
      for (const kd of page.rows.flat()) {
        if (!kd.s || !/^\p{L}/u.test(kd.s) || SILENT_ALONE.has(kd.s)) continue;
        const ipa = toIpa(kd.s);
        assertParseable(ipa, `${ws.id} ⇧${kd.s}`);
        assert.ok(sounding(ipa) > 0, `${ws.id} ⇧${kd.s} is silent`);
      }
    }
  }
});

test('words read the way their script spells them', () => {
  const cases = {
    'سلام': 'salaːm',
    'كتب': 'katab',
    'שלום': 'ʃalom',
    'नमस्ते': 'nəməsteː',
    'कमल': 'kəməl',
    'தமிழ்': 'tamiɻ',
    'Привет': 'privet',
    'Ελληνικά': 'ellinika',
    '안녕하세요': 'annjʌŋhasejo',
    'ᐃᓄᒃᑎᑐᑦ': 'inuktitut',
    'カタカナ': 'katakana',
    'ありがとう': 'aɾiɡatoɯ',
    'ᏣᎳᎩ': 't͡salaki',
    'ދިވެހި': 'divehi',
  };
  for (const [word, ipa] of Object.entries(cases)) assert.equal(toIpa(word), ipa, word);
});

test('the nukta reads the same precomposed or decomposed', () => {
  const precomposed = 'क़';
  const decomposed = 'क़';
  assert.equal(toIpa(precomposed), toIpa(decomposed));
  // A lone consonant keeps its inherent vowel: there is no other to drop it for.
  assert.equal(toIpa(decomposed), 'qə');
  assert.equal(toIpa(`${decomposed}ा`), 'qaː');
});

test('Thai: a final consonant is read as a final, a leading vowel after its consonant', () => {
  assert.equal(toIpa('สวัสดี'), 'sawatdiː');
  assert.equal(toIpa('เป็น'), 'peːn');
});

test('Chinese characters get pinyin readings and tones; with kana around them, Japanese ones', () => {
  assert.equal(toIpa('中国'), 'ʈ͡ʂʊ˥ŋ.kwo˧˥');
  assert.equal(pinyinToIpa('xue2'), 'ɕɥe˧˥');
  assert.equal(pinyinToIpa('yu3'), 'y˨˩˦');
  assert.equal(pinyinToIpa('shi4'), 'ʂɨ˥˩');
  assert.equal(pinyinToIpa('wo3'), 'wo˨˩˦');
  assert.equal(toIpa('日本です'), 'ɲit͡ɕi.hoɴdesɯ');
  assert.equal(toIpa('日本', { lang: 'ja-JP' }), 'ɲit͡ɕi.hoɴ');
  for (const [ch, py] of HANZI_PINYIN) assert.ok(pinyinToIpa(py), `${ch} ${py}`);
  for (const [ch, kana] of KANJI_KANA) assert.ok(sounding(toIpa(kana)) > 0, `${ch} ${kana}`);
});

test('the Cherokee syllabary table covers U+13A0–U+13F5 exactly', () => {
  assert.equal(CHEROKEE_ROMAN.length, 0x13F5 - 0x13A0 + 1);
});

test('Latin diacritic letters are respelled; plain ASCII passes through', () => {
  assert.equal(toIpa('Grüße'), 'ɡryse');
  assert.equal(toIpa('la'), 'la');
  assert.ok(needsTransliteration('Straße'));
  assert.ok(!needsTransliteration('hello'));
  assert.ok(needsTransliteration('مرحبا'));
});

test('detectScript names the script and the browser-voice language', () => {
  assert.equal(detectScript('hello'), null);
  assert.equal(detectScript('Grüße 😀'), null);
  assert.deepEqual(detectScript('مرحبا'), { script: 'arabic', lang: 'ar' });
  assert.deepEqual(detectScript('فارسی'), { script: 'arabic', lang: 'fa' });
  assert.deepEqual(detectScript('Їжак'), { script: 'cyrillic', lang: 'uk' });
  assert.deepEqual(detectScript('বাংলা'), { script: 'brahmic', lang: 'bn' });
  assert.deepEqual(detectScript('日本です'), { script: 'kana', lang: 'ja' });
  assert.deepEqual(detectScript('你好'), { script: 'han', lang: 'zh' });
  assert.equal(detectScript('ᠮᠣᠩᠭᠣᠯ').lang, null);
});
