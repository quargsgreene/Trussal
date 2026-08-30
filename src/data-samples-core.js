// data-samples-core.js — turning an uploaded JSON/CSV/TSV file into "samples".
//
// A data pack is the non-audio half of the sample uploader: a file becomes a
// pack named after itself, and each of its columns (CSV/TSV) or top-level
// properties (JSON) becomes one sample holding a list of values. A performer
// references them exactly like an audio bank — `"Weather:3"` — except a data
// sample is never a sound; it is a pattern of values that can drive a Strudel
// parameter, a Hydra parameter, Text Cycles or JPattern.
//
// Everything here is pure: no DOM, no IndexedDB, no Strudel. Storage lives in
// user-samples.js and pattern construction in data-ref.js, so the parsing and
// casting rules can be tested on their own.
//
// Two rules shape most of the code below:
//
//   Determinism. The room's program is evaluated in every peer's browser and
//   by the aggregator, so a pack is broadcast over the peer-state bus and must
//   deserialize to the same numbers everywhere. That is why values are rounded
//   to a fixed precision HERE, at parse time, rather than on the wire — the
//   author holds the same rounded values every listener does.
//
//   Bounded size. A pack rides the bus in every roster message, so the caps
//   below are a memory budget and a wire budget at once. Truncation is always
//   "keep the head, drop the tail" and is reported, never silent.

// Caps. MAX_VALUES_TOTAL is per browser, across every pack: at ~8 bytes a
// value serialized these bound one peer's contribution to a roster message to
// roughly 130KB worst case.
export const MAX_VALUES_PER_SAMPLE = 1024;
export const MAX_SAMPLES_PER_PACK = 64;
export const MAX_VALUES_PER_PACK = 8192;
export const MAX_VALUES_TOTAL = 16384;

// Significant digits every parsed value is rounded to. Six keeps a float's
// musically meaningful range while making the serialized form short and, more
// importantly, identical on every peer.
const VALUE_PRECISION = 6;

const DATA_EXTENSIONS = new Set(['json', 'csv', 'tsv']);

export function isDataFile(filename) {
  return DATA_EXTENSIONS.has(extensionOf(filename));
}

