// speech.js — the voice behind `.speak()` on a Text Cycles pattern.
//
//   $: word("<hello ʃiːp>").speak()
//   $: word('/ˈχaʁt͡s/').speak()                   // a transcription, in single quotes
//   $: word("bonjour").speak('fr-FR', 1)        // language, then voice index or name
//   $: note("c4 e4 g4").word("ʃa").speak()       // sung, one pitch per hap
//   $: n(run(4)).scale('C:minor').word("la").speak().quantize(0.5)
//
// text-cycles.js calls speakText() from paint(), i.e. with the exact
// characters that just landed in the chat — after the turn gate and after the
// room's `#` effects have crushed or noised them — so what is heard is what
// is read. Every browser paints every peer's words locally, so every browser
// speaks them locally too — that is how everyone in the meeting hears them —
// and nothing is streamed, exactly like the text itself.
//
// Two voices: a word written in the IPA (containsIpa) is played from the
// synthesized phonetic sounds (ipa-voice.js) — the sounds its symbols stand
// for, not an English reading of them. Anything else goes to the browser's
// own text-to-speech voice, which is what `lang` / `voice` choose.
//
// Other writing systems (the on-screen keyboard's 🌐 menu): a word in Arabic,
// Devanagari, Hangul, Cherokee… is synthesized too — transliterated into the
// IPA (script-ipa-core.js's toIpa) and played from the same phonetic sounds —
// so every browser in the meeting hears the same voice, whatever voices it
// has installed. Naming a browser voice (`.speak('ar-SA', 0)`) hands the word
// to that voice instead; a language alone only guides the transliteration
// (`.speak('ja')` reads a Chinese character as Japanese).
//
// Uploaded emoji (custom-emoji.js): a :shortcode: is read as its name by the
// browser's voice and skipped by the synthesized one.

import { containsIpa } from './ipa-core.js';
import { playIpa, stopIpa } from './ipa-voice.js';
import { detectScript, toIpa, needsTransliteration } from './script-ipa-core.js';
import { speakableShortcodes, stripShortcodes } from './custom-emoji-core.js';

function synth() {
  try {
    return typeof window !== 'undefined' ? window.speechSynthesis || null : null;
  } catch {
    return null;
  }
}

// `lang` / `voice` arrive from user code, where a double-quoted argument has
// already been turned into a mini-notation pattern by the transpiler. Speech
// options are not patterned, so take the pattern's first value.
export function plainArg(arg) {
  if (arg && typeof arg.queryArc === 'function') {
    try { return arg.queryArc(0, 1)[0]?.value; } catch { return undefined; }
  }
  return arg;
}

function pickVoice(s, lang, voice) {
  if (voice == null || voice === '') return null;
  const all = s.getVoices();
  const pool = lang ? all.filter((v) => v.lang?.toLowerCase().startsWith(String(lang).toLowerCase())) : all;
  if (typeof voice === 'number' && pool.length) return pool[((voice % pool.length) + pool.length) % pool.length];
  const name = String(voice).toLowerCase();
  return all.find((v) => v.name.toLowerCase() === name)
    || all.find((v) => v.name.toLowerCase().includes(name))
    || null;
}

function playAsIpa(text, { lang, key, pitch, quantize }) {
  const said = stripShortcodes(text);
  if (!said) return false;
  const ipa = !containsIpa(said) && needsTransliteration(said) ? toIpa(said, { lang }) : said;
  playIpa(ipa, { key, pitch, quantize }).catch((e) => console.warn('[speech] IPA playback failed', e));
  return true;
}

// Speak `text`. Words are queued so a phrase is heard whole, but never more
// than one behind: a fast pattern would otherwise drift further and further
// from the chat it is meant to be reading, so a backlog is dropped in favour
// of the newest word.
//
// A word goes to the IPA voice when it is written in IPA, when `lang` is
// 'ipa', or when it carries a pitch or quantize — the browser's TTS can be
// neither tuned to a note nor timed to a beat, so a sung or quantized word is
// read as IPA whatever it is written in. A word in a script other than Latin
// is synthesized the same way unless a browser `voice` is named.
export function speakText(text, { lang, voice, key, pitch = null, quantize = null } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  const opts = { lang, key, pitch, quantize };
  const forced = String(lang ?? '').toLowerCase() === 'ipa' || pitch != null || quantize != null;
  if (forced || containsIpa(raw)) return playAsIpa(raw, opts);
  const script = detectScript(raw);
  if (script && (voice == null || voice === '')) return playAsIpa(raw, opts);
  const said = speakableShortcodes(raw);
  const s = synth();
  if (!said || !s || typeof SpeechSynthesisUtterance === 'undefined') return false;
  if (s.pending) s.cancel();
  const u = new SpeechSynthesisUtterance(said);
  const readAs = lang || script?.lang;
  if (readAs) u.lang = String(readAs);
  const v = pickVoice(s, readAs, voice);
  if (v) u.voice = v;
  s.speak(u);
  return true;
}

export function stopSpeech() {
  synth()?.cancel();
  stopIpa();
}
