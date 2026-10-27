// script-ipa-core.js
// Text in a writing system other than the Latin alphabet, made speakable:
// which script a word is written in (detectScript — and so which language
// the browser's own voice should read it in), and a transliteration of it
// into the IPA (toIpa) for when the browser has no such voice, or the word is
// sung or quantized and so has to go through the IPA voice anyway (see
// speech.js). No DOM, no Web Audio — unit tested in
// test/script-ipa-core.test.js. Readers:
//   - speech.js                — routes a `.speak()` word to a voice
//   - ipa-voice.js             — preloads a word's sounds before it is painted
//   - writing-systems-core.js  — the Hanzi and Kanji keyboard pages are the
//                                characters this module knows how to read
//
// Every transliteration is broad and rule-based: one reading per letter, an
// inherent vowel where the script has one, and a default vowel between two
// consonants an abjad leaves unwritten. It is "how this would sound", not a
// dictionary pronunciation — a Chinese character is only readable if it is on
// the keyboard (HANZI_PINYIN), and so is a Kanji (KANJI_KANA).
//
// Everything this module outputs is a symbol ipa-core.js parses (test-checked),
// so no letter falls silent because its transliteration is spelled with a
// character the IPA voice skips.

import { IPA_SYMBOLS } from './ipa-core.js';

// "x=ipa y=ipa …" → Map. An empty ipa ("ъ=") is a letter that makes no sound.
const pairs = (s) => new Map(s.trim().split(/\s+/).map((p) => {
  const i = p.indexOf('=', 1);
  return [p.slice(0, i), p.slice(i + 1)];
}));

// --- Which script --------------------------------------------------------------

const SCRIPT_RANGES = [
  [0x0370, 0x03FF, 'greek'], [0x1F00, 0x1FFF, 'greek'],
  [0x0400, 0x052F, 'cyrillic'],
  [0x0530, 0x058F, 'armenian'],
  [0x0590, 0x05FF, 'hebrew'], [0xFB1D, 0xFB4F, 'hebrew'],
  [0x0600, 0x06FF, 'arabic'], [0x0750, 0x077F, 'arabic'], [0xFB50, 0xFDFF, 'arabic'], [0xFE70, 0xFEFF, 'arabic'],
  [0x0780, 0x07BF, 'thaana'],
  [0x0900, 0x0D7F, 'brahmic'],
  [0x0D80, 0x0DFF, 'sinhala'],
  [0x0E00, 0x0E7F, 'thai'],
  [0x10A0, 0x10FF, 'georgian'], [0x1C90, 0x1CBF, 'georgian'],
  [0x1100, 0x11FF, 'hangul'], [0x3130, 0x318F, 'hangul'], [0xAC00, 0xD7AF, 'hangul'],
  [0x13A0, 0x13FF, 'cherokee'], [0xAB70, 0xABBF, 'cherokee'],
  [0x1400, 0x167F, 'syllabics'],
  [0x1800, 0x18AF, 'mongolian'],
  [0x2D30, 0x2D7F, 'tifinagh'],
  [0x3040, 0x30FF, 'kana'],
  [0x3400, 0x4DBF, 'han'], [0x4E00, 0x9FFF, 'han'], [0xF900, 0xFAFF, 'han'],
  [0x104B0, 0x104FF, 'osage'],
];

export function scriptOf(ch) {
  const cp = ch.codePointAt(0);
  for (const [a, b, id] of SCRIPT_RANGES) if (cp >= a && cp <= b) return id;
  return null;
}

// The Indic blocks share one layout (ISCII's), 128 code points each; the
// block decides the language.
const BRAHMIC_LANG = {
  0x0900: 'hi', 0x0980: 'bn', 0x0A00: 'pa', 0x0A80: 'gu', 0x0B00: 'or',
  0x0B80: 'ta', 0x0C00: 'te', 0x0C80: 'kn', 0x0D00: 'ml',
};

// The browser voice's language for a script. Mongolian has none on purpose: a
// 'mn' voice reads Cyrillic Mongolian and would mangle the traditional script.
const SCRIPT_LANG = {
  greek: 'el', cyrillic: 'ru', armenian: 'hy', hebrew: 'he', arabic: 'ar',
  thaana: 'dv', sinhala: 'si', thai: 'th', georgian: 'ka', hangul: 'ko',
  cherokee: 'chr', syllabics: 'iu', mongolian: null, tifinagh: 'zgh',
  kana: 'ja', han: 'zh', osage: 'osa',
};

const PERSIAN_ONLY = /[پچژگکی]/;
const URDU_ONLY = /[ٹڈڑںےھۃ]/;
const UKRAINIAN_ONLY = /[іїєґ]/i;
const SERBIAN_ONLY = /[ђјљњћџ]/i;
const KANA_RE = /[぀-ヿ]/;

// The first non-Latin script in `text` and the language a browser voice would
// need to read it, or null for text in the Latin alphabet (with or without
// diacritics), digits, punctuation and emoji.
export function detectScript(text) {
  const s = String(text ?? '');
  for (const ch of s) {
    const script = scriptOf(ch);
    if (!script) continue;
    let lang = SCRIPT_LANG[script];
    if (script === 'brahmic') lang = BRAHMIC_LANG[ch.codePointAt(0) & ~0x7F];
    else if (script === 'arabic') lang = URDU_ONLY.test(s) ? 'ur' : PERSIAN_ONLY.test(s) ? 'fa' : 'ar';
    else if (script === 'cyrillic') lang = UKRAINIAN_ONLY.test(s) ? 'uk' : SERBIAN_ONLY.test(s) ? 'sr' : 'ru';
    else if (script === 'han' && KANA_RE.test(s)) { lang = 'ja'; return { script: 'kana', lang }; }
    return { script, lang };
  }
  return null;
}