export function extensionOf(filename) {
  const base = String(filename ?? '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// Values Strudel already parses on its own — note names (c4, a#3, Eb2) and the
// mini-notation rest. The spec is explicit that these pass through uncast: a
// column of note names should stay usable in .note(), and casting "c4" through
// the numeric path below would silently yield 4.
//
// A bare single letter a–g is NOT enough on its own: Strudel itself would read
// it as a note, but so would a column of letter grades ("A".."F") or any other
// single-letter category, and a grade that silently stays the string "F"
// instead of becoming an ordinal turns into NaN the moment it reaches a
// numeric control several layers downstream. An octave digit or an accidental
// is what makes a token unambiguously a note ("c4", "a#", "ces"); without
// either, it falls through to the ordinal path below like any other category.
const NOTE_RE = /^[a-gA-G](?:(?:[#bs]|es|is)+(?:-?[0-9])?|-?[0-9])$/;
const REST = '~';

export function isRecognizedStrudelValue(text) {
  return text === REST || NOTE_RE.test(text);
}

// Lenient numeric read: the first number in the string, ignoring grouping
// separators and any unit stuck to it. "1,234" → 1234, "$1,234.56" → 1234.56,
// "72F" → 72, "45%" → 45, "-3.5e2 kg" → -350. Returns null when there is no
// leading number at all, which sends the value to the ordinal path.
//
// Anchored at the start (after currency/sign punctuation) on purpose: an
// unanchored search would pull the 4 out of "c4" and the 3 out of "room3",
// turning distinct categories into arbitrary numbers.
export function parseLenientNumber(text) {
  const m = /^[\s$£€¥+]*(-?\d[\d,_ ]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text);
  if (!m) return null;
  const cleaned = m[1].replace(/[,_ ]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// How many raw→cast pairs the column-name tooltip shows. A sample can hold up
// to MAX_VALUES_PER_SAMPLE values; the tooltip only needs enough to show the
// casting rule in action, not the whole column.
const PREVIEW_ROWS = 8;

// "sunny → 0\nrain → 1\n… (+9 more)" — exactly what castValue did to this
// column's first few rows, so a performer can see why a value they typed as
// text became a number (or stayed a string) without opening devtools.
export function buildPreview(rawValues, castValues) {
  const rows = [];
  for (let i = 0; i < rawValues.length && rows.length < PREVIEW_ROWS; i++) {
    const raw = rawValues[i];
    const rawText = raw === null || raw === undefined || raw === '' ? '(empty)' : String(raw);
    const cast = castValues[i];
    rows.push(`${rawText} → ${typeof cast === 'string' ? `"${cast}"` : cast}`);
  }
  if (rawValues.length > rows.length) rows.push(`… (+${rawValues.length - rows.length} more)`);
  return rows.join('\n');
}

export function roundValue(n) {
  if (!Number.isFinite(n)) return 0;
  if (n === 0) return 0;
  return Number(n.toPrecision(VALUE_PRECISION));
}

/**
 * Cast one raw cell/property value to something a pattern can carry.
 *
 * `ordinals` is a per-sample Map of first-seen text → index, so an unparseable
 * category column ("sunny", "rain", "sunny") becomes a stable 0, 1, 0. It is
 * per sample rather than per pack so two columns' categories never collide.
 */
export function castValue(raw, ordinals) {
  if (typeof raw === 'number') return roundValue(raw);
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (raw === null || raw === undefined) return 0;

  const text = String(raw).trim();
  if (text === '') return 0;
  if (isRecognizedStrudelValue(text)) return text;

  const n = parseLenientNumber(text);
  if (n !== null) return roundValue(n);

  if (!ordinals.has(text)) ordinals.set(text, ordinals.size);
  return ordinals.get(text);
}

// ---------------------------------------------------------------------------
// Delimited text (CSV / TSV)
// ---------------------------------------------------------------------------

// RFC4180-ish reader. Fields may be quoted, a doubled quote inside a quoted
// field is a literal quote, and a newline inside quotes belongs to the field.
// The delimiter itself is structure, never a value — which is what "commas and
// tabs are ignored" means, and is also why a quoted "1,234" survives to reach
// parseLenientNumber as one field.
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let hadContent = false;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    // Ignore the trailing empty line every text file ends with, but keep
    // genuinely blank rows in the middle of the data.
    if (!(row.length === 1 && row[0] === '' && !hadContent)) rows.push(row);
    row = [];
    hadContent = false;
  };

  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      hadContent = true;
      continue;
    }
    if (ch === '"') { quoted = true; hadContent = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === '\n') { endRow(); continue; }
    field += ch;
    if (ch.trim() !== '') hadContent = true;
  }
  if (field !== '' || row.length > 0 || hadContent) endRow();
  return rows;
}

// A first row is a header when every one of its cells is non-numeric and there
// is data underneath it. Predictable beats clever here: the alternative rules
// all misfire on some real file, and a performer can see the labels the UI
// picked and re-save the file if the guess was wrong.
//
// The consequence, documented rather than worked around: an all-text file with
// no header loses its first row to labels.
export function looksLikeHeader(rows) {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (!first.length) return false;
  return first.every((cell) => {
    const text = String(cell ?? '').trim();
    return text !== '' && parseLenientNumber(text) === null;
  });
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

// Depth-first flatten of an array/object value into a single dimension. Keys
// are dropped — the spec asks for the VALUES to be extracted into a pattern —
// and the walk stops at `limit` so a huge nested blob cannot blow the cap.
// Returns { values, rawValues, truncated }, `rawValues` being the pre-cast
// leaves in the same order, for the column-name tooltip preview.
export function flattenValues(value, limit, ordinals) {
  const values = [];
  const rawValues = [];
  let truncated = false;

  const walk = (node) => {
    if (values.length >= limit) { truncated = true; return; }
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (node && typeof node === 'object') { for (const v of Object.values(node)) walk(v); return; }
    rawValues.push(node);
    values.push(castValue(node, ordinals));
  };

  walk(value);
  if (values.length > limit) { values.length = limit; rawValues.length = limit; truncated = true; }
  return { values, rawValues, truncated };
}

// ---------------------------------------------------------------------------
// Pack naming
// ---------------------------------------------------------------------------

// A pack is named after its file, sanitized to something referenceable:
// "Weather 2024.csv" → "Weather_2024". Leading digits get an underscore so the
// name can never be mistaken for a number in a reference.
export function packNameFromFilename(filename) {
  const base = String(filename ?? '').split('/').pop();
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned) return 'data';
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

// Packs and audio banks share one namespace, because a reference cannot say
// which it meant. A collision gets a numeric suffix rather than overwriting.
export function uniquePackName(base, taken) {
  const names = taken instanceof Set ? taken : new Set(taken ?? []);
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!names.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Parsing a whole file
// ---------------------------------------------------------------------------

// Apply the per-pack caps to a list of {label, values} samples, keeping heads
// and dropping tails. Returns the capped list plus what was cut, so the UI can
// say so instead of quietly serving a shortened pattern.
function applyPackCaps(samples, budget) {
  const notes = { droppedSamples: 0, truncatedSamples: 0 };
  let kept = samples;
  if (kept.length > MAX_SAMPLES_PER_PACK) {
    notes.droppedSamples = kept.length - MAX_SAMPLES_PER_PACK;
    kept = kept.slice(0, MAX_SAMPLES_PER_PACK);
  }

  let remaining = Math.min(MAX_VALUES_PER_PACK, budget ?? MAX_VALUES_PER_PACK);
  const out = [];
  for (const sample of kept) {
    const limit = Math.min(MAX_VALUES_PER_SAMPLE, remaining);
    if (limit <= 0) { notes.droppedSamples++; continue; }
    const values = sample.values.length > limit ? sample.values.slice(0, limit) : sample.values;
    const truncated = sample.truncated || values.length < sample.values.length;
    if (truncated) notes.truncatedSamples++;
    remaining -= values.length;
    out.push({ label: sample.label, values, truncated, preview: sample.preview });
  }
  return { samples: out, ...notes };
}

function samplesFromRows(rows) {
  const header = looksLikeHeader(rows) ? rows[0] : null;
  const body = header ? rows.slice(1) : rows;
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);

  const samples = [];
  for (let col = 0; col < width; col++) {
    const ordinals = new Map();
    const label = header?.[col]?.trim() || `column ${col + 1}`;
    const rawValues = body.map((row) => row[col]);
    const values = rawValues.map((cell) => castValue(cell, ordinals));
    samples.push({ label, values, truncated: false, preview: buildPreview(rawValues, values) });
  }
  return samples;
}

function samplesFromJson(parsed, packName) {
  // An array of records is the other common JSON shape for tabular data; read
  // it column-wise so it behaves like the CSV of the same table.
  if (Array.isArray(parsed)) {
    const records = parsed.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
    if (records.length === parsed.length && records.length > 0) {
      const keys = [];
      for (const record of records) {
        for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key);
      }
      return keys.map((key) => {
        const ordinals = new Map();
        const values = [];
        const rawValues = [];
        for (const record of records) {
          const flat = flattenValues(record[key], MAX_VALUES_PER_SAMPLE - values.length, ordinals);
          values.push(...flat.values);
          rawValues.push(...flat.rawValues);
        }
        return { label: key, values, truncated: false, preview: buildPreview(rawValues, values) };
      });
    }
    // A plain array of scalars is one sample under the pack's own name.
    const ordinals = new Map();
    const flat = flattenValues(parsed, MAX_VALUES_PER_SAMPLE, ordinals);
    return [{
      label: packName, values: flat.values, truncated: flat.truncated,
      preview: buildPreview(flat.rawValues, flat.values),
    }];
  }

  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed).map(([key, value]) => {
      const ordinals = new Map();
      const flat = flattenValues(value, MAX_VALUES_PER_SAMPLE, ordinals);
      return {
        label: key, values: flat.values, truncated: flat.truncated,
        preview: buildPreview(flat.rawValues, flat.values),
      };
    });
  }

  // A bare scalar document: one sample, one value.
  const ordinals = new Map();
  const cast = castValue(parsed, ordinals);
  return [{ label: packName, values: [cast], truncated: false, preview: buildPreview([parsed], [cast]) }];
}

/**
 * Parse an uploaded file into a pack.
 *
 * Returns { name, kind, samples: [{label, values, truncated, preview}],
 * droppedSamples, truncatedSamples }, or throws if the file cannot be read as
 * its extension. `preview` is a short "raw → cast" string for the column-name
 * tooltip — see buildPreview.
 * `budget` is the browser-wide value allowance left for this pack.
 */
export function parseDataFile(filename, text, { budget = MAX_VALUES_TOTAL, taken } = {}) {
  const kind = extensionOf(filename);
  const name = uniquePackName(packNameFromFilename(filename), taken);

  let samples;
  if (kind === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`${filename}: not valid JSON — ${e.message}`);
    }
    samples = samplesFromJson(parsed, name);
  } else if (kind === 'csv' || kind === 'tsv') {
    const rows = parseDelimited(text, kind === 'tsv' ? '\t' : ',');
    if (!rows.length) throw new Error(`${filename}: no rows`);
    samples = samplesFromRows(rows);
  } else {
    throw new Error(`${filename}: not a JSON, CSV or TSV file`);
  }

  samples = samples.filter((s) => s.values.length > 0);
  if (!samples.length) throw new Error(`${filename}: no values found`);

  const capped = applyPackCaps(samples, budget);
  return { name, kind, ...capped };
}
