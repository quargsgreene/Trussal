// permissions.js — the browser half of permissionsConfig(...) (see
// permissions-config.js). Reads this participant's own declaration from the
// pattern it announces — a human's evaluated editor, a bot's running code,
// which reaches peer-state the same way — and tells the sidecar whenever it
// changes. Also answers, for the rest of this page, what another participant
// allows.
//
// Before anything has been announced (the first moments after a join), the
// saved personal-editor draft stands in: it is what studio.js seeds the first
// announcement from, so the config it declares is the one about to apply.

import { subscribePeerState, getLocalPeer, getAllPeers, sendPermissionsConfig } from './peer-state.js';
import {
  parsePermissionsConfig, defaultPermissionsConfig, permissionsConfigsEqual,
  allowsInhabitFrom, allowsClipping,
} from './permissions-config.js';

const LOCAL_IS_AGGREGATOR = !!(typeof window !== 'undefined' && window.__trussalIsAggregator);
// studio.js's STORAGE_KEY: the saved personal-editor draft.
const DRAFT_KEY = 'trussal.studio.pattern';

let current = null;    // the config in force for this participant
let lastPattern = null;
let lastError = null;

function savedDraft() {
  try { return globalThis.localStorage?.getItem(DRAFT_KEY) || null; } catch (e) { return null; }
}

// Read `code`'s declaration. A declaration that does not parse leaves the
// config as it was, so a typo never re-opens what was closed.
function adopt(code) {
  const parsed = parsePermissionsConfig(code);
  if (!parsed.ok) {
    if (parsed.error !== lastError) console.error(`[permissions] ${parsed.error} — your previous permissions still apply`);
    lastError = parsed.error;
    return;
  }
  lastError = null;
  if (current && permissionsConfigsEqual(current, parsed.config)) return;
  current = parsed.config;
  sendPermissionsConfig(current);
}

// This participant's own config, as in force.
export function getLocalPermissionsConfig() {
  return current || defaultPermissionsConfig();
}

// The error in this participant's declaration, or null — studio.js shows it.
export function getPermissionsConfigError() {
  return lastError;
}

// What the participant holding `token` (or `peer`) allows.
function configOf(peer) {
  if (!peer) return defaultPermissionsConfig();
  if (peer === getLocalPeer()) return getLocalPermissionsConfig();
  return peer.permissionsConfig || defaultPermissionsConfig();
}

export function peerAllowsClipping(peer) {
  return allowsClipping(configOf(peer));
}

export function mayInhabitMe(guestToken) {
  return allowsInhabitFrom(getLocalPermissionsConfig(), guestToken);
}

export function tokenAllowsInhabitFrom(hostToken, guestToken) {
  const host = getAllPeers().find((p) => p.roomIndex != null && String(p.roomIndex) === String(hostToken));
  return allowsInhabitFrom(configOf(host), guestToken);
}

if (!LOCAL_IS_AGGREGATOR) {
  const draft = savedDraft();
  if (draft) adopt(draft);
  subscribePeerState((event, payload) => {
    if (event !== 'peer-upsert' || payload !== getLocalPeer()) return;
    const pattern = typeof payload.pattern === 'string' ? payload.pattern : null;
    if (pattern == null || pattern === lastPattern) return;
    lastPattern = pattern;
    adopt(pattern);
  });
}