// --- Latin with diacritics -------------------------------------------------------
//
// Only letters whose IPA reading would otherwise be wrong or silent: ä is not
// [a] with a centralization mark, ß is not a symbol at all. An accented vowel
// (é, à, ǎ…) is left alone — the IPA voice already reads its accent as a tone,
// which is the behaviour sung Latin words have always had.
const LATIN_EXT = pairs(`
  ä=ɛ ö=ø ü=y ß=s ẞ=s å=oː ñ=ɲ ç=s č=t͡ʃ ć=t͡ɕ š=ʃ ś=ɕ ž=ʒ ź=ʑ ż=ʒ ř=r̝
  ł=w đ=d͡ʑ ď=ɟ ť=c ň=ɲ ě=jɛ ů=uː ą=ɔ̃ ę=ɛ̃ ė=eː į=i ų=u ū=uː ā=aː ē=eː ī=iː
  ō=oː ȳ=iː ģ=ɟ ķ=c ļ=ʎ ņ=ɲ ő=øː ű=yː ŕ=r ĺ=lː ľ=ʎ ğ=ː ı=ɯ ş=ʃ ș=ʃ ț=t͡s
  ă=ə â=ɨ î=ɨ ŵ=w ŷ=ɨ ĉ=t͡ʃ ĝ=d͡ʒ ĥ=x ĵ=ʒ ŝ=ʃ ŭ=w ġ=d͡ʒ ċ=t͡ʃ ơ=ɤ ư=ɯ ÿ=i
  ë=ə ï=i þ=θ ĳ=ɛi̯ ŀ=l ǫ=ɔ̃ ê=ɛ ô=o û=u ª=a º=o
`);

