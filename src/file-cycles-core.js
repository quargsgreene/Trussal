// file-cycles-core.js — pure logic for file-attachment patterns: which
// extension belongs to which medium, the 10MB cap, and the call/mint
// rewriting that gets a filename argument (which may contain characters mini
// notation cannot hold — a space, mixed case with punctuation) safely through
// the transpiler and back out again with its authoring peer attached.
//
// No DOM, no Strudel, no network — runs identically in the browser bundle,
// the sidecar (size cap only — see latency-instrument/server.js) and under
// node:test. The browser glue (IndexedDB upload store, the sidecar round
// trip, chat rendering) lives in file-cycles.js.
//
// Reuses text-cycles-core.js's encodeMiniText/splitStatements rather than
// reimplementing them: a filename is exactly the same problem word() already
// solves (arbitrary literal text inside a mini-notation argument), so it gets
// the same placeholder-token treatment and the same peer-tagged atom table —
// see text-cycles-core.js's file doc comment for why that machinery exists.

import { splitStatements, encodeMiniText } from './text-cycles-core.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// One entry per medium: the Strudel function name a performer writes, and the
// extensions that function accepts. Deliberately separate from
// user-samples.js's IMAGE_EXTENSIONS/AUDIO_EXTENSIONS — those classify
// uploads for Hydra sources and sample banks, a different feature with a
// different allow-list (svg/bmp are valid chat images but not Hydra sources;
// m4a is listed as video here rather than audio, per the feature spec, even
// though it is usually an audio-only container).
export const FILE_KINDS = {
  image: { param: 'image', extensions: ['gif', 'jpeg', 'jpg', 'png', 'svg', 'bmp'] },
  video: { param: 'video', extensions: ['mp4', 'm4a', 'mov'] },
  textFile: { param: 'textFile', extensions: ['txt'] },
  pdfFile: { param: 'pdfFile', extensions: ['pdf'] },
  soundFile: { param: 'soundFile', extensions: ['wav', 'mp3', 'ogg'] },
};

const EXT_TO_KIND = new Map();
for (const [kind, { extensions }] of Object.entries(FILE_KINDS)) {
  for (const ext of extensions) EXT_TO_KIND.set(ext, kind);
}

function extensionOf(filename) {
  return String(filename ?? '').split('.').pop().toLowerCase();
}

// The medium a filename belongs to, or null for an unsupported extension.
export function kindOfFilename(filename) {
  return EXT_TO_KIND.get(extensionOf(filename)) ?? null;
}

const MIME_BY_EXT = {
  gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', m4a: 'video/mp4', mov: 'video/quicktime',
  txt: 'text/plain', pdf: 'application/pdf',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
};

export function mimeOfFilename(filename) {
  return MIME_BY_EXT[extensionOf(filename)] ?? 'application/octet-stream';
}

// Reject up front, before a single byte is read into memory — the same
// contract user-samples.js's uploadSamplesToDB gives audio/image uploads.
export function validateUpload(name, size) {
  const kind = kindOfFilename(name);
  if (!kind) return { ok: false, reason: `"${name}": unsupported file type` };
  if (typeof size === 'number' && size > MAX_FILE_BYTES) {
    return { ok: false, reason: `"${name}": over the 10MB limit` };
  }
  return { ok: true, kind };
}

// Every function name file-cycles.js registers, longest-first so a shared
// prefix never wins early — mirrors text-cycles-core.js's TEXT_VALUE_PARAMS.
export const FILE_PARAMS = Object.keys(FILE_KINDS).sort((a, b) => b.length - a.length);

// Any of the five call names, in any position including chained.
export const FILE_CALL_RE = new RegExp(`(?:^|[^\\w$])(?:${FILE_PARAMS.join('|')})\\s*\\(`);

const STRING_LITERAL = '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)';

function literalBody(raw) {
  return { quote: raw[0], body: raw.slice(1, -1) };
}

// Rewrite every image()/video()/textFile()/pdfFile()/soundFile() argument in
// `code`, minting each literal filename into a placeholder token exactly as
// rewriteTextCalls mints a word — see that function's own doc comment for why
// (an uploaded filename may hold a space or other character mini notation
// cannot; the mint carries it out-of-band, and the token positions attach a
// peer). Attaches the ._fcRender() renderer on its own line to any statement
// that named one of these calls.
export function rewriteFileCalls(code, { peer = null, counter = { n: 0 } } = {}) {
  const atoms = {};
  const mint = (text) => {
    const token = `fc${counter.n++}`;
    atoms[token] = { text, peer };
    return token;
  };

  const re = new RegExp(`((?:^|[^\\w$])(?:${FILE_PARAMS.join('|')})\\s*\\(\\s*)${STRING_LITERAL}`, 'g');

  const rewriteStatement = (text) => {
    if (!FILE_CALL_RE.test(text)) return text;
    const out = text.replace(re, (match, head, raw) => {
      if (raw[0] === '`' && raw.includes('${')) return match;
      const { quote, body } = literalBody(raw);
      const encoded = quote === "'" ? mint(body) : encodeMiniText(body, mint);
      return `${head}"${encoded}"`;
    });
    return `${out.replace(/[\s;]+$/, '')}\n._fcRender()`;
  };

  const rewritten = splitStatements(String(code ?? ''))
    .map(({ text }) => rewriteStatement(text))
    .join('\n');

  return { code: rewritten, atoms };
}

const INIT_FILE_CYCLES_RE = /^\s*await\s+initFileCycles\s*\(/m;
export const INIT_FILE_CYCLES_PATTERN = { source: INIT_FILE_CYCLES_RE.source, flags: INIT_FILE_CYCLES_RE.flags };

export function hasFileCycles(code) {
  return INIT_FILE_CYCLES_RE.test(String(code ?? ''));
}
