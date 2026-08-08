// bot-config.js — the one rule for what counts as a `botConfig(...)` declaration
// in a performer's editor, and what its argument is allowed to say.
//
// One rule, three consumers, mirroring hydra-code.js. The browser strips the
// call before Strudel ever sees the block; the studio reads the parsed config
// to send alongside a spawn request; the fleet re-parses the same text to build
// each bot's script. Keeping the rule here is what stops those three from
// disagreeing about whether a block declares a config at all — they run in
// three different processes and never compare notes.
//
// The rule: a `botConfig(` call at a statement position, with one optional
// object-literal argument. It is a declaration, not a pattern, so — unlike
// `await initHydra(` — it may sit anywhere in the block and is removed from the
// code before evaluation.
//
// Why the argument is parsed here rather than with JSON.parse or eval: the text
// is written by hand in a live-coding editor, so it carries JS object-literal
// habits JSON rejects (bare keys, single quotes, trailing commas), and it is
// untrusted enough that eval is not an option. The value space is a flat object
// of scalars, so a small parser covers it exactly and predictably.
//
// Double quotes are safe *inside* the call for the same reason the call is
// stripped: it never reaches Strudel's transpiler, whose double-quote plugin
// would otherwise mini-parse `"make it spooky"` into a syntax error that kills
// the whole room's program.

// Every property, its accepted type, and its accepted values. `null` — the
// value of any property the author leaves out — always means "no effect on the
// bots' code", so a bare `botConfig()` is a config of all nulls: each bot plays
// exactly what its human is playing.
export const BOT_CONFIG_PROPS = {
  random: { type: 'string', values: ['params', 'full'] },
  paramFactor: { type: 'number' },
  harmony: { type: 'string', pattern: /^(diatonic|random|[+-]\d+)$/ },
  mcp: { type: 'string' },
  colorScheme: {
    type: 'string',
    values: [
      'complementary', 'monochromatic', 'analogous', 'triadic',
      'tetradic', 'split-complementary', 'square', 'random',
    ],
  },
  textParrot: { type: 'boolean' },
  cssParrot: { type: 'boolean' },
  retroactive: { type: 'boolean' },
  samples: { type: 'boolean' },
};

export const BOT_CONFIG_KEYS = Object.keys(BOT_CONFIG_PROPS);

// A config with every property at its default. Callers compare against this
// rather than testing for undefined, so "absent" and "explicitly null" are the
// same state everywhere downstream.
export function defaultBotConfig() {
  const out = {};
  for (const key of BOT_CONFIG_KEYS) out[key] = null;
  return out;
}

// `botConfig` as a call, not as part of a longer name (`myBotConfig(`) and not
// as a method on something else (`x.botConfig(`). Both would be someone else's
// symbol, and silently claiming them would strip code we don't own.
const CALL_RE = /(^|[^\w$.])botConfig\s*\(/;

export function hasBotConfig(code) {
  return findBotConfigCall(code) != null;
}

// Locate the call and its argument text by balancing parentheses from the
// opening one. String literals are skipped so a `)` inside an mcp prompt does
// not end the argument early.
export function findBotConfigCall(code) {
  const src = String(code ?? '');
  const match = CALL_RE.exec(src);
  if (!match) return null;

  const start = match.index + match[1].length;
  const open = src.indexOf('(', start);
  let depth = 0;
  let quote = null;

  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        // Swallow a trailing semicolon so stripping doesn't leave one behind.
        let end = i + 1;
        if (src[end] === ';') end++;
        return { start, end, argText: src.slice(open + 1, i).trim(), unbalanced: false };
      }
    }
  }
  // Unbalanced. The argument text still comes back so a caller can show it, but
  // the flag is what parseBotConfig reports on: the text after an unclosed "("
  // often parses cleanly on its own, and accepting it would apply a config the
  // author never finished writing.
  return { start, end: src.length, argText: src.slice(open + 1).trim(), unbalanced: true };
}

// Editor text with the declaration removed. Everything else — including the
// blank-line structure Hydra's preamble split depends on — is preserved, so
// this is safe to run before splitHydraCode.
export function stripBotConfig(code) {
  const found = findBotConfigCall(code);
  if (!found) return String(code ?? '');
  const src = String(code ?? '');
  const before = src.slice(0, found.start);
  const after = src.slice(found.end);
  // A declaration alone on its line leaves an empty line behind, which would
  // read as a Hydra preamble boundary. Collapse only that case.
  if (/(^|\n)[ \t]*$/.test(before) && /^[ \t]*(\n|$)/.test(after)) {
    return before.replace(/[ \t]*$/, '') + after.replace(/^[ \t]*\n?/, '');
  }
  return before + after;
}

// --- Argument parsing -------------------------------------------------------

