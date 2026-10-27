// writing-systems-core.js
// The on-screen keyboard's writing systems, as data: what the 🌐 menu lists
// and what each one's keys type. Pure — no DOM — so the layouts and the one
// piece of typing logic a script needs (Hangul syllable composition) are unit
// tested directly (test/writing-systems-core.test.js); on-screen-keyboard.js
// only turns a page into key rows.
//
// The Latin script is the keyboard's QWERTY layout itself (ROWS in
// on-screen-keyboard.js) and IPA keeps its own key and pages (ipa-core.js) —
// neither is described here beyond its menu entry.
//
// A system is { id, label, sample, pages, cased?, compose? }. A page is
// { id, label, keys } where `keys` is a space-separated string (one key can
// type several code points: a conjunct, a flag, an emoji with a ZWJ), or
// { id, label, rows, shift } for a fixed layout (Hangul's two-set). Pages
// longer than PAGE_ROWS × perRow keys are split into numbered pages, so keys
// stay big enough to dwell on.
//
// Every letter on a page is readable by `.speak()` — script-ipa-core.js
// transliterates it when the browser has no voice for the language, and the
// Hanzi and Kanji pages are exactly the characters it has readings for.

import { HANZI_PINYIN, KANJI_KANA } from './script-ipa-core.js';

export const PER_ROW = 13;
export const PAGE_ROWS = 4;

// Every assigned code point between `from` and `to` (inclusive), as keys.
function range(from, to) {
  const out = [];
  for (let cp = from; cp <= to; cp++) {
    const ch = String.fromCodePoint(cp);
    if (!/\p{Cn}/u.test(ch)) out.push(ch);
  }
  return out.join(' ');
}

// One Indic block's keys, in the order of its chart: independent vowels,
// consonants, then vowel signs, virama and the other marks, then danda.
function indic(base) {
  return [
    range(base + 0x05, base + 0x14),
    range(base + 0x15, base + 0x39),
    range(base + 0x3E, base + 0x4D),
    range(base + 0x01, base + 0x03),
    range(base + 0x3C, base + 0x3C),
    '। ॥',
  ].filter(Boolean).join(' ');
}

const EMOJI = {
  faces: `😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫
    🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓
    🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬
    😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊`,
  hearts: `💋 💌 💘 💝 💖 💗 💓 💞 💕 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💟 💯 💢 💥 💫 💦 💨
    💬 💭 💤`,
  people: `👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐
    🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦵 🦶 👂 👃 🧠 👀 👅 👄 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙋 🙇
    🤦 🤷 💃 🕺 👯 🧘`,
  nature: `🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄
    🐝 🐛 🦋 🐌 🐞 🐜 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦒 🦘 🐪
    🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍁 🍂 🍃 🍄 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌜 🌚 🌕 🌙 🌎 🪐 ⭐
    🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ 🌩️ ❄️ ☃️ 🌊 💧`,
  food: `🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄
    🧅 🥔 🍠 🥐 🥯 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟
    🍤 🍙 🍚 🍘 🍥 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃
    🍸 🍹 🧉`,
  activity: `⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🛹 ⛸️ 🎿 🏆 🥇 🎯 🎮 🎲 🧩 🎭 🎨 🎬 🎤 🎧 🎼 🎹
    🥁 🎷 🎺 🎸 🪕 🎻 🪗 📯 🔔 🎵 🎶 📻 📱 💻 ⌨️ 🖥️ 🖱️ 💾 💿 📷 🎥 📺 🔦 💡 🕯️ 📚 📖 ✏️ 🖊️
    🖌️ 🖍️ 📝 📌 📎 ✂️ 🔑 🔒 🔨 🪓 ⚙️ 🧲 🧪 🔭 🔬 💊 🎁 🎈 🎉 🎊 🪩`,
  symbols: `✅ ❌ ❓ ❗ ‼️ ⁉️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ ♠️ ♥️ ♦️ ♣️ ♾️ ☮️
    ☯️ ✡️ ☪️ 🕉️ ☸️ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⚛️ ♻️ ⚠️ 🚫 🆗 🆒 🆕 🆓 ➕ ➖ ✖️ ➗ 🔁 🔀 ▶️ ⏸️
    ⏹️ ⏺️ ⏭️ ⏮️ 🏳️ 🏴 🏁 🚩 🏳️\u200D🌈 🏳️\u200D⚧️ 🏴\u200D☠️ 🇺🇳 🇪🇺`,
};

