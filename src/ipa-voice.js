// ipa-voice.js — plays IPA text from the synthesized sound files
// (scripts/ipa-synth.mjs → /assets/ipa/), on the time line planIpa() lays out.
//
// SUNG WORDS. A word with a pitch (a note or freq on its hap) is not played
// from the files: transposing a recording moves its formants with it, turning
// [i] into something else an octave up. Each segment is re-synthesized
// instead (ipa-synth-core.js) with the glottal source at the note and the
// vocal tract where the IPA puts it, and cached, since a melody repeats.
//
// WHO HEARS IT. Text Cycles paints every performer's words in every browser
// (see text-cycles.js), so the sound is played the same way: each browser
// plays the word it just painted, through Strudel's AudioContext straight to
// that browser's own speakers (realDestination). It deliberately does NOT go
// into masterStrudelGain — that node is the performer's published track under
// an aggregator, and since every browser already voices every peer's words,
// publishing them too would double them for everyone. Bots are covered for
// the same reason their words are: viewers paint them, so viewers voice them.

import { planIpa, containsIpa, LOOP, SAMPLE_RATE } from './ipa-core.js';
import { detectScript, toIpa } from './script-ipa-core.js';
import { renderSound } from './ipa-synth-core.js';
import { getStrudelAudioContext } from './latency-instrument.js';

const BASE_URL = '/assets/ipa/';
const FADE_IN = 0.01;
const FADE_OUT = 0.015;
const MASTER = 0.8;

const raw = new Map();     // file → Promise<ArrayBuffer | null>
const decoded = new Map(); // file → Promise<AudioBuffer | null>
const voices = new Map();  // key → sources still sounding for that voice
const sung = new Map();    // segment at a pitch → AudioBuffer, oldest first
const SUNG_CACHE = 512;

function sungBuffer(ctx, p) {
  const key = `${p.sym}|${p.variant ?? ''}|${p.f0.join(',')}|${p.dur.toFixed(3)}`;
  let buf = sung.get(key);
  if (buf) { sung.delete(key); sung.set(key, buf); return buf; }
  const samples = renderSound(p.sym, p.variant, { f0: p.f0, length: p.dur });
  buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
  buf.copyToChannel(samples, 0);
  sung.set(key, buf);
  if (sung.size > SUNG_CACHE) sung.delete(sung.keys().next().value);
  return buf;
}

function fetchFile(file) {
  if (!raw.has(file)) {
    raw.set(file, fetch(BASE_URL + file)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null));
  }
  return raw.get(file);
}

// A phonation variant missing from the server (an older deploy) falls back to
// the plain sound rather than going silent.
function load(ctx, file) {
  if (!decoded.has(file)) {
    decoded.set(file, fetchFile(file).then(async (bytes) => {
      if (bytes) {
        // decodeAudioData detaches its input, and `raw` may be asked again.
        try { return await ctx.decodeAudioData(bytes.slice(0)); } catch { /* fall through */ }
      }
      const plain = file.replace(/-[a-z]+\.wav$/, '.wav');
      return plain !== file ? load(ctx, plain) : null;
    }));
  }
  return decoded.get(file);
}

// Fetch (not decode — that needs the AudioContext) every file a word will use,
// so the first time it is spoken it is not late by a round trip. Called when a
// program's words are known, before any of them is painted. A word in another
// script is preloaded as its transliteration — speech.js plays it that way
// whenever the browser has no voice for its language.
export function preloadIpa(text) {
  const ipa = containsIpa(text) ? text : detectScript(text) ? toIpa(text) : null;
  if (!ipa) return;
  for (const { file } of planIpa(ipa)) fetchFile(file);
}

function stopVoice(key, at) {
  const playing = voices.get(key);
  if (!playing) return;
  for (const { src, gain } of playing) {
    try {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(0, at, 0.005);
      src.stop(at + 0.03);
    } catch { /* already stopped */ }
  }
  voices.delete(key);
}

// Play `text` now. `key` names the voice (the performer), so a new word cuts
// that performer's previous one — words land on the beat, and finishing the
// last one would put every later word behind the chat — while two performers
// speaking at once both sound. `pitch` (Hz) sings it; `quantize` (seconds per
// sound) puts its sounds on a grid — see planIpa.
export async function playIpa(text, { key = 'default', pitch = null, quantize = null } = {}) {
  const plan = planIpa(text, { pitch, quantize });
  if (!plan.length) return false;
  const { audioCtx: ctx, realDestination } = await getStrudelAudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const buffers = await Promise.all(plan.map((p) => (p.f0 ? sungBuffer(ctx, p) : load(ctx, p.file))));

  const now = ctx.currentTime;
  stopVoice(key, now);
  const t0 = now + 0.02;
  const playing = [];
  plan.forEach((p, i) => {
    const buffer = buffers[i];
    if (!buffer) return;
    const start = t0 + p.at;
    const end = start + p.dur;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (p.f0) {
      // Sung: the pitch and any contour are already in the samples, rendered
      // to this segment's exact length — nothing to loop or bend.
    } else {
      if (p.loop) {
        src.loop = true;
        src.loopStart = LOOP.start;
        src.loopEnd = LOOP.end;
      }
      // Level tone, or a contour spread evenly across the segment.
      src.playbackRate.setValueAtTime(p.rates[0], start);
      for (let k = 1; k < p.rates.length; k++) {
        src.playbackRate.linearRampToValueAtTime(p.rates[k], start + (p.dur * k) / (p.rates.length - 1));
      }
    }

    const gain = ctx.createGain();
    const g = p.gain * MASTER;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(g, start + FADE_IN);
    if (p.loop) {
      // Sustained: hold, then fade where the segment's length says it ends.
      gain.gain.setValueAtTime(g, Math.max(start + FADE_IN, end - FADE_OUT));
      gain.gain.linearRampToValueAtTime(0, end);
    }

    src.connect(gain).connect(realDestination);
    src.start(start);
    if (p.loop) src.stop(end + 0.005);
    const entry = { src, gain };
    playing.push(entry);
    src.onended = () => {
      try { gain.disconnect(); } catch { /* gone */ }
      const list = voices.get(key);
      if (list) {
        const at = list.indexOf(entry);
        if (at !== -1) list.splice(at, 1);
        if (!list.length) voices.delete(key);
      }
    };
  });
  voices.set(key, playing);
  return playing.length > 0;
}

// Everything, immediately (a time in the past means "now" to Web Audio).
export function stopIpa() {
  for (const key of [...voices.keys()]) stopVoice(key, 0);
}
