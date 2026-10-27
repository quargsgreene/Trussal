// meeting-prebake-core.js — the one rule for what a meeting prebake file says,
// and how each of its parts turns into something the rest of Trussal already
// understands.
//
// A prebake is a JSON file uploaded from the Studio toolbar that sets a whole
// meeting up in one go: the shared metaprogram, every human's and every bot's
// starting program and identity, each human's personal theme and gesture
// settings, and the chat lines people post when they arrive. Its shape:
//
//   {
//     "metaprogram": "<metaprogram editor text>",
//     "humans": { "<token>": { displayName, code, personalTheme,
//                              gestureAndLandmarkConfig, enableMediaPipe } },
//     "bots":   { "<token>": { displayName, code, enableMediaPipe } },
//     "meetingChat": { "<display name>": { text, files } },
//     "applySettingsToExistingParticipants": false,
//     "alternatives": [ { "settings": { <any of the keys above> },
//                         "timeout": <seconds>, "interval": <seconds> } ]
//   }
//
// Any setting a participant's entry leaves out falls back to its default.
// A human with no entry at all is left exactly as they are, unless
// `applySettingsToExistingParticipants` is true: then they are treated as
// having an empty entry, so they too are reset to the defaults.
//
// A human entry may also carry `customEmoji: [ { name, src } ]` — images
// added to their own emoji, each a :shortcode: named after its file.
//
// ALTERNATIVES rotate the meeting between settings while it runs. Each one is
// applied `timeout` seconds after the prebake was uploaded and then again
// every `interval` seconds (once only when there is no interval), exactly as
// setTimeout/setInterval would. Its `settings` follow every rule above — the
// participants it names are set to the state it describes, the others are
// left as they are — except that its metaprogram is only changed when it
// gives one. Two alternatives with interval 60 and timeouts 30 and 60 swap
// the meeting between them every 30 seconds. Alternatives cannot nest.
//
//   code  = { strudel, hydra, css, reactions, text,      (source strings)
//             samples: { <bank>: [ { name, src } ] },     (audio/image banks)
//             files:   { images, video, text, csv, tsv, json, other },
//             language, source }                          (editor language)
//   files = each bucket is [ { name, src } ], src an http(s) URL, a
//           same-origin path, or a data: URI.
//
// The source strings are joined into the participant's JPattern program.
// `language` picks the personal editor's language (an id from its dropdown,
// editor-languages-core.js — "jpattern" by default) and `source` is the
// buffer the editor opens on in that language, e.g. Tidal or Punctual code;
// without one it opens on the performer's own draft in that language. The
// JPattern program is still loaded as their JPattern draft, a dropdown away.
//
// Keys under `humans` are human participant tokens ("0", "1", … — join order,
// see latency-instrument/room-indices.js); keys under `bots` are bot tokens
// ("0a", "0b", …), owned by the human whose integer they lead with.
//
// Pure — no DOM, no network, no IndexedDB — so the same rules run in the
// browser glue (meeting-prebake.js) and under node:test.

import roomIndices from '../latency-instrument/room-indices.js';
import { ensureDirective } from './program-directive.js';
import {
  normalizeGestureAndLandmarkConfig,
  DEFAULT_GESTURE_MAPPINGS,
  CURSOR_TUNING,
} from './landmark-gesture-core.js';
import { kindOfFilename } from './file-cycles-core.js';
import { isAudioFile, isImageFile } from './user-samples.js';
import { MAX_EMOJI, emojiNameFromFilename } from './custom-emoji-core.js';
import { backingKindOf, BACKING_CALL_RE } from './backing-core.js';
import { rewriteSpecCalls, parseBreakoutLiteral } from './breakout-core.js';
import { parseMeetingLiteral } from './meeting-move-core.js';
import { splitStatements } from './text-cycles-core.js';
import { LANGUAGES, DEFAULT_LANGUAGE, isLanguage, getLanguage } from './editor-languages-core.js';
import {
  isHexColor,
  normalizeHex,
  isFontScale,
  WEB_SAFE_FONTS,
  DEFAULT_FONT,
  DEFAULT_FONT_SCALE,
} from './theme-context.js';