// A flat object of scalars: `{ key: value, ... }`. Bare or quoted keys, single
// or double quoted strings, numbers, booleans, null, and a trailing comma.
export function parseObjectLiteral(text) {
  const src = String(text ?? '').trim();
  if (src === '') return { ok: true, value: {} };

  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const fail = (msg) => ({ ok: false, error: `${msg} at position ${i}` });

  ws();
  if (src[i] !== '{') return fail('expected "{"');
  i++;

  const out = {};
  ws();
  if (src[i] === '}') return i === src.length - 1 ? { ok: true, value: out } : fail('trailing text after "}"');

  while (i < src.length) {
    ws();

    // Key: bare identifier or quoted string.
    let key;
    if (src[i] === '"' || src[i] === "'") {
      const str = readString();
      if (!str.ok) return str;
      key = str.value;
    } else {
      const start = i;
      while (i < src.length && /[\w$]/.test(src[i])) i++;
      if (i === start) return fail('expected a property name');
      key = src.slice(start, i);
    }

    ws();
    if (src[i] !== ':') return fail(`expected ":" after "${key}"`);
    i++;
    ws();

    const value = readValue();
    if (!value.ok) return value;
    out[key] = value.value;

    ws();
    if (src[i] === ',') { i++; ws(); if (src[i] === '}') { i++; break; } continue; }
    if (src[i] === '}') { i++; break; }
    return fail('expected "," or "}"');
  }

  ws();
  if (i < src.length) return fail('trailing text after "}"');
  return { ok: true, value: out };

  function readString() {
    const quote = src[i];
    i++;
    let str = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') {
        i++;
        const esc = src[i];
        str += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
      } else {
        str += src[i];
      }
      i++;
    }
    if (i >= src.length) return fail('unterminated string');
    i++;
    return { ok: true, value: str };
  }

  function readValue() {
    if (src[i] === '"' || src[i] === "'") return readString();
    const start = i;
    while (i < src.length && !/[,}\s]/.test(src[i])) i++;
    const word = src.slice(start, i);
    if (word === '') return fail('expected a value');
    if (word === 'true') return { ok: true, value: true };
    if (word === 'false') return { ok: true, value: false };
    if (word === 'null') return { ok: true, value: null };
    const num = Number(word);
    if (word !== '' && Number.isFinite(num)) return { ok: true, value: num };
    return { ok: false, error: `unquoted value "${word}" at position ${start}` };
  }
}

// Check one property against BOT_CONFIG_PROPS. Returns null when it passes.
function propertyError(key, value) {
  const spec = BOT_CONFIG_PROPS[key];
  if (!spec) return `unknown property "${key}" (expected one of: ${BOT_CONFIG_KEYS.join(', ')})`;
  if (value === null) return null;
  if (spec.type === 'number') {
    return Number.isFinite(value) ? null : `"${key}" must be a number`;
  }
  if (spec.type === 'boolean') {
    return typeof value === 'boolean' ? null : `"${key}" must be true or false`;
  }
  if (typeof value !== 'string') return `"${key}" must be a string`;
  if (spec.values && !spec.values.includes(value)) {
    return `"${key}" must be one of: ${spec.values.join(', ')}`;
  }
  if (spec.pattern && !spec.pattern.test(value)) {
    return `"${key}" must be "diatonic", "random", or a signed semitone count like "+2" or "-13"`;
  }
  if (spec.values == null && spec.pattern == null && value.trim() === '') {
    return `"${key}" must be a non-empty string`;
  }
  return null;
}

// Validate a raw object into a complete config. Every absent property comes
// back as null, so downstream code never has to distinguish the two.
export function validateBotConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'botConfig takes a single object argument' };
  }
  for (const [key, value] of Object.entries(raw)) {
    const error = propertyError(key, value);
    if (error) return { ok: false, error };
  }
  return { ok: true, config: { ...defaultBotConfig(), ...raw } };
}

// Parse a performer's whole editor block. `present` distinguishes "no
// declaration at all" from "a declaration that happens to be all defaults" —
// only the latter means the author asked for exact copies.
export function parseBotConfig(code) {
  const found = findBotConfigCall(code);
  if (!found) return { ok: true, present: false, config: defaultBotConfig() };
  if (found.unbalanced) return { ok: false, present: true, error: 'botConfig: unclosed "("' };

  const parsed = parseObjectLiteral(found.argText);
  if (!parsed.ok) return { ok: false, present: true, error: `botConfig: ${parsed.error}` };

  const valid = validateBotConfig(parsed.value);
  if (!valid.ok) return { ok: false, present: true, error: `botConfig: ${valid.error}` };

  return { ok: true, present: true, config: valid.config };
}

// --- Value readers ----------------------------------------------------------

// How `harmony` should move a bot's notes. Returns null when unset, so callers
// can skip the transform entirely rather than applying a zero-semitone shift.
export function parseHarmony(value) {
  if (value == null) return null;
  if (value === 'diatonic') return { type: 'diatonic' };
  if (value === 'random') return { type: 'random' };
  const match = /^([+-])(\d+)$/.exec(String(value));
  if (!match) return null;
  const semitones = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return { type: 'interval', semitones };
}

// `retroactive`, `textParrot` and `samples` are booleans whose unset value is
// null. Null reads as false everywhere: an unwritten property has no effect,
// and "no effect" for these three is the same as "off".
export function flag(value) {
  return value === true;
}
