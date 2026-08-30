// Instrument whitelist validation for AI-composed Strudel patterns.
//
// Claude doesn't inherently know which synths this Strudel instance has
// loaded, so instrument_defs.json strictly types the inputs: every name
// referenced via s("…") / sound("…") / bank("…") must be listed (exact
// match or an allowed prefix like gm_). Mini-notation inside the string is
// tolerated — we extract word-like tokens and ignore rests, operators,
// numbers, and :n sample selectors.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadInstrumentDefs(path) {
  const url = path || new URL('./tools/instrument_defs.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(url instanceof URL ? fileURLToPath(url) : url, 'utf8'));
  return {
    instruments: new Set(parsed.instruments || []),
    prefixes: parsed.prefixes || []
  };
}

// Extract instrument name candidates from a Strudel pattern.
export function extractInstrumentNames(code) {
  const names = new Set();
  const re = /\b(?:s|sound|bank)\s*\(\s*(["'`])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(code || '')) !== null) {
    for (const raw of m[2].split(/[\s<>[\]{}(),|]+/)) {
      if (!raw) continue;
      const token = raw.split(':')[0].replace(/[*!/@?~_-]+\d*$/g, '').replace(/^[*!/@?]+/, '');
      // Pure numbers, rests, and operators aren't instrument names.
      if (!token || /^[\d.]+$/.test(token) || token === '~' || token === '-' || token === '_') continue;
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) names.add(token);
    }
  }
  return [...names];
}

export function validateInstruments(code, defs) {
  const found = extractInstrumentNames(code);
  const unknown = found.filter(name =>
    !defs.instruments.has(name) && !defs.prefixes.some(p => name.startsWith(p)));
  return { ok: unknown.length === 0, found, unknown };
}