// Letters and the ASCII marks the IPA voice reads (' stress, : length, .
// syllable break, | group) pass through; a comma or question mark is a pause;
// other punctuation and symbols (quotes, €, emoji) say nothing. An accent the
// IPA has no use for (Vietnamese dot below, hook above) is dropped.
function latin(run) {
  let out = '';
  for (const ch of run) {
    const lower = ch.toLowerCase();
    const mapped = LATIN_EXT.get(ch) ?? LATIN_EXT.get(lower);
    if (mapped != null) out += mapped;
    else if (/[\p{L}\p{M}'.:|‖]/u.test(ch)) {
      for (const part of (lower === 'g' ? 'ɡ' : lower).normalize('NFD')) {
        if (!/\p{M}/u.test(part) || IPA_SYMBOLS.has(part)) out += part;
      }
    } else if (/[,;?!]/.test(ch)) out += '|';
  }
  return out.normalize('NFC');
}

// --- Alphabets: a letter (or a two-letter digraph) is a sound ----------------------

function greedy(run, map) {
  let out = '';
  const chars = [...run];
  for (let i = 0; i < chars.length; i++) {
    const two = chars[i] + (chars[i + 1] ?? '');
    if (chars[i + 1] && map.has(two)) { out += map.get(two); i++; continue; }
    out += map.get(chars[i]) ?? '';
  }
  return out;
}

const CYRILLIC = pairs(`
  а=a б=b в=v г=ɡ д=d е=e ё=jo ж=ʐ з=z и=i й=j к=k л=l м=m н=n о=o п=p р=r
  с=s т=t у=u ф=f х=x ц=t͡s ч=t͡ɕ ш=ʂ щ=ɕː ъ= ы=ɨ ь=ʲ э=e ю=ju я=ja і=i ї=ji
  є=je ґ=ɡ ў=w ђ=d͡ʑ ј=j љ=ʎ њ=ɲ ћ=t͡ɕ џ=d͡ʒ ѓ=ɟ ќ=c ѕ=d͡z ғ=ɣ қ=q ң=ŋ ү=y
  ұ=ʊ һ=h ә=æ ө=ø
`);

const GREEK = pairs(`
  ου=u αι=e ει=i οι=i υι=i αυ=av ευ=ev μπ=b ντ=d γκ=ɡ γγ=ŋɡ τσ=t͡s τζ=d͡z
  α=a β=v γ=ɣ δ=ð ε=e ζ=z η=i θ=θ ι=i κ=k λ=l μ=m ν=n ξ=ks ο=o π=p ρ=r σ=s
  ς=s τ=t υ=i φ=f χ=x ψ=ps ω=o
`);

const ARMENIAN = pairs(`
  ու=u ա=ɑ բ=b գ=ɡ դ=d ե=ɛ զ=z է=ɛ ը=ə թ=tʰ ժ=ʒ ի=i լ=l խ=χ ծ=t͡s կ=k
  հ=h ձ=d͡z ղ=ʁ ճ=t͡ʃ մ=m յ=j ն=n շ=ʃ ո=ɔ չ=t͡ʃʰ պ=p ջ=d͡ʒ ռ=r ս=s վ=v
  տ=t ր=ɾ ց=t͡sʰ ւ=v փ=pʰ ք=kʰ օ=o ֆ=f և=jɛv
`);

const GEORGIAN = pairs(`
  ა=ɑ ბ=b გ=ɡ დ=d ე=ɛ ვ=v ზ=z თ=tʰ ი=i კ=kʼ ლ=l მ=m ნ=n ო=ɔ პ=pʼ ჟ=ʒ
  რ=r ს=s ტ=tʼ უ=u ფ=pʰ ქ=kʰ ღ=ɣ ყ=qʼ შ=ʃ ჩ=t͡ʃʰ ც=t͡sʰ ძ=d͡z წ=t͡sʼ ჭ=t͡ʃʼ
  ხ=χ ჯ=d͡ʒ ჰ=h
`);

// Indexed from the block's first letter, in code point order.
const byIndex = (start, list) => new Map(list.trim().split(/\s+/)
  .map((ipa, i) => [String.fromCodePoint(start + i), ipa === '-' ? '' : ipa]));

// U+1820 A … U+1842 CHI.
const MONGOLIAN = byIndex(0x1820, `
  a ə i ɔ ʊ ø y e n ŋ b p x ɡ m l s ʃ t d t͡ʃ d͡ʒ j r w f k kʰ t͡s z h ʐ ɬ ʐ t͡ʂ
`);

// U+104D8 small A … U+104FB small ZHA (capitals are lowercased first).
const OSAGE = byIndex(0x104D8, `
  a ai̯ ã ʌ ɓ t͡ʃ t͡ʃʰ e ẽ h hj i k kʰ kj l m n o õ p pʰ s ʃ t tʰ t͡s t͡sʰ t͡ʃ
  ð u w x ɣ z ʒ
`);

// U+13A0 A … U+13F5 MV, romanized as the Unicode names spell them.
export const CHEROKEE_ROMAN = Object.freeze(`
  a e i o u v ga ka ge gi go gu gv ha he hi ho hu hv la le li lo lu lv ma me mi
  mo mu na hna nah ne ni no nu nv qua que qui quo quu quv sa s se si so su sv da
  ta de te di ti do du dv dla tla tle tli tlo tlu tlv tsa tse tsi tso tsu tsv wa
  we wi wo wu wv ya ye yi yo yu yv mv
`.trim().split(/\s+/));

const CHEROKEE_C = {
  g: 'k', k: 'kʰ', h: 'h', l: 'l', m: 'm', n: 'n', hn: 'n̥', qu: 'kʷ', s: 's',
  d: 't', t: 'tʰ', dl: 't͡ɬ', tl: 't͡ɬʰ', ts: 't͡s', w: 'w', y: 'j',
};
const CHEROKEE_V = { a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', v: 'ə̃' };

const CHEROKEE = new Map(CHEROKEE_ROMAN.map((rom, i) => {
  const ch = String.fromCodePoint(0x13A0 + i);
  if (rom === 'nah') return [ch, 'nah'];
  const m = /^(qu|hn|dl|tl|ts|[gkhlmnsdtwy]?)([aeiouv]?)$/.exec(rom);
  return [ch, (CHEROKEE_C[m[1]] ?? '') + (CHEROKEE_V[m[2]] ?? '')];
}));

// Inuktitut values (the c-series is Inuktitut g); generated from the Unicode
// names, CANADIAN SYLLABICS PI, PII, P and so on.
const SYLLABICS = pairs(`
  ᐃ=i ᐅ=u ᐊ=a ᐄ=iː ᐆ=uː ᐋ=aː ᐁ=e ᐱ=pi ᐳ=pu ᐸ=pa ᐲ=piː ᐴ=puː ᐹ=paː ᐯ=pe ᑉ=p
  ᑎ=ti ᑐ=tu ᑕ=ta ᑏ=tiː ᑑ=tuː ᑖ=taː ᑌ=te ᑦ=t ᑭ=ki ᑯ=ku ᑲ=ka ᑮ=kiː ᑰ=kuː ᑳ=kaː
  ᑫ=ke ᒃ=k ᒋ=ɡi ᒍ=ɡu ᒐ=ɡa ᒌ=ɡiː ᒎ=ɡuː ᒑ=ɡaː ᒉ=ɡe ᒡ=ɡ ᒥ=mi ᒧ=mu ᒪ=ma ᒦ=miː
  ᒨ=muː ᒫ=maː ᒣ=me ᒻ=m ᓂ=ni ᓄ=nu ᓇ=na ᓃ=niː ᓅ=nuː ᓈ=naː ᓀ=ne ᓐ=n ᓯ=si ᓱ=su
  ᓴ=sa ᓰ=siː ᓲ=suː ᓵ=saː ᓭ=se ᔅ=s ᓕ=li ᓗ=lu ᓚ=la ᓖ=liː ᓘ=luː ᓛ=laː ᓓ=le ᓪ=l
  ᔨ=ji ᔪ=ju ᔭ=ja ᔩ=jiː ᔫ=juː ᔮ=jaː ᔦ=je ᔾ=j ᕕ=vi ᕗ=vu ᕙ=va ᕖ=viː ᕘ=vuː ᕚ=vaː
  ᕓ=ve ᕝ=v ᕆ=ʁi ᕈ=ʁu ᕋ=ʁa ᕇ=ʁiː ᕉ=ʁuː ᕌ=ʁaː ᕂ=ʁe ᕐ=ʁ ᕿ=qi ᖁ=qu ᖃ=qa ᖀ=qiː
  ᖂ=quː ᖄ=qaː ᖅ=q ᖏ=ŋi ᖑ=ŋu ᖓ=ŋa ᖐ=ŋiː ᖒ=ŋuː ᖔ=ŋaː ᖕ=ŋ ᖠ=ɬi ᖢ=ɬu ᖤ=ɬa ᖡ=ɬiː
  ᖣ=ɬuː ᖥ=ɬaː ᖦ=ɬ ᕼ=h
`);

// --- Abjads: consonants written, short vowels mostly not ---------------------------
//
// Each letter is C (a consonant), V (a vowel sign), M (a mater lectionis — a
// consonant at the start of a syllable, a long vowel after one), or X (a mark
// on the consonant before it). In an unvocalized word, two consonants in a row
// get the script's default vowel between them, so "كتب" is heard [katab]
// rather than an unpronounceable [ktb]; a word that carries any vowel sign is
// taken as fully vocalized and left as written.

const C = (ipa) => ({ t: 'C', ipa });
const V = (ipa) => ({ t: 'V', ipa });
const M = (cons, vowel) => ({ t: 'M', ipa: cons, vowel });
const X = (fn) => ({ t: 'X', fn });

const gem = X((out) => `${out}ː`);
const asp = X((out) => `${out}ʰ`);
const nasal = X((out) => `${out}̃`);

const consonants = (s) => [...pairs(s)].map(([k, v]) => [k, C(v)]);

const ARABIC = new Map([
  ...consonants(`
    ب=b ت=t ث=θ ج=d͡ʒ ح=ħ خ=x د=d ذ=ð ر=r ز=z س=s ش=ʃ ص=sˤ ض=dˤ ط=tˤ ظ=ðˤ
    ع=ʕ غ=ɣ ف=f ق=q ك=k ل=l م=m ن=n ه=h ء=ʔ أ=ʔ ؤ=ʔ ئ=ʔ
    پ=p چ=t͡ʃ ژ=ʒ ک=k گ=ɡ ٹ=ʈ ڈ=ɖ ڑ=ɽ ڤ=v ڭ=ŋ ڵ=ɫ ڕ=r
  `),
  ['ا', M('ʔa', 'aː')], ['آ', C('ʔaː')], ['إ', C('ʔi')], ['ى', V('aː')], ['ة', V('a')],
  ['ۃ', V('a')], ['ۀ', V('e')],
  ['و', M('w', 'uː')], ['ۆ', V('o')], ['ي', M('j', 'iː')], ['ی', M('j', 'iː')],
  ['ێ', V('eː')], ['ے', V('eː')], ['ۓ', V('eː')],
  ['\u064E', V('a')], ['\u064F', V('u')], ['\u0650', V('i')], ['\u064B', V('an')], ['\u064C', V('un')], ['\u064D', V('in')],
  ['\u0670', V('aː')], ['\u0652', V('')], ['\u0651', gem], ['ھ', asp], ['ں', nasal],
  ['،', V('|')], ['؛', V('|')], ['؟', V('|')],
]);

const HEBREW = new Map([
  ...consonants(`
    ב=b ג=ɡ ד=d ה=h ז=z ח=χ ט=t כ=k ך=χ ל=l מ=m ם=m נ=n ן=n ס=s ע=ʔ פ=p ף=f
    צ=t͡s ץ=t͡s ק=k ר=ʁ ש=ʃ ת=t
  `),
  ['א', C('')], ['ו', M('v', 'o')], ['י', M('j', 'i')],
  ['\u05B7', V('a')], ['\u05B8', V('a')], ['\u05B2', V('a')], ['\u05B6', V('e')], ['\u05B1', V('e')], ['\u05B5', V('e')],
  ['\u05B4', V('i')], ['\u05B9', V('o')], ['\u05B3', V('o')], ['\u05BB', V('u')], ['\u05B0', V('')],
  // Dagesh: hardens a fricative (in an unpointed word these letters already
  // read hard), or turns vav into the vowel [u].
  ['\u05BC', X((out) => out.replace(/v$/, 'u'))],
  ['\u05C2', X((out) => out.replace(/ʃ$/, 's'))], ['\u05C1', X((out) => out)],
  ['־', V(' ')], ['׳', X((out) => out)], ['״', X((out) => out)],
]);

// U+0780 HAA … U+07A5 WAAVU, then the fili (vowel signs) and sukun. Alifu is
// a silent carrier for a vowel.
const THAANA = new Map([
  ...[...byIndex(0x0780, `
    h ʃ n r b ɭ k - v m f d t l ɡ ɲ s ɖ z ʈ j p d͡ʒ t͡ʃ θ ħ x ð z ʃ s d t z ʔ ɣ q w
  `)].map(([k, v]) => [k, C(v)]),
  ...[...byIndex(0x07A6, 'a aː i iː u uː e eː o oː -')].map(([k, v]) => [k, V(v)]),
  ['،', V('|')], ['؛', V('|')], ['؟', V('|')],
]);

const TIFINAGH = new Map([
  ...consonants(`
    ⴱ=b ⴳ=ɡ ⴷ=d ⴹ=dˤ ⴼ=f ⴽ=k ⵀ=h ⵃ=ħ ⵄ=ʕ ⵅ=χ ⵇ=q ⵊ=ʒ ⵍ=l ⵎ=m ⵏ=n ⵔ=r
    ⵕ=rˤ ⵖ=ʁ ⵙ=s ⵚ=sˤ ⵛ=ʃ ⵜ=t ⵟ=tˤ ⵡ=w ⵢ=j ⵣ=z ⵥ=zˤ ⵒ=p ⵠ=v
  `),
  ['ⴰ', V('a')], ['ⴻ', V('ə')], ['ⵉ', V('i')], ['ⵓ', V('u')],
  ['ⵯ', X((out) => `${out}ʷ`)],
]);

function abjad(run, table, fill) {
  const chars = [...run];
  // Vocalized = carries a vowel sign (a combining mark), not just a vowel
  // letter such as ة or ى, which unvocalized text writes too.
  const vocalized = chars.some((ch) => table.get(ch)?.t === 'V' && /\p{M}/u.test(ch));
  const spoken = [];
  let last = null; // 'C' | 'V'
  chars.forEach((ch, i) => {
    const e = table.get(ch);
    if (!e) return;
    if (e.t === 'X') {
      if (spoken.length) spoken[spoken.length - 1] = e.fn(spoken[spoken.length - 1]);
      return;
    }
    if (e.t === 'V') { spoken.push(e.ipa); last = 'V'; return; }
    let consonant = e.t === 'C';
    if (e.t === 'M') {
      // A mater is a consonant before a vowel sign or at the start of a word,
      // and a long vowel after a consonant.
      const next = table.get(chars[i + 1]);
      consonant = last !== 'C' || next?.t === 'V';
    }
    if (!consonant) { spoken.push(e.vowel); last = 'V'; return; }
    if (last === 'C' && !vocalized) spoken.push(fill);
    spoken.push(e.ipa);
    // ا at the start of a word is [ʔa]: a consonant that brings its vowel.
    last = /[aeiouəɔɛɑ]ː?$/.test(e.ipa) ? 'V' : 'C';
  });
  // A word ending on a bare silent carrier (Hebrew א) would say nothing.
  if (!spoken.join('')) return chars.some((ch) => table.has(ch)) ? fill : '';
  return spoken.join('');
}

// --- Brahmic abugidas ----------------------------------------------------------------
//
// A consonant letter carries an inherent vowel, replaced by a vowel sign or
// cancelled by the virama. The nine Indic blocks share one layout, so one
// offset table reads them all; the north drops a word-final inherent vowel
// (Hindi "kamal" is [kəməl], not [kəmələ]).

const INDIC_VOWELS = {
  0x05: null, 0x06: 'aː', 0x07: 'i', 0x08: 'iː', 0x09: 'u', 0x0A: 'uː', 0x0B: 'ri', 0x0C: 'li',
  0x0D: 'æ', 0x0E: 'e', 0x0F: 'eː', 0x10: 'ai̯', 0x11: 'ɔ', 0x12: 'o', 0x13: 'oː', 0x14: 'au̯',
};
const INDIC_CONSONANTS = [
  'k', 'kʰ', 'ɡ', 'ɡʰ', 'ŋ', 't͡ʃ', 't͡ʃʰ', 'd͡ʒ', 'd͡ʒʰ', 'ɲ', 'ʈ', 'ʈʰ', 'ɖ', 'ɖʰ', 'ɳ',
  't', 'tʰ', 'd', 'dʰ', 'n', 'n', 'p', 'pʰ', 'b', 'bʰ', 'm', 'j', 'r', 'r', 'l', 'ɭ', 'ɻ',
  'ʋ', 'ʃ', 'ʂ', 's', 'h',
]; // offsets 0x15–0x39
const INDIC_SIGNS = {
  0x3E: 'aː', 0x3F: 'i', 0x40: 'iː', 0x41: 'u', 0x42: 'uː', 0x43: 'ri', 0x44: 'riː',
  0x45: 'æ', 0x46: 'e', 0x47: 'eː', 0x48: 'ai̯', 0x49: 'ɔ', 0x4A: 'o', 0x4B: 'oː', 0x4C: 'au̯',
};
// Nukta: a dot that borrows a sound the script lacks (क़ q, ज़ z, फ़ f…). The
// precomposed nukta letters are Unicode composition exclusions — NFC splits
// them into letter + nukta — so this one table reads both spellings.
const INDIC_NUKTA = {
  0x15: 'q', 0x16: 'x', 0x17: 'ɣ', 0x1C: 'z', 0x2B: 'f', 0x21: 'ɽ', 0x22: 'ɽʰ', 0x2F: 'j',
  0x32: 'ɭ', 0x38: 'ʃ',
};
// Letters outside the shared layout: Bengali khanda ta, Gurmukhi ṛ, Odia ya
// and wa, and the Malayalam chillus (vowelless finals).
const INDIC_EXTRA_CONS = new Map([
  [0x09CE, 't'], [0x0A5C, 'ɽ'], [0x0B5F, 'j'], [0x0B71, 'w'],
  [0x0D7A, 'ɳ'], [0x0D7B, 'n'], [0x0D7C, 'r'], [0x0D7D, 'l'], [0x0D7E, 'ɭ'], [0x0D7F, 'k'],
].map(([cp, ipa]) => [String.fromCodePoint(cp), ipa]));
const VOWELLESS = new Set([0x09CE, 0x0D7A, 0x0D7B, 0x0D7C, 0x0D7D, 0x0D7E, 0x0D7F].map((cp) => String.fromCodePoint(cp)));
const INHERENT = { 0x0900: 'ə', 0x0980: 'ɔ', 0x0A00: 'ə', 0x0A80: 'ə', 0x0B00: 'ɔ' }; // else 'a'
const NORTH = new Set([0x0900, 0x0980, 0x0A00, 0x0A80, 0x0B00]);

// Sinhala has its own layout; same shape, explicit tables.
const SINHALA = {
  vowels: pairs(`
    අ=a ආ=aː ඇ=æ ඈ=æː ඉ=i ඊ=iː උ=u ඌ=uː ඍ=ri ඎ=riː ඏ=li ඐ=liː එ=e ඒ=eː ඓ=ai̯ ඔ=o
    ඕ=oː ඖ=au̯
  `),
  consonants: pairs(`
    ක=k ඛ=kʰ ග=ɡ ඝ=ɡʰ ඞ=ŋ ඟ=ŋɡ ච=t͡ʃ ඡ=t͡ʃʰ ජ=d͡ʒ ඣ=d͡ʒʰ ඤ=ɲ ඥ=ɲd͡ʒ ඦ=ɲd͡ʒ ට=ʈ
    ඨ=ʈʰ ඩ=ɖ ඪ=ɖʰ ණ=ɳ ඬ=nɖ ත=t ථ=tʰ ද=d ධ=dʰ න=n ඳ=nd ප=p ඵ=pʰ බ=b භ=bʰ ම=m
    ඹ=mb ය=j ර=r ල=l ව=ʋ ශ=ʃ ෂ=ʂ ස=s හ=h ළ=ɭ ෆ=f
  `),
  signs: pairs(`
    \u0DCF=aː \u0DD0=æ \u0DD1=æː \u0DD2=i \u0DD3=iː \u0DD4=u \u0DD6=uː \u0DD8=ru \u0DD9=e \u0DDA=eː \u0DDB=ai̯ \u0DDC=o \u0DDD=oː \u0DDE=au̯ \u0DDF=lu \u0DF2=ruː
  `),
};

function brahmic(run) {
  let out = '';
  let pending = null; // the inherent vowel of the last consonant, if unspoken
  let lastCons = -1;  // where the last consonant starts in `out`, for nukta
  let lastOff = -1;
  let north = false;
  const flush = () => { if (pending) { out += pending; pending = null; } };
  const consonant = (ipa, inherent) => {
    flush();
    lastCons = out.length;
    out += ipa;
    pending = inherent;
  };
  for (const ch of run) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0D80 && cp <= 0x0DFF) {
      // Sinhala.
      if (SINHALA.consonants.has(ch)) { lastOff = -1; consonant(SINHALA.consonants.get(ch), 'a'); }
      else if (SINHALA.signs.has(ch)) { pending = null; out += SINHALA.signs.get(ch); }
      else if (ch === '\u0DCA') pending = null;
      else if (SINHALA.vowels.has(ch)) { flush(); out += SINHALA.vowels.get(ch); }
      else if (ch === '\u0D82') { flush(); out += 'ŋ'; }
      else if (ch === '\u0D83') { flush(); out += 'h'; }
      continue;
    }
    const base = cp & ~0x7F;
    const off = cp - base;
    const inherent = INHERENT[base] ?? 'a';
    north = NORTH.has(base);
    if (INDIC_EXTRA_CONS.has(ch)) {
      lastOff = -1;
      consonant(INDIC_EXTRA_CONS.get(ch), VOWELLESS.has(ch) ? null : inherent);
    } else if (off >= 0x15 && off <= 0x39) {
      lastOff = off;
      // Bengali writes [b] and [v] with one letter, and reads য as [d͡ʒ].
      let ipa = INDIC_CONSONANTS[off - 0x15];
      if (base === 0x0980 && off === 0x2F) ipa = 'd͡ʒ';
      consonant(ipa, inherent);
    } else if (off in INDIC_SIGNS) {
      pending = null;
      out += INDIC_SIGNS[off];
    } else if (off === 0x4D) {
      pending = null;
    } else if (off === 0x3C) {
      if (lastCons >= 0 && INDIC_NUKTA[lastOff]) {
        out = out.slice(0, lastCons) + INDIC_NUKTA[lastOff];
        lastOff = -1;
      }
    } else if (off in INDIC_VOWELS) {
      flush();
      out += INDIC_VOWELS[off] ?? inherent;
    } else if (off === 0x01) {
      flush();
      out += '\u0303';
    } else if (off === 0x02 || (base === 0x0A00 && off === 0x70)) {
      flush();
      out += north ? 'n' : 'm';
    } else if (off === 0x03) {
      flush();
      out += 'h';
    } else if (off === 0x64 || off === 0x65) {
      flush();
      out += '|';
    }
  }
  // Schwa deletion: the north drops a word-final inherent vowel — unless it
  // is the word's only vowel.
  if (pending && !(north && /[aeiouəɔæ]/.test(out))) out += pending;
  return out;
}