const { isValidParticipantToken, parseParticipantToken } = roomIndices;

// The whole file travels over the peer-state bus once and is cached by the
// sidecar for late joiners, so it is capped. The sidecar re-checks the same
// ceiling (latency-instrument/server.js PREBAKE_MAX_BYTES).
export const PREBAKE_MAX_BYTES = 64 * 1024 * 1024;

export const SETTINGS_KEYS = ['metaprogram', 'meetingChat', 'bots', 'humans', 'applySettingsToExistingParticipants'];
export const TOP_LEVEL_KEYS = [...SETTINGS_KEYS, 'alternatives'];
export const ALTERNATIVE_KEYS = ['settings', 'timeout', 'interval'];
export const HUMAN_KEYS = ['displayName', 'code', 'personalTheme', 'gestureAndLandmarkConfig', 'enableMediaPipe', 'customEmoji'];
export const BOT_KEYS = ['displayName', 'code', 'enableMediaPipe'];
export const CODE_KEYS = ['strudel', 'hydra', 'samples', 'files', 'css', 'reactions', 'text', 'language', 'source'];
export const THEME_KEYS = ['primaryColor', 'secondaryColor', 'invert', 'darkMode', 'fontFamily', 'fontSize', 'disableCssChanges'];
export const CHAT_KEYS = ['text', 'files'];
export const FILE_BUCKETS = ['images', 'video', 'text', 'csv', 'tsv', 'json', 'other'];

// The source-string parts of `code`, in the order they are joined into one
// editor buffer. Hydra leads because a block is only Hydra when its FIRST
// statement is `await initHydra(` (see hydra-code.js); everything after it is
// Strudel-shaped voices, each its own blank-line-separated paragraph.
export const SOURCE_KEYS = ['hydra', 'strudel', 'text', 'css', 'reactions'];

// An alternative re-applies a participant's whole entry (and may post chat
// and push code to bots), so it cannot repeat faster than this.
export const MIN_ALTERNATIVE_INTERVAL_S = 5;

const SRC_RE = /^(https?:\/\/|data:|\/|\.\/)/i;

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function extensionOf(name) {
  const base = String(name ?? '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// --- Validation -------------------------------------------------------------
//
// validatePrebake never throws. It returns every problem it finds, split into
// errors (the upload is refused) and warnings (the part is ignored, the rest
// still applies), each with a dotted path into the file so the uploader can
// find it.

function unknownKeys(obj, allowed, path, warnings) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) warnings.push(`${path}.${key}: unknown property, ignored`);
  }
}

// A bucket entry's extension must suit the bucket it sits in, or the file
// would be stored under a medium nothing can address it by.
function bucketAccepts(bucket, name, where) {
  const ext = extensionOf(name);
  if (bucket === 'csv' || bucket === 'tsv' || bucket === 'json') return ext === bucket;
  if (bucket === 'images') return kindOfFilename(name) === 'image';
  if (bucket === 'video') return kindOfFilename(name) === 'video';
  if (bucket === 'text') return ext === 'txt';
  // `other`: in a participant's code it must still be something file-cycles
  // can address (pdf, wav/mp3/ogg …); in chat anything posts as a download.
  return where === 'chat' ? true : kindOfFilename(name) != null;
}

function validateFileEntry(entry, path, errors) {
  if (!isPlainObject(entry)) { errors.push(`${path}: expected { "name", "src" }`); return false; }
  if (typeof entry.name !== 'string' || !entry.name.trim()) { errors.push(`${path}.name: expected a non-empty string`); return false; }
  if (/[\\/]/.test(entry.name)) { errors.push(`${path}.name: must be a bare filename, not a path`); return false; }
  if (typeof entry.src !== 'string' || !SRC_RE.test(entry.src)) {
    errors.push(`${path}.src: expected an http(s) URL, a /path, or a data: URI`);
    return false;
  }
  return true;
}