export const WRITING_SYSTEMS = Object.freeze([
  { id: 'latin', label: 'Latin', sample: 'Aa' },
  {
    id: 'latin-ext', label: 'Latin + diacritics', sample: 'Äß', cased: true,
    pages: [
      { id: 'germanic', label: 'Germanic & Nordic', keys: 'ä ö ü ß å æ ø ð þ ë ï ÿ œ ĳ ǫ „ “ ” ‚ ‘ ’ « » ‹ ›' },
      { id: 'romance', label: 'Romance', keys: 'á à â ã ç é è ê ë í ì î ï ñ ó ò ô õ ú ù û ü ă ș ț ¿ ¡ ª º € £' },
      { id: 'slavic', label: 'Slavic & Baltic', keys: 'č ć đ š ž ř ď ť ň ě ů ł ń ś ź ż ą ę ė į ų ū ā ē ī ō ģ ķ ļ ņ ő ű ŕ ĺ ľ' },
      { id: 'other', label: 'Turkic, Welsh & more', keys: 'ğ ı ş ç ə ŋ ŵ ŷ ĉ ĝ ĥ ĵ ŝ ŭ ġ ċ ħ ȳ ǎ ǐ ǒ ǔ ǖ ǘ ǚ ǜ ơ ư ạ ả ấ ầ ẩ ẫ ậ ắ ằ ẳ ẵ ặ ẹ ẻ ẽ ế ề ể ễ ệ ỉ ị ọ ỏ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ ụ ủ ứ ừ ử ữ ự ỳ ỵ ỷ ỹ' },
      { id: 'combining', label: 'Combining', keys: '\u0301 \u0300 \u0302 \u0308 \u0303 \u0304 \u0306 \u030C \u030A \u030B \u0327 \u0328 \u0307 \u0323 \u031B \u0326' },
    ],
  },
  {
    id: 'arabic', label: 'Arabic', sample: 'ع',
    pages: [
      { id: 'letters', label: 'Letters', keys: 'ا ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ ف ق ك ل م ن ه و ي ء آ أ إ ؤ ئ ة ى لا ـ ، ؛ ؟' },
      { id: 'marks', label: 'Harakat & digits', keys: '\u064E \u064F \u0650 \u064B \u064C \u064D \u0651 \u0652 \u0670 ٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩ ٪ ٫ ٬' },
    ],
  },
  {
    id: 'hebrew', label: 'Hebrew', sample: 'א',
    pages: [
      { id: 'letters', label: 'Letters', keys: 'א ב ג ד ה ו ז ח ט י כ ך ל מ ם נ ן ס ע פ ף צ ץ ק ר ש ת ־ ׳ ״ ₪' },
      { id: 'niqqud', label: 'Niqqud', keys: '\u05B7 \u05B8 \u05B6 \u05B5 \u05B4 \u05B9 \u05BB \u05B0 \u05B2 \u05B1 \u05B3 \u05BC \u05C1 \u05C2 שׁ שׂ וּ וֹ בּ כּ פּ' },
    ],
  },
  {
    id: 'syllabics', label: 'Canadian Syllabics', sample: 'ᐃ',
    pages: [
      // Four keys per consonant: its i, u and a syllables and its final.
      { id: 'short', label: 'Syllables', perRow: 16, keys: 'ᐃ ᐅ ᐊ ᕼ ᐱ ᐳ ᐸ ᑉ ᑎ ᑐ ᑕ ᑦ ᑭ ᑯ ᑲ ᒃ ᒋ ᒍ ᒐ ᒡ ᒥ ᒧ ᒪ ᒻ ᓂ ᓄ ᓇ ᓐ ᓯ ᓱ ᓴ ᔅ ᓕ ᓗ ᓚ ᓪ ᔨ ᔪ ᔭ ᔾ ᕕ ᕗ ᕙ ᕝ ᕆ ᕈ ᕋ ᕐ ᕿ ᖁ ᖃ ᖅ ᖏ ᖑ ᖓ ᖕ ᖠ ᖢ ᖤ ᖦ' },
      { id: 'long', label: 'Long vowels', perRow: 15, keys: 'ᐄ ᐆ ᐋ ᐲ ᐴ ᐹ ᑏ ᑑ ᑖ ᑮ ᑰ ᑳ ᒌ ᒎ ᒑ ᒦ ᒨ ᒫ ᓃ ᓅ ᓈ ᓰ ᓲ ᓵ ᓖ ᓘ ᓛ ᔩ ᔫ ᔮ ᕖ ᕘ ᕚ ᕇ ᕉ ᕌ ᖀ ᖂ ᖄ ᖐ ᖒ ᖔ ᖡ ᖣ ᖥ' },
      { id: 'e', label: 'E series', keys: 'ᐁ ᐯ ᑌ ᑫ ᒉ ᒣ ᓀ ᓭ ᓓ ᔦ ᕓ ᕂ' },
    ],
  },
  {
    id: 'north-brahmic', label: 'Northern Brahmic', sample: 'क',
    pages: [
      { id: 'deva', label: 'Devanagari', keys: indic(0x0900) },
      { id: 'beng', label: 'Bengali', keys: indic(0x0980) },
      { id: 'guru', label: 'Gurmukhi', keys: `${indic(0x0A00)} \u0A70 \u0A71 ੜ` },
      { id: 'gujr', label: 'Gujarati', keys: indic(0x0A80) },
      { id: 'orya', label: 'Odia', keys: `${indic(0x0B00)} ୟ ୱ` },
    ],
  },
  {
    id: 'south-brahmic', label: 'Southern Brahmic', sample: 'அ',
    pages: [
      { id: 'taml', label: 'Tamil', keys: indic(0x0B80) },
      { id: 'telu', label: 'Telugu', keys: indic(0x0C00) },
      { id: 'knda', label: 'Kannada', keys: indic(0x0C80) },
      { id: 'mlym', label: 'Malayalam', keys: `${indic(0x0D00)} ൺ ൻ ർ ൽ ൾ` },
      { id: 'sinh', label: 'Sinhala', keys: `${range(0x0D85, 0x0D96)} ${range(0x0D9A, 0x0DC6)} ${range(0x0DCA, 0x0DDF)} \u0D82 \u0D83` },
    ],
  },
  {
    id: 'thaana', label: 'Thaana', sample: 'ދ',
    pages: [
      { id: 'letters', label: 'Letters & fili', keys: `${range(0x0780, 0x0797)} ${range(0x07A6, 0x07B0)} ، ؛ ؟` },
      { id: 'loans', label: 'Arabic loans', keys: range(0x0798, 0x07A5) },
    ],
  },
  {
    id: 'armenian', label: 'Armenian', sample: 'Ա', cased: true,
    pages: [{ id: 'letters', label: 'Letters', keys: `${range(0x0561, 0x0587)} ։ ՝ ՞ ՛ ՜ ֊` }],
  },
  {
    id: 'cyrillic', label: 'Cyrillic', sample: 'Ж', cased: true,
    pages: [
      { id: 'russian', label: 'Russian', keys: 'й ц у к е н г ш щ з х ъ ф ы в а п р о л д ж э я ч с м и т ь б ю ё №' },
      { id: 'more', label: 'Other languages', keys: 'і ї є ґ ў ђ ј љ њ ћ џ ѓ ќ ѕ ғ қ ң ү ұ һ ә ө' },
    ],
  },
  {
    id: 'georgian', label: 'Georgian', sample: 'ა',
    pages: [{ id: 'letters', label: 'Letters', keys: range(0x10D0, 0x10F0) }],
  },
  {
    id: 'greek', label: 'Greek', sample: 'Ω', cased: true,
    pages: [
      { id: 'letters', label: 'Letters', keys: 'α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ ς τ υ φ χ ψ ω ά έ ή ί ό ύ ώ ϊ ϋ ΐ ΰ ; ·' },
    ],
  },
  {
    id: 'hangul', label: 'Hangul', sample: '한', compose: 'hangul',
    pages: [
      {
        id: 'jamo', label: 'Jamo',
        rows: ['ㅂ ㅈ ㄷ ㄱ ㅅ ㅛ ㅕ ㅑ ㅐ ㅔ', 'ㅁ ㄴ ㅇ ㄹ ㅎ ㅗ ㅓ ㅏ ㅣ', 'ㅋ ㅌ ㅊ ㅍ ㅠ ㅜ ㅡ , . ?'],
        shift: { 'ㅂ': 'ㅃ', 'ㅈ': 'ㅉ', 'ㄷ': 'ㄸ', 'ㄱ': 'ㄲ', 'ㅅ': 'ㅆ', 'ㅐ': 'ㅒ', 'ㅔ': 'ㅖ' },
      },
      { id: 'compound', label: 'Compound', keys: 'ㅃ ㅉ ㄸ ㄲ ㅆ ㅒ ㅖ ㅘ ㅙ ㅚ ㅝ ㅞ ㅟ ㅢ ㄳ ㄵ ㄶ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅄ' },
    ],
  },
  {
    id: 'mongolian', label: 'Mongolian', sample: 'ᠮ',
    pages: [{ id: 'letters', label: 'Letters', keys: `${range(0x1820, 0x1842)} ᠂ ᠃ ᠀` }],
  },
  {
    id: 'tifinagh', label: 'Neo-Tifinagh', sample: 'ⵣ',
    pages: [{ id: 'letters', label: 'Letters', keys: 'ⴰ ⴱ ⴳ ⴷ ⴹ ⴻ ⴼ ⴽ ⵀ ⵃ ⵄ ⵅ ⵇ ⵉ ⵊ ⵍ ⵎ ⵏ ⵓ ⵔ ⵕ ⵖ ⵙ ⵚ ⵛ ⵜ ⵟ ⵡ ⵢ ⵣ ⵥ ⵯ ⵒ ⵠ' }],
  },
  {
    id: 'thai', label: 'Thai', sample: 'ก',
    pages: [
      { id: 'consonants', label: 'Consonants', keys: range(0x0E01, 0x0E2E) },
      { id: 'vowels', label: 'Vowels & tones', keys: `${range(0x0E2F, 0x0E3A)} ${range(0x0E40, 0x0E4E)} ${range(0x0E50, 0x0E59)} ฿` },
    ],
  },
  {
    id: 'perso-arabic', label: 'Perso-Arabic', sample: 'پ',
    pages: [
      { id: 'persian', label: 'Persian', keys: 'ا ب پ ت ث ج چ ح خ د ذ ر ز ژ س ش ص ض ط ظ ع غ ف ق ک گ ل م ن و ه ی آ ء ئ ؤ \u200C ، ؛ ؟' },
      { id: 'urdu', label: 'Urdu & more', keys: 'ٹ ڈ ڑ ں ے ۓ ھ ۃ ڤ ڭ ۆ ێ ڵ ڕ ۰ ۱ ۲ ۳ ۴ ۵ ۶ ۷ ۸ ۹ ٪' },
    ],
  },
  {
    id: 'osage', label: 'Osage', sample: '𐒰', cased: true,
    pages: [{ id: 'letters', label: 'Letters', keys: range(0x104D8, 0x104FB) }],
  },
  {
    id: 'cherokee', label: 'Cherokee', sample: 'Ꮳ',
    pages: [{ id: 'syllabary', label: 'Syllabary', keys: range(0x13A0, 0x13F5) }],
  },
  {
    id: 'hanzi', label: 'Hanzi', sample: '字',
    pages: [
      { id: 'common', label: 'Common', keys: [...HANZI_PINYIN.keys()].join(' ') },
      { id: 'punct', label: 'Punctuation', keys: '。 ， 、 ； ： ？ ！ 「 」 『 』 （ ） 《 》 … —' },
    ],
  },
  {
    id: 'kana', label: 'Kana & Kanji', sample: 'あ',
    pages: [
      { id: 'hiragana', label: 'Hiragana', keys: 'あ い う え お か き く け こ さ し す せ そ た ち つ て と な に ぬ ね の は ひ ふ へ ほ ま み む め も や ゆ よ ら り る れ ろ わ を ん ー ゃ ゅ ょ っ' },
      { id: 'dakuten', label: 'Dakuten & small', keys: 'が ぎ ぐ げ ご ざ じ ず ぜ ぞ だ ぢ づ で ど ば び ぶ べ ぼ ぱ ぴ ぷ ぺ ぽ ぁ ぃ ぅ ぇ ぉ ゎ ゔ 。 、 「 」 ・' },
      { id: 'katakana', label: 'Katakana', keys: 'ア イ ウ エ オ カ キ ク ケ コ サ シ ス セ ソ タ チ ツ テ ト ナ ニ ヌ ネ ノ ハ ヒ フ ヘ ホ マ ミ ム メ モ ヤ ユ ヨ ラ リ ル レ ロ ワ ヲ ン ー ャ ュ ョ ッ' },
      { id: 'katakana2', label: 'Katakana dakuten', keys: 'ガ ギ グ ゲ ゴ ザ ジ ズ ゼ ゾ ダ ヂ ヅ デ ド バ ビ ブ ベ ボ パ ピ プ ペ ポ ァ ィ ゥ ェ ォ ヴ' },
      { id: 'kanji', label: 'Kanji', keys: [...KANJI_KANA.keys()].join(' ') },
    ],
  },
  {
    id: 'emoji', label: 'Emoji', sample: '😀',
    pages: [
      { id: 'faces', label: 'Faces', keys: EMOJI.faces },
      { id: 'hearts', label: 'Hearts', keys: EMOJI.hearts },
      { id: 'people', label: 'People', keys: EMOJI.people },
      { id: 'nature', label: 'Nature', keys: EMOJI.nature },
      { id: 'food', label: 'Food', keys: EMOJI.food },
      { id: 'activity', label: 'Activities', keys: EMOJI.activity },
      { id: 'symbols', label: 'Symbols', keys: EMOJI.symbols },
    ],
  },
].map(Object.freeze));