// --- Thai ------------------------------------------------------------------------------
//
// Initial and final consonants sound different (ก is [k] either way, but ด is
// [d] at the start of a syllable and [t] at the end), and five vowels are
// written before the consonant they follow in speech. Tone marks are not
// read: Thai tone depends on consonant class and syllable shape as well.
const THAI_INITIAL = pairs(`
  ก=k ข=kʰ ฃ=kʰ ค=kʰ ฅ=kʰ ฆ=kʰ ง=ŋ จ=t͡ɕ ฉ=t͡ɕʰ ช=t͡ɕʰ ซ=s ฌ=t͡ɕʰ ญ=j ฎ=d ฏ=t
  ฐ=tʰ ฑ=tʰ ฒ=tʰ ณ=n ด=d ต=t ถ=tʰ ท=tʰ ธ=tʰ น=n บ=b ป=p ผ=pʰ ฝ=f พ=pʰ ฟ=f
  ภ=pʰ ม=m ย=j ร=r ฤ=rɯ ล=l ฦ=lɯ ว=w ศ=s ษ=s ส=s ห=h ฬ=l อ=ʔ ฮ=h
`);
const THAI_FINAL = pairs(`
  ก=k ข=k ค=k ฆ=k ง=ŋ จ=t ช=t ซ=t ฎ=t ฏ=t ฐ=t ฑ=t ฒ=t ด=t ต=t ถ=t ท=t ธ=t
  ศ=t ษ=t ส=t ญ=n ณ=n น=n ร=n ล=n ฬ=n บ=p ป=p พ=p ฟ=p ภ=p ม=m ย=j ว=w อ=ɔː
`);
const THAI_LEAD = pairs('เ=eː แ=ɛː โ=oː ใ=ai̯ ไ=ai̯');
const THAI_VOWEL = pairs('ะ=a \u0E31=a า=aː ำ=am \u0E34=i \u0E35=iː \u0E36=ɯ \u0E37=ɯː \u0E38=u \u0E39=uː ๅ=aː');
const THAI_SILENT = new Set('\u0E48\u0E49\u0E4A\u0E4B\u0E47\u0E4D\u0E4E\u0E3A');