function validateFiles(files, path, where, errors, warnings) {
  if (!isPlainObject(files)) { errors.push(`${path}: expected an object of file buckets`); return; }
  unknownKeys(files, FILE_BUCKETS, path, warnings);
  for (const bucket of FILE_BUCKETS) {
    if (files[bucket] == null) continue;
    if (!Array.isArray(files[bucket])) { errors.push(`${path}.${bucket}: expected an array`); continue; }
    files[bucket].forEach((entry, i) => {
      const p = `${path}.${bucket}[${i}]`;
      if (!validateFileEntry(entry, p, errors)) return;
      if (!bucketAccepts(bucket, entry.name, where)) {
        errors.push(`${p}.name: "${entry.name}" does not belong in "${bucket}"`);
      }
    });
  }
}

function validateSamples(samples, path, errors) {
  if (!isPlainObject(samples)) { errors.push(`${path}: expected { "<bank>": [ { "name", "src" } ] }`); return; }
  for (const [bank, list] of Object.entries(samples)) {
    const p = `${path}.${bank}`;
    if (!/^[\w-]+$/.test(bank)) { errors.push(`${p}: a bank name may only use letters, digits, _ and -`); continue; }
    if (!Array.isArray(list)) { errors.push(`${p}: expected an array`); continue; }
    list.forEach((entry, i) => {
      if (!validateFileEntry(entry, `${p}[${i}]`, errors)) return;
      if (!isAudioFile(entry.name) && !isImageFile(entry.name)) {
        errors.push(`${p}[${i}].name: "${entry.name}" is not an audio or image file`);
      }
    });
  }
}

// Every backing("file") filename written as a plain string literal.
const BACKING_NAME_RE = /(?:^|[^\w$.])backing\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

// The calls in a source string that name things the room checks only when
// they fire — a backing() file, a breakout()/assign()/meeting() literal — are
// checked here with the same rules, so a typo is caught at upload rather than
// mid-performance.
function validateSourceCalls(src, path, isBot, errors, warnings) {
  for (const { text } of splitStatements(src)) {
    if (!BACKING_CALL_RE.test(text)) continue;
    if (isBot) { warnings.push(`${path}: bots cannot play backing() files, ignored`); continue; }
    for (const m of text.matchAll(BACKING_NAME_RE)) {
      const name = (m[1] ?? m[2]).replace(/\\(.)/g, '$1').trim();
      if (!backingKindOf(name)) errors.push(`${path}: backing("${name}") is not an audio or video file`);
    }
  }
  const check = (fns, parse) => rewriteSpecCalls(src, {
    fns, prefix: 'chk', render: '',
    parse: (body, fn) => {
      try { return parse(body, fn); } catch (e) { errors.push(`${path}: ${e.message}`); throw e; }
    },
  });
  check(['breakout', 'assign'], parseBreakoutLiteral);
  check(['meeting'], parseMeetingLiteral);
}

function validateCustomEmoji(list, path, errors) {
  if (!Array.isArray(list)) { errors.push(`${path}: expected an array of { "name", "src" }`); return; }
  if (list.length > MAX_EMOJI) errors.push(`${path}: at most ${MAX_EMOJI} emoji per person`);
  const seen = new Set();
  list.forEach((entry, i) => {
    const p = `${path}[${i}]`;
    if (!validateFileEntry(entry, p, errors)) return;
    if (kindOfFilename(entry.name) !== 'image') { errors.push(`${p}.name: "${entry.name}" is not an image`); return; }
    const short = emojiNameFromFilename(entry.name);
    if (seen.has(short)) errors.push(`${p}.name: another emoji is already named :${short}:`);
    seen.add(short);
  });
}