export const DEFAULT_SYSTEM = 'latin';

export function writingSystem(id) {
  return WRITING_SYSTEMS.find((ws) => ws.id === id) || WRITING_SYSTEMS[0];
}

const tokens = (s) => String(s).trim().split(/\s+/).filter(Boolean);

// A combining mark has nothing to sit on alone, so its key shows it on a
// dotted circle; an invisible format character (ZWNJ) gets its name.
export function keyLabel(token) {
  if (/^\p{M}+$/u.test(token)) return `◌${token}`;
  if (token === '\u200C') return 'ZWNJ';
  return token;
}

// One key. `s` is what it types with Shift: the page's own shift table, or
// the capital of a cased script's letter (only when the capital is one
// letter too — ß's is "SS", so ß gets ẞ explicitly).
export function keyDef(token, { cased = false, shift = null } = {}) {
  const kd = { l: keyLabel(token), k: token };
  let s = shift?.[token];
  if (!s && cased) {
    if (token === 'ß') s = 'ẞ';
    else {
      const up = token.toUpperCase();
      if (up !== token && [...up].length === [...token].length) s = up;
    }
  }
  if (s) kd.s = s;
  if (token === '\u200C') kd.title = 'Zero-width non-joiner';
  return kd;
}

// A system's pages as key rows, oversized pages split into numbered parts:
//   [{ id, label, rows: [[keyDef]] }]
export function systemPages(ws) {
  const out = [];
  for (const page of ws.pages || []) {
    const opts = { cased: !!ws.cased, shift: page.shift || null };
    if (page.rows) {
      // A fixed layout is as wide as its longest row.
      const rows = page.rows.map((r) => tokens(r).map((t) => keyDef(t, opts)));
      out.push({ id: page.id, label: page.label, perRow: Math.max(...rows.map((r) => r.length)), rows });
      continue;
    }
    const perRow = page.perRow || PER_ROW;
    const keys = tokens(page.keys).map((t) => keyDef(t, opts));
    const perPage = perRow * PAGE_ROWS;
    const parts = Math.max(1, Math.ceil(keys.length / perPage));
    for (let p = 0; p < parts; p++) {
      const slice = keys.slice(p * perPage, (p + 1) * perPage);
      const rows = [];
      for (let i = 0; i < slice.length; i += perRow) rows.push(slice.slice(i, i + perRow));
      out.push({
        id: parts > 1 ? `${page.id}-${p + 1}` : page.id,
        label: parts > 1 ? `${page.label} ${p + 1}` : page.label,
        perRow,
        rows,
      });
    }
  }
  return out;
}

