// permissions-config.js — the `permissionsConfig(...)` declaration a
// participant writes in their own personal editor to say what other
// participants may do with them:
//
//   permissionsConfig({ allowInhabitFrom: "all", allowClipping: true })   // the default
//   permissionsConfig({ allowInhabitFrom: ["1", "2b"] })   // only 1 and the bot 2b may inhabit me
//   permissionsConfig({ allowInhabitFrom: "none", allowClipping: false })
//
//   allowInhabitFrom  who may inhabit this participant through the
//                     Metaprogram's `# inhabit` (inhabit-core.js): "all",
//                     "none", or a list of participant tokens. Enforced by the
//                     sidecar, which drops every pair the host does not allow
//                     from the map before anyone acts on it.
//   allowClipping     whether others may clip this participant's audio and
//                     video with liveCapture('audio' | 'video', …). Enforced in
//                     the clipping browser (live-capture.js), which already
//                     receives the media to play the meeting — a modified
//                     client could ignore it, the same as it could record its
//                     own screen.
//
// A declaration like botConfig (bot-config.js), and parsed with the same
// rules: one flat object-literal argument, written anywhere in the buffer,
// stripped before Strudel sees the code (hydra-code.js's lowerPeerCode, and a
// bot's REPL — see page-scripts.js). It travels with the pattern a performer
// announces; the browser that announced it (permissions.js) also tells the
// sidecar, which shares the parsed config with the room.
//
// No declaration means the defaults. A declaration that does not parse
// changes nothing — the previous config stays in force, so a typo never
// silently opens up what was closed.
//
// Pure module: no DOM. Runs in the browser bundle, the bot image, and
// under node:test. The sidecar (CommonJS) re-validates with the same rules.

import { findDeclarationCall, stripDeclarationCall, parseObjectLiteral } from './bot-config.js';
import { isInhabitToken } from './inhabit-core.js';

export const ALL = 'all';
export const NONE = 'none';

export const PERMISSIONS_CONFIG_KEYS = ['allowInhabitFrom', 'allowClipping'];

export function defaultPermissionsConfig() {
  return { allowInhabitFrom: ALL, allowClipping: true };
}

// The call, not part of a longer name or a method on something else — the
// same rule bot-config.js's CALL_RE applies.
const CALL_RE = /(^|[^\w$.])permissionsConfig\s*\(/;

// The call as a serialisable descriptor for the bot's page scripts, which
// cannot import (see hydra-code.js's INIT_HYDRA_PATTERN). It matches the whole
// statement of a flat config — no `(` or `)` inside it — which is the only
// shape a valid declaration has.
export const PERMISSIONS_CONFIG_STATEMENT_PATTERN = {
  source: String.raw`(^|[^\w$.])permissionsConfig\s*\([^()]*\)\s*;?`,
  flags: 'g',
};

export function hasPermissionsConfig(code) {
  return findDeclarationCall(code, CALL_RE) != null;
}

export function stripPermissionsConfig(code) {
  return stripDeclarationCall(code, CALL_RE);
}

function propertyError(key, value) {
  if (key === 'allowInhabitFrom') {
    if (value === ALL || value === NONE) return null;
    if (Array.isArray(value)) {
      const bad = value.find((t) => !isInhabitToken(String(t).trim()));
      return bad === undefined ? null
        : `allowInhabitFrom: '${bad}' is not a participant token (0, 1, 2b, …)`;
    }
    return 'allowInhabitFrom must be "all", "none", or a list of participant tokens, e.g. ["1", "2b"]';
  }
  if (key === 'allowClipping') {
    return typeof value === 'boolean' ? null : 'allowClipping must be true or false';
  }
  return `${key} is not a known property (expected one of: ${PERMISSIONS_CONFIG_KEYS.join(', ')})`;
}

// A raw object → a complete config (absent properties take their defaults),
// or the first thing wrong with it.
export function validatePermissionsConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'permissionsConfig takes a single object argument' };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) continue;
    const error = propertyError(key, value);
    if (error) return { ok: false, error };
  }
  const config = defaultPermissionsConfig();
  if (raw.allowInhabitFrom != null) {
    config.allowInhabitFrom = Array.isArray(raw.allowInhabitFrom)
      ? [...new Set(raw.allowInhabitFrom.map((t) => String(t).trim()))]
      : raw.allowInhabitFrom;
  }
  if (raw.allowClipping != null) config.allowClipping = raw.allowClipping;
  return { ok: true, config };
}

// A whole editor buffer → { ok, present, config } or { ok: false, error }.
export function parsePermissionsConfig(code) {
  const found = findDeclarationCall(code, CALL_RE);
  if (!found) return { ok: true, present: false, config: defaultPermissionsConfig() };
  if (found.unbalanced) return { ok: false, present: true, error: 'permissionsConfig: unclosed "("' };
  const parsed = parseObjectLiteral(found.argText);
  if (!parsed.ok) return { ok: false, present: true, error: `permissionsConfig: ${parsed.error}` };
  const valid = validatePermissionsConfig(parsed.value);
  if (!valid.ok) return { ok: false, present: true, error: `permissionsConfig: ${valid.error}` };
  return { ok: true, present: true, config: valid.config };
}

// A config from the wire (another browser, via the sidecar) → a complete one.
// Anything malformed reads as the default, never as a throw.
export function sanitizePermissionsConfig(raw) {
  const valid = raw && typeof raw === 'object' ? validatePermissionsConfig(raw) : null;
  return valid && valid.ok ? valid.config : defaultPermissionsConfig();
}

// May `guestToken` inhabit a participant whose config is `config`?
export function allowsInhabitFrom(config, guestToken) {
  const from = (config || defaultPermissionsConfig()).allowInhabitFrom;
  if (from === ALL || from == null) return true;
  if (from === NONE) return false;
  return Array.isArray(from) && from.includes(String(guestToken));
}

// May others clip this participant's audio and video?
export function allowsClipping(config) {
  return (config || defaultPermissionsConfig()).allowClipping !== false;
}

export function permissionsConfigsEqual(a, b) {
  return JSON.stringify(a || defaultPermissionsConfig()) === JSON.stringify(b || defaultPermissionsConfig());
}