function validateCode(code, path, errors, warnings, isBot = false) {
  if (!isPlainObject(code)) { errors.push(`${path}: expected an object`); return; }
  unknownKeys(code, CODE_KEYS, path, warnings);
  for (const key of SOURCE_KEYS) {
    if (code[key] == null) continue;
    if (typeof code[key] !== 'string') errors.push(`${path}.${key}: expected a string`);
    else validateSourceCalls(code[key], `${path}.${key}`, isBot, errors, warnings);
  }
  if (code.language != null && !isLanguage(code.language)) {
    errors.push(`${path}.language: expected one of ${LANGUAGES.map((l) => `"${l.id}"`).join(', ')}`);
  }
  if (code.source != null && typeof code.source !== 'string') errors.push(`${path}.source: expected a string`);
  // Pure Strudel/Hydra reach the room as JPattern, so their calls fire there too.
  if (!isBot && typeof code.source === 'string' && isLanguage(code.language) && getLanguage(code.language).runs === 'room') {
    validateSourceCalls(code.source, `${path}.source`, isBot, errors, warnings);
  }
  if (isBot) {
    if ((code.language != null && code.language !== DEFAULT_LANGUAGE) || code.source != null) {
      warnings.push(`${path}.language: bots only run JPattern, ignored`);
    }
  } else if (code.source != null && (code.language == null || code.language === DEFAULT_LANGUAGE)) {
    warnings.push(`${path}.source: only used with a "language" other than "jpattern" (a JPattern program is written as strudel/hydra/text/css/reactions), ignored`);
  }
  if (code.samples != null) validateSamples(code.samples, `${path}.samples`, errors);
  if (code.files != null) validateFiles(code.files, `${path}.files`, 'code', errors, warnings);
}

function fontValueFor(family) {
  const match = WEB_SAFE_FONTS.find((f) => f.value === family || f.label === family
    || f.label.replace(/\s*\(default\)$/, '') === family);
  return match ? match.value : null;
}

function validateTheme(theme, path, errors, warnings) {
  if (!isPlainObject(theme)) { errors.push(`${path}: expected an object`); return; }
  unknownKeys(theme, THEME_KEYS, path, warnings);
  for (const key of ['primaryColor', 'secondaryColor']) {
    if (theme[key] != null && theme[key] !== '' && !isHexColor(theme[key])) {
      errors.push(`${path}.${key}: expected a hex colour such as "#1a2b3c", or ""`);
    }
  }
  for (const key of ['invert', 'darkMode', 'disableCssChanges']) {
    if (theme[key] != null && typeof theme[key] !== 'boolean') errors.push(`${path}.${key}: expected true or false`);
  }
  if (theme.fontFamily != null && !fontValueFor(theme.fontFamily)) {
    errors.push(`${path}.fontFamily: expected one of ${WEB_SAFE_FONTS.map((f) => `"${f.label.replace(/\s*\(default\)$/, '')}"`).join(', ')}`);
  }
  if (theme.fontSize != null && (typeof theme.fontSize !== 'number' || !isFontScale(theme.fontSize))) {
    errors.push(`${path}.fontSize: expected a number from 0.5 to 5 (1 = as authored)`);
  }
}

function validateParticipant(entry, path, isBot, errors, warnings) {
  if (!isPlainObject(entry)) { errors.push(`${path}: expected an object`); return; }
  if (isBot) {
    const HUMAN_ONLY = { personalTheme: 'personal theme', gestureAndLandmarkConfig: 'gesture settings', customEmoji: 'custom emoji' };
    for (const [key, what] of Object.entries(HUMAN_ONLY)) {
      if (key in entry) warnings.push(`${path}.${key}: bots have no ${what}, ignored`);
    }
    unknownKeys(entry, [...BOT_KEYS, ...Object.keys(HUMAN_ONLY)], path, warnings);
  } else {
    unknownKeys(entry, HUMAN_KEYS, path, warnings);
  }
  if (entry.displayName != null && (typeof entry.displayName !== 'string' || !entry.displayName.trim())) {
    errors.push(`${path}.displayName: expected a non-empty string`);
  }
  if (entry.enableMediaPipe != null && typeof entry.enableMediaPipe !== 'boolean') {
    errors.push(`${path}.enableMediaPipe: expected true or false`);
  }
  if (isBot && entry.enableMediaPipe != null) {
    warnings.push(`${path}.enableMediaPipe: bots have no camera-driven Landmark and Gesture Mode, ignored`);
  }
  if (entry.code != null) {
    validateCode(entry.code, `${path}.code`, errors, warnings, isBot);
    if (isBot && isPlainObject(entry.code) && entry.code.files != null) {
      warnings.push(`${path}.code.files: bots cannot post or hold file attachments yet, ignored`);
    }
  }
  if (!isBot && entry.customEmoji != null) validateCustomEmoji(entry.customEmoji, `${path}.customEmoji`, errors);
  if (!isBot && entry.personalTheme != null) validateTheme(entry.personalTheme, `${path}.personalTheme`, errors, warnings);
  if (!isBot && entry.gestureAndLandmarkConfig != null) {
    try {
      normalizeGestureAndLandmarkConfig(entry.gestureAndLandmarkConfig);
    } catch (e) {
      errors.push(`${path}.gestureAndLandmarkConfig: ${e.message}`);
    }
  }
}

