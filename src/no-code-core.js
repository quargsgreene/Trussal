// no-code-core.js — the one rule for what a No Code snippet library says, how
// the shared whiteboard is shaped, and what running the whiteboard does.
//
// A library is a JSON file uploaded from the No Code window:
//
//   { "snippets": [ {
//       "name": "Four on the floor",
//       "type": "pattern" | "room" | "assetPack" | "flow",
//       "thumbnailImage": "<svg or gif: URL, /path or data: URI>",
//       "thumbnailAudio": "<wav, played on hover AND click unless overridden>",
//       "thumbnailAudioHover": "<wav played on hover>",
//       "thumbnailAudioClick": "<wav played on click>",
//       "medium": "audio",              (free text: text, audio, video, …)
//       "language": "strudel",          (pattern: see PATTERN_LANGUAGES; flow: javascript)
//       "description": "…",
//       "operands": 0,                  (pattern and flow only, required)
//       "source": "…",                  (pattern/flow code; room: a prebake fragment)
//       "assets": { samples, files },   (assetPack only — the prebake `code` shape)
//       "singleShot": true              (assetPack with exactly one asset only)
//   } ] }
//
// THE WHITEBOARD is a list of lines run top to bottom. Each line holds one
// placed snippet; a placed pattern or flow has one slot per operand, and each
// slot holds another placed snippet (which can have slots of its own).
//
// RUNNING. Every snippet resolves to a VALUE (what it means as an operand) and
// a list of EFFECTS (what it does when run). An effect writes one SLOT: a part
// of the personal program (strudel, hydra, css, text, reactions), the shared
// metaprogram, a sample bank, a stored file, or one key of the room prebake.
// Lines run in order and a later write to the same slot replaces the earlier
// one; writes to different slots all stand.
//
//   pattern   value = its source with `{{0}}`, `{{1}}`, … replaced by the
//             operands' values; effect = that source into its language's slot.
//             Operands are consumed, not run — only their asset loads carry
//             through, so `s("{{0}}")` with an asset pack loads the pack too.
//   assetPack value = its first sample bank's name (else its first file's
//             name); effects = every bank and file it loads.
//   room      value = the fragment; effects = one per top-level key (and per
//             participant token under humans/bots, per name under meetingChat).
//   flow      an async JavaScript function body called as (operands, ctx).
//             Each operand is { name, type, language, medium, value }. It
//             returns (or resolves to) what the line runs: an operand, an
//             ad-hoc snippet such as { language: 'strudel', source: '…' }, an
//             array of those, or nothing. value = the first returned thing's
//             value. It may `await ctx.fetchJson(url)` to read live data.
//
// Pure — no DOM, and no network of its own: ctx.fetchJson is whatever the
// caller hands runBoard — so the same rules run in the browser glue
// (no-code.js) and under node:test.

import { validatePrebake, flattenFiles, flattenSamples, assembleProgram } from './meeting-prebake-core.js';
import { kindOfFilename } from './file-cycles-core.js';
import { isAudioFile } from './user-samples.js';
import { ensureDirective, stripDirective } from './program-directive.js';

// The whole library travels over the peer-state bus and is kept by the
// sidecar for the life of the meeting. latency-instrument/server.js
// NO_CODE_MAX_BYTES re-checks the same ceiling.
export const NO_CODE_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_OPERANDS = 8;
export const MAX_LINES = 200;
// Placed snippets can nest (an operand with operands of its own); a board
// deeper than this is a bug or a hostile peer, not a composition.
export const MAX_DEPTH = 8;

export const SNIPPET_TYPES = ['pattern', 'room', 'assetPack', 'flow'];
export const SNIPPET_KEYS = [
  'name', 'type', 'thumbnailImage', 'thumbnailAudio', 'thumbnailAudioHover', 'thumbnailAudioClick',
  'medium', 'language', 'description', 'operands', 'source', 'assets', 'singleShot',
];
const ASSET_KEYS = ['samples', 'files'];

// Pattern language → the slot it writes. jpattern and strudel share one: both
// are the Strudel-shaped voices of the personal program.
export const PATTERN_LANGUAGES = {
  jpattern: 'strudel',
  strudel: 'strudel',
  hydra: 'hydra',
  css: 'css',
  text: 'text',
  reactions: 'reactions',
  metaprogram: 'metaprogram',
};
export const FLOW_LANGUAGES = ['javascript', 'js'];