// Whether any key on any page of `ws` has a Shift form (and so the layout
// needs a ⇧ key).
export function hasShift(ws) {
  return systemPages(ws).some((p) => p.rows.some((r) => r.some((kd) => kd.s)));
}

// --- Hangul composition ----------------------------------------------------------
//
// The two-set layout types jamo; this assembles them into syllable blocks as
// they are typed, the way every Korean input method does: a consonant after
// an open syllable becomes its final, and moves on to start the next syllable
// if a vowel follows (각 + ㅏ → 가가).

const CHO = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const JUNG = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
const JONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];
const VOWEL_PAIRS = { 'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ', 'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ' };
const FINAL_PAIRS = {
  'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ', 'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ',
  'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ',
};
const FINAL_SPLIT = Object.fromEntries(Object.entries(FINAL_PAIRS).map(([pair, f]) => [f, [...pair]]));

const syllable = (l, v, t = 0) => String.fromCharCode(0xAC00 + (l * 21 + v) * 28 + t);

function decompose(ch) {
  const s = (ch ?? '').charCodeAt(0) - 0xAC00;
  if (!(s >= 0 && s < 11172)) return null;
  return { l: Math.floor(s / 588), v: Math.floor((s % 588) / 28), t: s % 28 };
}

// `prev` is the character just before the caret, `jamo` the key pressed.
// Returns what should replace `prev` (one or two characters), or null when the
// jamo does not combine and is simply inserted.
export function composeHangul(prev, jamo) {
  const syl = decompose(prev);
  const v = JUNG.indexOf(jamo);
  if (v >= 0) {
    if (CHO.includes(prev)) return syllable(CHO.indexOf(prev), v);
    if (VOWEL_PAIRS[prev + jamo]) return VOWEL_PAIRS[prev + jamo];
    if (!syl) return null;
    if (syl.t === 0) {
      const pair = VOWEL_PAIRS[JUNG[syl.v] + jamo];
      return pair ? syllable(syl.l, JUNG.indexOf(pair)) : null;
    }
    // The final consonant moves on to begin the new syllable.
    const fin = JONG[syl.t];
    const [keep, move] = FINAL_SPLIT[fin] || ['', fin];
    if (!CHO.includes(move)) return null;
    return syllable(syl.l, syl.v, JONG.indexOf(keep)) + syllable(CHO.indexOf(move), v);
  }
  if (!CHO.includes(jamo) || !syl) return null;
  if (syl.t === 0) {
    const t = JONG.indexOf(jamo);
    return t > 0 ? syllable(syl.l, syl.v, t) : null;
  }
  const pair = FINAL_PAIRS[JONG[syl.t] + jamo];
  return pair ? syllable(syl.l, syl.v, JONG.indexOf(pair)) : null;
}