function validateChat(chat, path, errors, warnings) {
  if (!isPlainObject(chat)) { errors.push(`${path}: expected { "<display name>": { "text", "files" } }`); return; }
  for (const [name, entry] of Object.entries(chat)) {
    const p = `${path}[${JSON.stringify(name)}]`;
    if (!name.trim()) { errors.push(`${p}: a display name cannot be blank`); continue; }
    if (!isPlainObject(entry)) { errors.push(`${p}: expected an object`); continue; }
    unknownKeys(entry, CHAT_KEYS, p, warnings);
    const text = entry.text;
    if (text != null && typeof text !== 'string'
      && !(Array.isArray(text) && text.every((t) => typeof t === 'string'))) {
      errors.push(`${p}.text: expected a string or an array of strings`);
    }
    if (entry.files != null) validateFiles(entry.files, `${p}.files`, 'chat', errors, warnings);
  }
}

// One settings object — the prebake itself, or an alternative's `settings` —
// under `root` ('$' or '$.alternatives[i].settings').
function validateSettings(prebake, root, errors, warnings) {
  if (prebake.metaprogram != null && typeof prebake.metaprogram !== 'string') {
    errors.push(`${root}.metaprogram: expected a string`);
  }
  if (prebake.applySettingsToExistingParticipants != null
    && typeof prebake.applySettingsToExistingParticipants !== 'boolean') {
    errors.push(`${root}.applySettingsToExistingParticipants: expected true or false`);
  }

  if (prebake.humans != null) {
    if (!isPlainObject(prebake.humans)) errors.push(`${root}.humans: expected an object keyed by participant token`);
    else for (const [token, entry] of Object.entries(prebake.humans)) {
      const parsed = isValidParticipantToken(token) ? parseParticipantToken(token) : null;
      if (!parsed || parsed.suffix != null) {
        errors.push(`${root}.humans.${token}: a human's token is a plain integer ("0", "1", …)`);
        continue;
      }
      validateParticipant(entry, `${root}.humans.${token}`, false, errors, warnings);
    }
  }

  if (prebake.bots != null) {
    if (!isPlainObject(prebake.bots)) errors.push(`${root}.bots: expected an object keyed by participant token`);
    else for (const [token, entry] of Object.entries(prebake.bots)) {
      const parsed = isValidParticipantToken(token) ? parseParticipantToken(token) : null;
      if (!parsed || parsed.suffix == null) {
        errors.push(`${root}.bots.${token}: a bot's token is its owner's integer plus a letter suffix ("0a", "1b", …)`);
        continue;
      }
      validateParticipant(entry, `${root}.bots.${token}`, true, errors, warnings);
    }
  }

  if (prebake.meetingChat != null) validateChat(prebake.meetingChat, `${root}.meetingChat`, errors, warnings);
}