function thai(run) {
  const chars = [...run];
  const nextSignificant = (i) => {
    let j = i + 1;
    while (THAI_SILENT.has(chars[j])) j++;
    return j;
  };
  let out = '';
  let lead = null;
  let voweled = false; // has the current syllable had its vowel yet?
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (THAI_LEAD.has(ch)) { lead = THAI_LEAD.get(ch); voweled = false; continue; }
    if (THAI_VOWEL.has(ch)) { out += THAI_VOWEL.get(ch); voweled = true; continue; }
    if (ch === '\u0E4C') {
      // Thanthakhat: the letter under it is silent.
      out = out.replace(/(t͡ɕʰ|t͡ɕ|kʰ|tʰ|pʰ|rɯ|lɯ|ɔː|.)$/u, '');
      continue;
    }
    if (ch === 'ๆ' || ch === 'ฯ') { out += ' '; voweled = false; continue; }
    if (!THAI_INITIAL.has(ch)) continue;
    const j = nextSignificant(i);
    const nextIsVowel = THAI_VOWEL.has(chars[j]);
    if (lead) {
      out += THAI_INITIAL.get(ch) + lead;
      lead = null;
      voweled = true;
    } else if (nextIsVowel) {
      out += THAI_INITIAL.get(ch);
      voweled = false;
    } else if (voweled) {
      out += THAI_FINAL.get(ch) ?? '';
      voweled = false;
    } else {
      // No written vowel: [o] in a closed syllable, [a] in an open one.
      const k = nextSignificant(j);
      const closed = THAI_INITIAL.has(chars[j]) && !THAI_VOWEL.has(chars[k]) && !THAI_LEAD.has(chars[j]);
      out += THAI_INITIAL.get(ch) + (closed ? 'o' : 'a');
      voweled = true;
    }
  }
  if (lead) out += lead;
  return out;
}