const SRC_RE = /^(https?:\/\/|data:|\/|\.\/)/i;
const PLACEHOLDER_RE = /\{\{\s*(\d+)\s*\}\}/g;

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function extensionOf(src) {
  const path = String(src ?? '').split(/[?#]/)[0];
  const base = path.split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// A media reference is acceptable when its data: URI's type, or its URL's
// extension, is one of the allowed ones.
function mediaIs(src, extensions, mimes) {
  if (typeof src !== 'string' || !SRC_RE.test(src)) return false;
  const data = /^data:([^;,]+)/i.exec(src);
  if (data) return mimes.includes(data[1].toLowerCase());
  return extensions.includes(extensionOf(src));
}

const isThumbnailImage = (src) => mediaIs(src, ['svg', 'gif'], ['image/svg+xml', 'image/gif']);
const isThumbnailAudio = (src) => mediaIs(src, ['wav'], ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

// The id a snippet is placed on the board by. Name and type together, so a
// re-upload of the same snippet replaces it in the library rather than
// stranding the lines that already use it.
export function snippetId(snippet) {
  return `${snippet.type}:${String(snippet.name).trim()}`;
}

// Every asset in an asset pack, as { medium, bucket|bank, name, src }.
export function assetsOf(snippet) {
  const assets = isPlainObject(snippet?.assets) ? snippet.assets : {};
  return [
    ...flattenSamples(assets.samples).map((s) => ({ ...s, medium: isAudioFile(s.name) ? 'audio' : 'image' })),
    ...flattenFiles(assets.files).map((f) => ({ ...f, medium: mediumOfFile(f.bucket, f.name) })),
  ];
}

function mediumOfFile(bucket, name) {
  if (bucket === 'video') return 'video';
  if (bucket === 'images') return 'image';
  if (bucket === 'text') return 'text';
  const kind = kindOfFilename(name);
  if (kind === 'soundFile') return 'audio';
  if (kind === 'textFile') return 'text';
  return kind || 'data';
}

// The media a single-shot asset streams as. Image and data assets have no
// stream to play, so only these three are accepted.
export const SINGLE_SHOT_MEDIA = ['audio', 'video', 'text'];

// The one asset a single-shot pack streams on click, or null.
export function singleShotAsset(snippet) {
  if (snippet?.type !== 'assetPack' || snippet.singleShot !== true) return null;
  const list = assetsOf(snippet);
  return list.length === 1 && SINGLE_SHOT_MEDIA.includes(list[0].medium) ? list[0] : null;
}

// --- Validation -------------------------------------------------------------
//
// Like validatePrebake: never throws, errors refuse the upload, warnings drop
// the part and keep the rest, each with a dotted path into the file.

function validateSnippet(s, path, errors, warnings) {
  if (!isPlainObject(s)) { errors.push(`${path}: expected an object`); return; }
  for (const key of Object.keys(s)) {
    if (!SNIPPET_KEYS.includes(key)) warnings.push(`${path}.${key}: unknown property, ignored`);
  }
  if (typeof s.name !== 'string' || !s.name.trim()) errors.push(`${path}.name: expected a non-empty string`);
  if (!SNIPPET_TYPES.includes(s.type)) {
    errors.push(`${path}.type: expected one of ${SNIPPET_TYPES.map((t) => `"${t}"`).join(', ')}`);
    return;
  }
  for (const key of ['medium', 'language', 'description']) {
    if (s[key] != null && typeof s[key] !== 'string') errors.push(`${path}.${key}: expected a string`);
  }
  if (s.thumbnailImage != null && !isThumbnailImage(s.thumbnailImage)) {
    errors.push(`${path}.thumbnailImage: expected an .svg or .gif URL, /path, or data: URI`);
  }
  for (const key of ['thumbnailAudio', 'thumbnailAudioHover', 'thumbnailAudioClick']) {
    if (s[key] != null && !isThumbnailAudio(s[key])) errors.push(`${path}.${key}: expected a .wav URL, /path, or data: URI`);
  }

  const takesOperands = s.type === 'pattern' || s.type === 'flow';
  if (takesOperands) {
    if (!Number.isInteger(s.operands) || s.operands < 0 || s.operands > MAX_OPERANDS) {
      errors.push(`${path}.operands: a ${s.type} must give its number of operands, a whole number from 0 to ${MAX_OPERANDS}`);
    }
    if (typeof s.source !== 'string') errors.push(`${path}.source: expected a string of ${s.type === 'flow' ? 'JavaScript' : 'code'}`);
  } else if (s.operands != null) {
    warnings.push(`${path}.operands: only patterns and flows take operands, ignored`);
  }

  if (s.type === 'pattern') {
    if (!(s.language in PATTERN_LANGUAGES)) {
      errors.push(`${path}.language: a pattern's language is one of ${Object.keys(PATTERN_LANGUAGES).map((l) => `"${l}"`).join(', ')}`);
    }
    if (typeof s.source === 'string' && Number.isInteger(s.operands)) {
      for (const m of s.source.matchAll(PLACEHOLDER_RE)) {
        if (Number(m[1]) >= s.operands) {
          errors.push(`${path}.source: {{${m[1]}}} names an operand this pattern does not have (it has ${s.operands})`);
          break;
        }
      }
    }
  }
  if (s.type === 'flow') {
    if (!FLOW_LANGUAGES.includes(String(s.language ?? '').toLowerCase())) {
      errors.push(`${path}.language: a flow is written in "javascript"`);
    } else if (typeof s.source === 'string') {
      try { compileFlow(s.source); } catch (e) { errors.push(`${path}.source: ${e.message}`); }
    }
  }
  if (s.type === 'room') {
    let fragment = s.source;
    if (typeof fragment === 'string') {
      try { fragment = JSON.parse(fragment); } catch (e) { errors.push(`${path}.source: not valid JSON: ${e.message}`); return; }
    }
    const result = validatePrebake(fragment);
    for (const e of result.errors) errors.push(`${path}.source${e.replace(/^\$/, '')}`);
    for (const w of result.warnings) warnings.push(`${path}.source${w.replace(/^\$/, '')}`);
  }
  if (s.type === 'assetPack') {
    if (!isPlainObject(s.assets)) { errors.push(`${path}.assets: an asset pack needs { "samples", "files" }`); return; }
    for (const key of Object.keys(s.assets)) {
      if (!ASSET_KEYS.includes(key)) warnings.push(`${path}.assets.${key}: unknown property, ignored`);
    }
    // The same shape as a prebake participant's `code`, so it is checked by
    // the same rules.
    const asCode = validatePrebake({ humans: { 0: { code: { samples: s.assets.samples, files: s.assets.files } } } });
    for (const e of asCode.errors) errors.push(e.replace('$.humans.0.code', `${path}.assets`));
    if (!assetsOf(s).length && !asCode.errors.length) errors.push(`${path}.assets: the pack holds no assets`);
    if (s.singleShot != null) {
      if (typeof s.singleShot !== 'boolean') errors.push(`${path}.singleShot: expected true or false`);
      else if (s.singleShot && !asCode.errors.length) {
        const list = assetsOf(s);
        if (list.length !== 1) errors.push(`${path}.singleShot: a single-shot pack holds exactly one asset (this one has ${list.length})`);
        else if (!SINGLE_SHOT_MEDIA.includes(list[0].medium)) {
          errors.push(`${path}.singleShot: "${list[0].name}" is ${list[0].medium}; only audio, video and text stream`);
        }
      }
    }
  } else {
    if (s.assets != null) warnings.push(`${path}.assets: only asset packs carry assets, ignored`);
    if (s.singleShot != null) warnings.push(`${path}.singleShot: only asset packs can be single-shot, ignored`);
  }
}

export function validateLibrary(library) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(library)) return { errors: ['the file must be a JSON object'], warnings };
  for (const key of Object.keys(library)) {
    if (key !== 'snippets') warnings.push(`$.${key}: unknown property, ignored`);
  }
  if (!Array.isArray(library.snippets)) return { errors: ['$.snippets: expected an array'], warnings };
  const seen = new Map();
  library.snippets.forEach((s, i) => {
    validateSnippet(s, `$.snippets[${i}]`, errors, warnings);
    if (isPlainObject(s) && typeof s.name === 'string' && SNIPPET_TYPES.includes(s.type)) {
      const id = snippetId(s);
      if (seen.has(id)) warnings.push(`$.snippets[${i}]: same name and type as $.snippets[${seen.get(id)}], which it replaces`);
      seen.set(id, i);
    }
  });
  return { errors, warnings };
}

// Parse + validate the uploaded text. `snippets` is only set when ok, with
// each snippet's id attached and same-id duplicates collapsed to the last.
export function parseLibrary(text) {
  if (typeof text !== 'string') return { ok: false, errors: ['the file could not be read as text'], warnings: [] };
  if (text.length > NO_CODE_MAX_BYTES) {
    return { ok: false, errors: [`the file is over the ${NO_CODE_MAX_BYTES / (1024 * 1024)}MB limit`], warnings: [] };
  }
  let library;
  try { library = JSON.parse(text); } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${e.message}`], warnings: [] };
  }
  const { errors, warnings } = validateLibrary(library);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, snippets: mergeLibrary([], library.snippets), errors, warnings };
}

// The room's library after an upload: every earlier snippet, with any the
// upload names again replaced in place, then the new ones in file order.
export function mergeLibrary(current, incoming) {
  const out = (Array.isArray(current) ? current : []).map((s) => ({ ...s }));
  const at = new Map(out.map((s, i) => [s.id, i]));
  for (const raw of incoming) {
    const s = { ...raw, name: String(raw.name).trim(), id: snippetId(raw) };
    for (const key of Object.keys(s)) if (key !== 'id' && !SNIPPET_KEYS.includes(key)) delete s[key];
    if (at.has(s.id)) out[at.get(s.id)] = s;
    else { at.set(s.id, out.length); out.push(s); }
  }
  return out;
}

export function libraryById(library) {
  return new Map((Array.isArray(library) ? library : []).map((s) => [s.id, s]));
}

// The audio an icon plays on hover or click: its own, else the shared one.
export function thumbnailAudioFor(snippet, event) {
  const own = event === 'hover' ? snippet?.thumbnailAudioHover : snippet?.thumbnailAudioClick;
  return own || snippet?.thumbnailAudio || null;
}

export function operandCount(snippet) {
  return snippet && (snippet.type === 'pattern' || snippet.type === 'flow') && Number.isInteger(snippet.operands)
    ? snippet.operands
    : 0;
}

// --- The whiteboard ---------------------------------------------------------
//
// board = { rev, lines: [ node ] }, node = { ref, operands: [ node | null ] }.
// A path addresses a node: [line] for a whole line, [line, i, j, …] for the
// operand slot reached by following operand indices down from that line.
// Every edit returns a new board with rev bumped; the board is shared, and
// whoever edits last wins.

export function emptyBoard() {
  return { rev: 0, lines: [] };
}

export function placeNode(snippet) {
  return { ref: snippet.id, operands: new Array(operandCount(snippet)).fill(null) };
}

function cloneBoard(board) {
  return { rev: (board?.rev ?? 0) + 1, lines: structuredClone(Array.isArray(board?.lines) ? board.lines : []) };
}

// The operand array holding the slot at `path`, and the slot's index in it.
function slotAt(lines, path) {
  let node = lines[path[0]];
  for (let k = 1; k < path.length - 1; k++) node = node?.operands?.[path[k]];
  if (!node || !Array.isArray(node.operands)) return null;
  const i = path[path.length - 1];
  return i >= 0 && i < node.operands.length ? { list: node.operands, i } : null;
}

export function addLine(board, snippet, at = null) {
  const next = cloneBoard(board);
  if (!snippet || next.lines.length >= MAX_LINES) return board;
  const index = at == null ? next.lines.length : Math.max(0, Math.min(at, next.lines.length));
  next.lines.splice(index, 0, placeNode(snippet));
  return next;
}

// Drop a snippet into the operand slot at `path` (path.length >= 2), or onto
// the line itself (path.length === 1, replacing what the line holds).
export function placeAt(board, path, snippet) {
  if (!snippet || !Array.isArray(path) || !path.length || path.length > MAX_DEPTH + 1) return board;
  const next = cloneBoard(board);
  if (path.length === 1) {
    if (path[0] < 0 || path[0] >= next.lines.length) return board;
    next.lines[path[0]] = placeNode(snippet);
    return next;
  }
  const slot = slotAt(next.lines, path);
  if (!slot) return board;
  slot.list[slot.i] = placeNode(snippet);
  return next;
}

// Remove a whole line, or empty one operand slot.
export function removeAt(board, path) {
  if (!Array.isArray(path) || !path.length) return board;
  const next = cloneBoard(board);
  if (path.length === 1) {
    if (path[0] < 0 || path[0] >= next.lines.length) return board;
    next.lines.splice(path[0], 1);
    return next;
  }
  const slot = slotAt(next.lines, path);
  if (!slot) return board;
  slot.list[slot.i] = null;
  return next;
}

export function moveLine(board, from, to) {
  const n = board?.lines?.length ?? 0;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return board;
  const next = cloneBoard(board);
  const [line] = next.lines.splice(from, 1);
  next.lines.splice(to, 0, line);
  return next;
}

// A board received from the room, trimmed to what this module can address:
// unknown fields dropped, depth and size bounded. References to snippets the
// library does not (yet) hold are kept — the library may arrive after it.
export function sanitizeBoard(board) {
  const clean = (node, depth) => {
    if (!isPlainObject(node) || typeof node.ref !== 'string' || depth > MAX_DEPTH) return null;
    const operands = Array.isArray(node.operands) ? node.operands.slice(0, MAX_OPERANDS) : [];
    return { ref: node.ref.slice(0, 400), operands: operands.map((o) => clean(o, depth + 1)) };
  };
  const lines = Array.isArray(board?.lines) ? board.lines.slice(0, MAX_LINES) : [];
  return {
    rev: Number.isInteger(board?.rev) ? board.rev : 0,
    lines: lines.map((l) => clean(l, 0)).filter(Boolean),
  };
}

// --- Running ----------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// Async, so a flow can `await ctx.fetchJson(…)`; a body that never awaits
// runs exactly as it reads.
export function compileFlow(source) {
  return new AsyncFunction('operands', 'ctx', `"use strict";\n${source}`);
}

const noNetwork = () => Promise.reject(new Error('this board was run without network access (ctx.fetchJson)'));

// A small seeded PRNG (mulberry32), so every browser running the same board
// revision draws the same ctx.random() sequence.
function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function substitute(source, values) {
  return source.replace(PLACEHOLDER_RE, (_, i) => {
    const v = values[Number(i)];
    return typeof v === 'string' ? v : JSON.stringify(v ?? null);
  });
}

function roomFragment(snippet) {
  return typeof snippet.source === 'string' ? JSON.parse(snippet.source) : (snippet.source ?? {});
}

// One effect per independently overridable part of a room fragment.
function roomEffects(fragment) {
  const out = [];
  for (const [key, value] of Object.entries(fragment)) {
    if ((key === 'humans' || key === 'bots' || key === 'meetingChat') && isPlainObject(value)) {
      for (const [sub, entry] of Object.entries(value)) {
        out.push({ kind: 'room', slot: `room:${key}.${sub}`, path: [key, sub], value: entry });
      }
    } else {
      out.push({ kind: 'room', slot: `room:${key}`, path: [key], value });
    }
  }
  return out;
}

function assetEffects(snippet) {
  return assetsOf(snippet).map((a) => (a.bank != null
    ? { kind: 'assets', slot: `bank:${a.bank}/${a.name}`, sample: { bank: a.bank, name: a.name, src: a.src } }
    : { kind: 'assets', slot: `file:${a.bucket}/${a.name}`, file: { bucket: a.bucket, name: a.name, src: a.src } }));
}

function patternEffect(language, source) {
  const part = PATTERN_LANGUAGES[language];
  if (part === 'metaprogram') return { kind: 'metaprogram', slot: 'metaprogram', source };
  return { kind: 'program', slot: `program:${part}`, part, source };
}

function assetPackValue(snippet) {
  const assets = isPlainObject(snippet.assets) ? snippet.assets : {};
  const banks = isPlainObject(assets.samples) ? Object.keys(assets.samples) : [];
  if (banks.length) return banks[0];
  return assetsOf(snippet)[0]?.name ?? '';
}

// A flow's return value as snippets to run: an operand handed back, an ad-hoc
// { type?, language, source, operands?, assets? }, or a list of those.
function flowOutputs(ret, operandNodes) {
  const list = ret == null ? [] : (Array.isArray(ret) ? ret : [ret]);
  return list.filter((r) => r != null).map((r) => {
    if (isPlainObject(r) && r.__operand != null) return { resolved: operandNodes[r.__operand] };
    if (typeof r === 'string') return { adHoc: { type: 'pattern', language: 'strudel', source: r } };
    if (isPlainObject(r)) return { adHoc: { type: r.type || 'pattern', ...r } };
    throw new Error(`a flow returned ${typeof r}; return an operand, a snippet object, a string, or an array of them`);
  });
}

// Resolve one placed node to { value, effects }. Rejects with a readable
// message for anything that stops the line.
async function resolve(node, lib, env, depth) {
  if (depth > MAX_DEPTH) throw new Error('snippets are nested too deeply');
  const snippet = node.adHoc || lib.get(node.ref);
  if (!snippet) throw new Error(`"${node.ref}" is not in the library`);
  const label = `"${snippet.name ?? snippet.type}"`;
  const operands = [];
  for (const [i, o] of (node.operands || []).entries()) {
    if (o == null) throw new Error(`${label} is missing operand ${i + 1} of ${operandCount(snippet) || node.operands.length}`);
    operands.push(await resolve(o, lib, env, depth + 1));
  }

  switch (snippet.type) {
    case 'pattern': {
      if (!(snippet.language in PATTERN_LANGUAGES)) throw new Error(`${label}: unknown pattern language "${snippet.language}"`);
      const source = substitute(String(snippet.source ?? ''), operands.map((o) => o.value));
      const loads = operands.flatMap((o) => o.effects.filter((e) => e.kind === 'assets'));
      return { value: source, snippet, effects: [...loads, patternEffect(snippet.language, source)] };
    }
    case 'assetPack':
      return { value: assetPackValue(snippet), snippet, effects: assetEffects(snippet) };
    case 'room': {
      const fragment = roomFragment(snippet);
      return { value: fragment, snippet, effects: roomEffects(fragment) };
    }
    case 'flow': {
      const fn = compileFlow(String(snippet.source ?? ''));
      const view = operands.map((o, i) => Object.freeze({
        __operand: i,
        name: o.snippet.name ?? null,
        type: o.snippet.type,
        language: o.snippet.language ?? null,
        medium: o.snippet.medium ?? null,
        value: o.value,
      }));
      let ret;
      try {
        ret = await fn(Object.freeze(view), env.ctx);
      } catch (e) {
        throw new Error(`${label}: ${e.message}`);
      }
      const outs = [];
      for (const o of flowOutputs(ret, operands)) {
        outs.push(o.resolved || await resolve({ adHoc: o.adHoc, operands: [] }, lib, env, depth + 1));
      }
      return { value: outs[0]?.value ?? null, snippet, effects: outs.flatMap((o) => o.effects) };
    }
    default:
      throw new Error(`${label}: unknown snippet type "${snippet.type}"`);
  }
}

// Run the board. `env` = { token, activeToken, isMyTurn, fetchJson }
// describes this browser at the moment of running; flows read it as ctx.
// Resolves to the merged plan and every line's error (a failing line is
// skipped, the rest still run). Lines run one after another, never
// interleaved, so ctx.random draws in the same order whatever a flow awaits.
//
//   plan = {
//     samples:     [ { bank, name, src } ],      (to load)
//     files:       { <bucket>: [ { name, src } ] },
//     prebake:     object | null,                (room fragments, merged)
//     metaprogram: string | null,
//     program:     string | null,                (the personal editor buffer)
//   }
export async function runBoard(board, library, env = {}) {
  const lib = libraryById(library);
  const lines = Array.isArray(board?.lines) ? board.lines : [];
  const random = seededRandom(board?.rev ?? 0);
  const slots = new Map();
  const errors = [];

  for (const [i, line] of lines.entries()) {
    const ctx = Object.freeze({
      line: i,
      lines: lines.length,
      token: env.token ?? null,
      activeToken: env.activeToken ?? null,
      isMyTurn: env.isMyTurn !== false,
      random,
      fetchJson: env.fetchJson ?? noNetwork,
    });
    try {
      for (const effect of (await resolve(line, lib, { ctx }, 0)).effects) {
        // Delete first so the map's order is the order of the LAST write —
        // the order the plan applies things in.
        slots.delete(effect.slot);
        slots.set(effect.slot, effect);
      }
    } catch (e) {
      errors.push({ line: i, message: e.message });
    }
  }

  return { plan: planFrom([...slots.values()]), errors };
}

function planFrom(effects) {
  const plan = { samples: [], files: {}, prebake: null, metaprogram: null, program: null };
  const parts = {};
  for (const e of effects) {
    if (e.kind === 'assets') {
      if (e.sample) plan.samples.push(e.sample);
      else (plan.files[e.file.bucket] ||= []).push({ name: e.file.name, src: e.file.src });
    } else if (e.kind === 'room') {
      plan.prebake ||= {};
      if (e.path.length === 1) plan.prebake[e.path[0]] = e.value;
      else (plan.prebake[e.path[0]] ||= {})[e.path[1]] = e.value;
    } else if (e.kind === 'metaprogram') {
      plan.metaprogram = ensureDirective(stripDirective(e.source), 'metaprogram');
    } else if (e.kind === 'program') {
      parts[e.part] = stripDirective(e.source);
    }
  }
  plan.program = assembleProgram(parts, 'personal');
  return plan;
}
