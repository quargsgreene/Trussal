/**
 * Master-script validation.
 *
 * Why `new Function` instead of a parser dependency (acorn/esprima): we only
 * need a syntax check — the code never runs here. V8's own parser via the
 * Function constructor is the exact grammar the bot's Chromium will use, with
 * zero install weight. Wrapping in `async () => {}` makes top-level `await
 * initHydra()` parseable. The constructed function is never invoked, so this
 * is parse-only, not eval.
 */

export function validateCode(code) {
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, error: 'code must be a non-empty string' };
  }
  try {
    // Parse-only: the function is constructed (parsed) and discarded.
    new Function(`"use strict"; return (async () => {\n${code}\n});`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}` };
  }
}

/**
 * JSON contract for a user-provided master script (spec): an object with
 * `strudel` and `hydra` string fields, hydra starting with `await
 * initHydra(`, plus optional `text` and `css` string fields (a bot's own
 * word()/css() voice — see cluster-source.js's botScriptFor). Returns
 * { ok, error? } rather than throwing so the config API can surface the
 * message straight to the admin page.
 */
export function validateMasterScript(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'master script must be a JSON object' };
  }
  for (const field of ['strudel', 'hydra']) {
    if (typeof obj[field] !== 'string' || obj[field].trim() === '') {
      return { ok: false, error: `"${field}" must be a non-empty string` };
    }
  }
  for (const field of ['text', 'css']) {
    if (field in obj && typeof obj[field] !== 'string') {
      return { ok: false, error: `"${field}" must be a string` };
    }
  }
  if (!obj.hydra.trimStart().startsWith('await initHydra(')) {
    return { ok: false, error: 'hydra code must start with `await initHydra(` (spec requirement)' };
  }
  const unknown = Object.keys(obj).filter((k) => !['strudel', 'hydra', 'text', 'css'].includes(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown fields: ${unknown.join(', ')}` };
  }
  for (const field of ['strudel', 'hydra']) {
    const res = validateCode(obj[field]);
    if (!res.ok) return { ok: false, error: `${field}: ${res.error}` };
  }
  for (const field of ['text', 'css']) {
    if (obj[field] && obj[field].trim() !== '') {
      const res = validateCode(obj[field]);
      if (!res.ok) return { ok: false, error: `${field}: ${res.error}` };
    }
  }
  return { ok: true };
}