function validateAlternatives(list, errors, warnings) {
  if (!Array.isArray(list)) { errors.push('$.alternatives: expected an array of { "settings", "timeout", "interval" }'); return; }
  list.forEach((alt, i) => {
    const p = `$.alternatives[${i}]`;
    if (!isPlainObject(alt)) { errors.push(`${p}: expected { "settings", "timeout", "interval" }`); return; }
    unknownKeys(alt, ALTERNATIVE_KEYS, p, warnings);
    if (!isPlainObject(alt.settings)) errors.push(`${p}.settings: expected an object of prebake settings`);
    else {
      if ('alternatives' in alt.settings) errors.push(`${p}.settings.alternatives: alternatives cannot nest`);
      unknownKeys(alt.settings, [...SETTINGS_KEYS, 'alternatives'], `${p}.settings`, warnings);
      validateSettings(alt.settings, `${p}.settings`, errors, warnings);
    }
    if (typeof alt.timeout !== 'number' || !Number.isFinite(alt.timeout) || alt.timeout < 0) {
      errors.push(`${p}.timeout: expected the seconds after upload it first applies (0 or more)`);
    }
    if (alt.interval != null && (typeof alt.interval !== 'number' || !Number.isFinite(alt.interval)
      || alt.interval < MIN_ALTERNATIVE_INTERVAL_S)) {
      errors.push(`${p}.interval: expected the seconds between repeats (${MIN_ALTERNATIVE_INTERVAL_S} or more), or leave it out to apply once`);
    }
  });
}

export function validatePrebake(prebake) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(prebake)) {
    return { errors: ['the file must be a JSON object'], warnings };
  }
  unknownKeys(prebake, TOP_LEVEL_KEYS, '$', warnings);
  validateSettings(prebake, '$', errors, warnings);
  if (prebake.alternatives != null) validateAlternatives(prebake.alternatives, errors, warnings);
  return { errors, warnings };
}