// --- Hangul -------------------------------------------------------------------------------

const HANGUL_L = ['k', 'k', 'n', 't', 't', 'ɾ', 'm', 'p', 'p', 's', 's', '', 't͡ɕ', 't͡ɕ', 't͡ɕʰ', 'kʰ', 'tʰ', 'pʰ', 'h'];
const HANGUL_V = ['a', 'ɛ', 'ja', 'jɛ', 'ʌ', 'e', 'jʌ', 'je', 'o', 'wa', 'wɛ', 'we', 'jo', 'u', 'wʌ', 'we', 'wi', 'ju', 'ɯ', 'ɰi', 'i'];
const HANGUL_T = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ŋ', 't', 't', 'k', 't', 'p', 't'];
// Compatibility jamo typed on their own (U+3131 ㄱ … U+3163 ㅣ).
const HANGUL_JAMO = byIndex(0x3131, `
  k k k n n n t t l l l l l l l l m p p p s s - t͡ɕ t͡ɕ t͡ɕʰ kʰ tʰ pʰ h
  a ɛ ja jɛ ʌ e jʌ je o wa wɛ we jo u wʌ we wi ju ɯ ɰi i
`);

function hangul(run) {
  let out = '';
  for (const ch of run) {
    const s = ch.codePointAt(0) - 0xAC00;
    if (s >= 0 && s < 11172) {
      out += HANGUL_L[Math.floor(s / 588)] + HANGUL_V[Math.floor((s % 588) / 28)] + HANGUL_T[s % 28];
    } else {
      out += HANGUL_JAMO.get(ch) ?? '';
    }
  }
  return out;
}

// --- Kana and Kanji --------------------------------------------------------------------------