// Parse + validate the uploaded text in one step. `ok` is false whenever there
// is any error; `prebake` is only set when ok.
export function parsePrebake(text) {
  if (typeof text !== 'string') return { ok: false, errors: ['the file could not be read as text'], warnings: [] };
  if (text.length > PREBAKE_MAX_BYTES) {
    return { ok: false, errors: [`the file is over the ${PREBAKE_MAX_BYTES / (1024 * 1024)}MB limit`], warnings: [] };
  }
  let prebake;
  try { prebake = JSON.parse(text); } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${e.message}`], warnings: [] };
  }
  const { errors, warnings } = validatePrebake(prebake);
  return errors.length ? { ok: false, errors, warnings } : { ok: true, prebake, errors, warnings };
}

// --- Translation ------------------------------------------------------------

// One editor buffer from a participant's `code`, tagged for the editor it
// goes into ('personal' for a human, 'bot' for a bot). A Hydra part that
// leaves out its `await initHydra()` gets one, so it is still the block's
// first statement once joined; the other capability preambles are supplied at
// evaluation time by ensureCapabilityPreambles, exactly as for typed code.
// Returns null when there is no source to load, so a prebake that only sets a
// participant's samples leaves whatever they are already writing alone.
export function assembleProgram(code, kind) {
  if (!isPlainObject(code)) return null;
  const parts = [];
  for (const key of SOURCE_KEYS) {
    const src = typeof code[key] === 'string' ? code[key].trim() : '';
    if (!src) continue;
    if (key === 'hydra' && !/^\s*await\s+initHydra\s*\(/.test(src)) parts.push(`await initHydra()\n${src}`);
    else parts.push(src);
  }
  if (!parts.length) return null;
  return ensureDirective(`${parts.join('\n\n')}\n`, kind);
}

// The language the personal editor opens in for a participant's `code`, and
// the buffer to open it on (null: the performer's own draft in it).
// JPattern — the default — always opens on the assembled program.
export function editorLanguageFor(code) {
  const c = isPlainObject(code) ? code : {};
  const language = isLanguage(c.language) ? c.language : DEFAULT_LANGUAGE;
  if (language === DEFAULT_LANGUAGE) return { language, source: null };
  return { language, source: typeof c.source === 'string' ? c.source : null };
}

// A `personalTheme` as the full theme theme-context.js's setTheme takes. Every
// property the prebake leaves out — or the whole `personalTheme`, when it is
// absent — falls back to the theme's default, so a prebaked participant starts
// from the same place whatever this browser was last set to.
export function themePatch(theme) {
  const t = isPlainObject(theme) ? theme : {};
  return {
    primary: t.primaryColor != null ? normalizeHex(t.primaryColor) : '',
    secondary: t.secondaryColor != null ? normalizeHex(t.secondaryColor) : '',
    invert: t.invert != null ? !!t.invert : false,
    darkMode: t.darkMode != null ? !!t.darkMode : false,
    disableCss: t.disableCssChanges != null ? !!t.disableCssChanges : false,
    font: t.fontFamily != null ? fontValueFor(t.fontFamily) : DEFAULT_FONT,
    fontScale: t.fontSize != null ? t.fontSize : DEFAULT_FONT_SCALE,
  };
}

// The `gestureAndLandmarkConfig({...})` call for a prebaked human. The gesture
// map and the cursor tuning fall back to their defaults when left out. The
// three on/off limbs (keyboard, head cursor, gesture detection) are only in
// the result when the prebake names them: their default is whatever
// `enableMediaPipe` (itself off by default) switches the whole mode to, and
// the caller applies that first.
export function gestureConfigWithDefaults(config) {
  const c = isPlainObject(config) ? config : {};
  const out = {
    gestureMappings: Array.isArray(c.gestureMappings)
      ? c.gestureMappings
      : DEFAULT_GESTURE_MAPPINGS.map((m) => ({ ...m })),
  };
  for (const [key, { default: fallback }] of Object.entries(CURSOR_TUNING)) {
    out[key] = c[key] != null ? c[key] : fallback;
  }
  for (const key of ['virtualKeyboardEnabled', 'headCursorEnabled', 'gestureDetectionEnabled']) {
    if (c[key] != null) out[key] = c[key];
  }
  return out;
}

// Where a participant's `code.files` entry is stored: the data-pack store
// (referenced as "Name:3") for tabular files, the file-cycles store
// (image()/video()/textFile()/pdfFile()/soundFile()) for the rest.
export function codeFileStore(bucket) {
  return bucket === 'csv' || bucket === 'tsv' || bucket === 'json' ? 'data' : 'files';
}

// The file-cycles kind a chat attachment is rendered as. Tabular and unknown
// files have no medium of their own, so they post as a download link.
export function chatKindFor(bucket, name) {
  if (bucket === 'images') return 'image';
  if (bucket === 'video') return 'video';
  const kind = kindOfFilename(name);
  return kind && kind !== 'image' && kind !== 'video' ? kind : 'textFile';
}

// Every { bucket, name, src } in a files object, in bucket order.
export function flattenFiles(files) {
  if (!isPlainObject(files)) return [];
  const out = [];
  for (const bucket of FILE_BUCKETS) {
    for (const entry of Array.isArray(files[bucket]) ? files[bucket] : []) {
      out.push({ bucket, name: entry.name, src: entry.src });
    }
  }
  return out;
}

// Every { bank, name, src } in a samples object.
export function flattenSamples(samples) {
  if (!isPlainObject(samples)) return [];
  const out = [];
  for (const [bank, list] of Object.entries(samples)) {
    for (const entry of Array.isArray(list) ? list : []) out.push({ bank, name: entry.name, src: entry.src });
  }
  return out;
}

// The entry a human applies: their own, or — when the prebake asks for every
// participant to be reset — an empty one, which applies every default. Null
// means leave this participant untouched.
export function humanEntryFor(prebake, token) {
  const entry = isPlainObject(prebake?.humans) ? prebake.humans[String(token)] : null;
  if (isPlainObject(entry)) return entry;
  return prebake?.applySettingsToExistingParticipants === true ? {} : null;
}

// The bots one human owns, as [{ token, ordinal, entry }] sorted by ordinal.
export function botsForOwner(prebake, ownerIndex) {
  const bots = isPlainObject(prebake?.bots) ? prebake.bots : {};
  const out = [];
  for (const [token, entry] of Object.entries(bots)) {
    const parsed = isValidParticipantToken(token) ? parseParticipantToken(token) : null;
    if (!parsed || parsed.suffix == null || String(parsed.ownerIndex) !== String(ownerIndex)) continue;
    out.push({ token, ordinal: parsed.ordinal, entry });
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

// How many bots an owner must spawn so every listed token exists. The sidecar
// hands each new bot the LOWEST free suffix (lowestFreeBotOrdinal), so
// reaching ordinal n means filling every free slot from 0 to n — a prebake
// that lists "0a" and "0c" also gets an "0b", which plays the owner's code.
export function spawnCountFor(listedOrdinals, presentOrdinals) {
  if (!listedOrdinals.length) return 0;
  const highest = Math.max(...listedOrdinals);
  const present = new Set(presentOrdinals);
  let missing = 0;
  for (let i = 0; i <= highest; i++) if (!present.has(i)) missing++;
  return missing;
}

// The chat entry a participant posts, matched on their display name (trimmed,
// case-insensitive — Jitsi's own name field does neither, so a stray space or
// capital in the file should not silently drop someone's lines).
export function chatEntryFor(prebake, displayName) {
  const chat = isPlainObject(prebake?.meetingChat) ? prebake.meetingChat : null;
  if (!chat || typeof displayName !== 'string' || !displayName.trim()) return null;
  const want = displayName.trim().toLowerCase();
  const key = Object.keys(chat).find((k) => k.trim().toLowerCase() === want);
  return key != null && isPlainObject(chat[key]) ? chat[key] : null;
}

// A chat entry's text as a list of messages.
export function chatMessages(entry) {
  if (!entry) return [];
  const text = entry.text;
  const list = Array.isArray(text) ? text : (typeof text === 'string' ? [text] : []);
  return list.map((t) => t.trim()).filter(Boolean);
}

// --- Alternatives -----------------------------------------------------------
//
// Times here are milliseconds since the prebake was uploaded. Alternative i
// fires at timeout, timeout + interval, timeout + 2·interval, … (only at
// timeout when it has no interval).

function firingTimes(alt) {
  const timeout = Math.round(alt.timeout * 1000);
  const interval = alt.interval != null ? Math.round(alt.interval * 1000) : null;
  return { timeout, interval };
}

function validAlternatives(prebake) {
  return Array.isArray(prebake?.alternatives)
    ? prebake.alternatives.filter((a) => isPlainObject(a) && isPlainObject(a.settings) && typeof a.timeout === 'number')
    : [];
}

// The latest firing time at or before `elapsed`, or null when none has
// fired yet (the prebake's own settings still stand).
export function latestFiringAt(prebake, elapsed) {
  let best = null;
  for (const alt of validAlternatives(prebake)) {
    const { timeout, interval } = firingTimes(alt);
    if (timeout > elapsed) continue;
    const at = interval ? timeout + Math.floor((elapsed - timeout) / interval) * interval : timeout;
    if (best == null || at > best) best = at;
  }
  return best;
}

// The earliest firing time strictly after `elapsed`, or null when nothing
// will fire again.
export function nextFiringAt(prebake, elapsed) {
  let best = null;
  for (const alt of validAlternatives(prebake)) {
    const { timeout, interval } = firingTimes(alt);
    let at;
    if (timeout > elapsed) at = timeout;
    else if (interval) at = timeout + (Math.floor((elapsed - timeout) / interval) + 1) * interval;
    else continue;
    if (best == null || at < best) best = at;
  }
  return best;
}

// The settings of every alternative that fires at exactly `at`, in the
// order the file lists them — applied in that order, a later one wins where
// two set the same thing.
export function settingsFiringAt(prebake, at) {
  const out = [];
  for (const alt of validAlternatives(prebake)) {
    const { timeout, interval } = firingTimes(alt);
    if (at < timeout) continue;
    if (at === timeout || (interval && (at - timeout) % interval === 0)) out.push(alt.settings);
  }
  return out;
}

// Which human sets an alternative's metaprogram: the uploader while they are
// in the meeting, else the lowest-numbered human present, so a rotation does
// not stop when the person who started it leaves. `humanIndices` are the
// room indices of the humans present.
export function metaprogramApplierIndex(fromIndex, humanIndices) {
  const present = humanIndices.map(Number).filter(Number.isInteger);
  if (fromIndex != null && present.includes(Number(fromIndex))) return Number(fromIndex);
  return present.length ? Math.min(...present) : null;
}