const HIRAGANA = pairs(`
  あ=a い=i う=ɯ え=e お=o か=ka き=ki く=kɯ け=ke こ=ko さ=sa し=ɕi す=sɯ せ=se そ=so
  た=ta ち=t͡ɕi つ=t͡sɯ て=te と=to な=na に=ɲi ぬ=nɯ ね=ne の=no は=ha ひ=çi ふ=ɸɯ へ=he
  ほ=ho ま=ma み=mi む=mɯ め=me も=mo や=ja ゆ=jɯ よ=jo ら=ɾa り=ɾi る=ɾɯ れ=ɾe ろ=ɾo
  わ=wa ゐ=i ゑ=e を=o ん=ɴ が=ɡa ぎ=ɡi ぐ=ɡɯ げ=ɡe ご=ɡo ざ=za じ=d͡ʑi ず=zɯ ぜ=ze ぞ=zo
  だ=da ぢ=d͡ʑi づ=zɯ で=de ど=do ば=ba び=bi ぶ=bɯ べ=be ぼ=bo ぱ=pa ぴ=pi ぷ=pɯ ぺ=pe
  ぽ=po ゔ=vɯ
`);
// Small kana that fuse with the mora before them (きゃ kja, しゃ ɕa, ファ ɸa).
const SMALL_Y = { 'ゃ': 'a', 'ゅ': 'ɯ', 'ょ': 'o' };
const SMALL_V = { 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'ɯ', 'ぇ': 'e', 'ぉ': 'o', 'ゎ': 'a' };

function kana(run) {
  let out = '';
  for (let ch of run) {
    const cp = ch.codePointAt(0);
    // Katakana → hiragana: the same syllables, 0x60 code points apart.
    if (cp >= 0x30A1 && cp <= 0x30F6) ch = String.fromCodePoint(cp - 0x60);
    if (ch === 'ー') { out += 'ː'; continue; }
    if (ch === 'っ') { out += 'ʔ'; continue; }
    if (ch === '・' || ch === '　') { out += ' '; continue; }
    if (SMALL_Y[ch]) {
      if (/i$/.test(out)) {
        out = out.slice(0, -1);
        out += (/[ɕʑ]$/.test(out) ? '' : 'j') + SMALL_Y[ch];
      } else out += `j${SMALL_Y[ch]}`;
      continue;
    }
    if (SMALL_V[ch]) {
      out = /[aiɯeo]$/.test(out) && out.length > 1 ? out.slice(0, -1) + SMALL_V[ch] : out + SMALL_V[ch];
      continue;
    }
    out += HIRAGANA.get(ch) ?? '';
  }
  return out;
}

// The Hanzi keyboard: common characters, each with its Mandarin reading in
// numbered pinyin (5 = neutral tone).
const pinyinPairs = (s) => s.trim().split(/\s+/).map((p) => [p.slice(0, 1), p.slice(1)]);
export const HANZI_PINYIN = new Map(pinyinPairs(`
  的de5 一yi1 是shi4 不bu4 了le5 人ren2 我wo3 在zai4 有you3 他ta1 这zhe4 中zhong1
  大da4 来lai2 上shang4 国guo2 个ge4 到dao4 说shuo1 们men5 为wei4 子zi3 和he2 你ni3
  地di4 出chu1 道dao4 也ye3 时shi2 年nian2 得de2 就jiu4 那na4 要yao4 下xia4 以yi3
  生sheng1 会hui4 自zi4 着zhe5 去qu4 之zhi1 过guo4 家jia1 学xue2 对dui4 可ke3 她ta1
  里li3 后hou4 小xiao3 么me5 心xin1 多duo1 天tian1 而er2 能neng2 好hao3 都dou1 然ran2
  没mei2 日ri4 于yu2 起qi3 还hai2 发fa1 成cheng2 事shi4 只zhi3 作zuo4 当dang1 想xiang3
  看kan4 文wen2 无wu2 开kai1 手shou3 十shi2 用yong4 主zhu3 行xing2 方fang1 又you4 如ru2
  前qian2 所suo3 本ben3 见jian4 经jing1 头tou2 面mian4 公gong1 同tong2 三san1 已yi3 老lao3
  从cong2 动dong4 两liang3 长chang2 知zhi1 民min2 样yang4 现xian4 分fen1 将jiang1 外wai4 但dan4
  身shen1 些xie1 与yu3 高gao1 意yi4 进jin4 把ba3 法fa3 此ci3 实shi2 回hui2 二er4
  理li3 美mei3 点dian3 月yue4 明ming2 声sheng1 音yin1 乐yue4 歌ge1 水shui3 火huo3 山shan1
  风feng1 雨yu3 花hua1 爱ai4 梦meng4 光guang1 四si4 五wu3 六liu4 七qi1 八ba1 九jiu3
  百bai3 千qian1 万wan4 谢xie4 再zai4 见jian4 早zao3 晚wan3 听ting1 唱chang4 跳tiao4 舞wu3
`));

// The Kanji keyboard: common characters with one everyday reading each.
export const KANJI_KANA = new Map(`
  日:にち 本:ほん 人:ひと 月:つき 火:ひ 水:みず 木:き 金:きん 土:つち 山:やま 川:かわ
  口:くち 目:め 手:て 心:こころ 大:おお 小:ちい 中:なか 上:うえ 下:した 左:ひだり 右:みぎ
  一:いち 二:に 三:さん 四:よん 五:ご 六:ろく 七:なな 八:はち 九:きゅう 十:じゅう 百:ひゃく
  千:せん 万:まん 円:えん 年:ねん 時:じ 分:ふん 今:いま 何:なに 私:わたし 音:おと 楽:がく
  歌:うた 声:こえ 語:ご 文:ぶん 字:じ 学:がく 生:せい 先:せん 会:かい 話:はなし 見:み
  行:い 来:き 食:た 好:す 雨:あめ 花:はな 空:そら 風:かぜ 夜:よる 朝:あさ 春:はる 夏:なつ
  秋:あき 冬:ふゆ 愛:あい 夢:ゆめ 光:ひかり 東:ひがし 西:にし 南:みなみ 北:きた 車:くるま
`.trim().split(/\s+/).map((p) => p.split(':')));

const PINYIN_INITIALS = {
  zh: 'ʈ͡ʂ', ch: 'ʈ͡ʂʰ', sh: 'ʂ', b: 'p', p: 'pʰ', m: 'm', f: 'f', d: 't', t: 'tʰ', n: 'n',
  l: 'l', g: 'k', k: 'kʰ', h: 'x', j: 't͡ɕ', q: 't͡ɕʰ', x: 'ɕ', r: 'ʐ', z: 't͡s', c: 't͡sʰ', s: 's',
};
// '*' marks the nucleus, where the tone letters go.
const PINYIN_FINALS = {
  a: 'a*', o: 'o*', e: 'ɤ*', ai: 'a*i̯', ei: 'e*i̯', ao: 'a*u̯', ou: 'o*u̯', an: 'a*n', en: 'ə*n',
  ang: 'a*ŋ', eng: 'ə*ŋ', ong: 'ʊ*ŋ', er: 'ɚ*', i: 'i*', ia: 'ja*', ie: 'je*', iao: 'ja*u̯',
  iou: 'jo*u̯', ian: 'jɛ*n', in: 'i*n', iang: 'ja*ŋ', ing: 'i*ŋ', iong: 'jʊ*ŋ', u: 'u*', ua: 'wa*',
  uo: 'wo*', uai: 'wa*i̯', uei: 'we*i̯', uan: 'wa*n', uen: 'wə*n', uang: 'wa*ŋ', ueng: 'wə*ŋ',
  ü: 'y*', üe: 'ɥe*', üan: 'ɥɛ*n', ün: 'y*n',
};
const PINYIN_TONES = { 1: '˥', 2: '˧˥', 3: '˨˩˦', 4: '˥˩', 5: '' };

export function pinyinToIpa(syllable) {
  const m = /^([a-zü]+?)([1-5]?)$/.exec(String(syllable).toLowerCase().replace(/v/g, 'ü'));
  if (!m) return '';
  let rest = m[1];
  const tone = PINYIN_TONES[m[2] || 5];
  let init = '';
  for (const k of ['zh', 'ch', 'sh', ...Object.keys(PINYIN_INITIALS)]) {
    if (rest.startsWith(k) && rest.length > k.length) { init = k; rest = rest.slice(k.length); break; }
  }
  // y and w are spellings of a medial, not initials of their own.
  if (!init && rest[0] === 'y') {
    rest = rest.slice(1);
    if (rest.startsWith('u')) rest = `ü${rest.slice(1)}`;
    else if (!rest.startsWith('i')) rest = `i${rest}`;
  } else if (!init && rest[0] === 'w') {
    rest = rest.slice(1);
    if (!rest.startsWith('u')) rest = `u${rest}`;
  }
  if ('jqx'.includes(init) && init && rest.startsWith('u')) rest = `ü${rest.slice(1)}`;
  rest = { iu: 'iou', ui: 'uei', un: init && 'jqx'.includes(init) ? 'ün' : 'uen' }[rest] ?? rest;
  // The "buzzed" i after a sibilant or retroflex.
  let fin = rest === 'i' && ['z', 'c', 's', 'zh', 'ch', 'sh', 'r'].includes(init) ? 'ɨ*' : PINYIN_FINALS[rest];
  if (!fin) return '';
  return (PINYIN_INITIALS[init] ?? '') + fin.replace('*', tone);
}

function han(run, japanese) {
  const out = [];
  for (const ch of run) {
    const kanji = KANJI_KANA.get(ch);
    const pinyin = HANZI_PINYIN.get(ch);
    if (japanese && kanji) out.push(kana(kanji));
    else if (pinyin) out.push(pinyinToIpa(pinyin));
    else if (kanji) out.push(kana(kanji));
  }
  // One syllable per character, each carrying its own tone.
  return out.join('.');
}

// --- Putting it together -------------------------------------------------------------------

const CONVERT = {
  greek: (r) => greedy(r.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), GREEK),
  cyrillic: (r) => greedy(r.toLowerCase(), CYRILLIC),
  armenian: (r) => greedy(r.toLowerCase(), ARMENIAN),
  georgian: (r) => greedy(r.toLowerCase(), GEORGIAN),
  mongolian: (r) => greedy(r, MONGOLIAN),
  osage: (r) => greedy(r.toLowerCase(), OSAGE),
  cherokee: (r) => greedy(r.toUpperCase(), CHEROKEE),
  syllabics: (r) => greedy(r, SYLLABICS),
  arabic: (r) => abjad(r, ARABIC, 'a'),
  hebrew: (r) => abjad(r, HEBREW, 'a'),
  thaana: (r) => abjad(r, THAANA, 'a'),
  tifinagh: (r) => abjad(r, TIFINAGH, 'ə'),
  brahmic: brahmic,
  sinhala: brahmic,
  thai: thai,
  hangul: hangul,
  kana: kana,
};

const CJK_PUNCT = /[　-〿＀-￯]/;

// Text in any mix of scripts → an IPA string for ipa-voice.js. Latin letters
// pass through (with the diacritic letters above respelled), so plain ASCII is
// returned unchanged. `lang` 'ja' reads a Chinese character as Japanese even
// without kana around it.
export function toIpa(text, { lang } = {}) {
  const s = String(text ?? '').normalize('NFC');
  const japanese = KANA_RE.test(s) || /^ja\b/i.test(String(lang ?? ''));
  let out = '';
  let run = '';
  let runScript = null;
  const flushRun = () => {
    if (run) out += runScript === 'han' ? han(run, japanese) : runScript ? CONVERT[runScript](run) : latin(run);
    run = '';
  };
  for (const ch of s) {
    let script = scriptOf(ch);
    if (script === null && (/\s/.test(ch) || CJK_PUNCT.test(ch))) {
      flushRun();
      runScript = null;
      out += ' ';
      continue;
    }
    // Combining marks belong to whatever they sit on.
    if (script === null && /\p{M}/u.test(ch)) script = runScript;
    if (script !== runScript) { flushRun(); runScript = script; }
    run += ch;
  }
  flushRun();
  return out.replace(/ {2,}/g, ' ').trim();
}

// Whether `text` needs toIpa() before the IPA voice can read it: a non-Latin
// script, or a Latin letter the voice would otherwise misread.
export function needsTransliteration(text) {
  const s = String(text ?? '').normalize('NFC');
  if (detectScript(s)) return true;
  for (const ch of s) if (LATIN_EXT.has(ch) || LATIN_EXT.has(ch.toLowerCase())) return true;
  return false;
}
