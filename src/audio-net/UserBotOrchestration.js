// Per-user bot cluster orchestration (browser side).
//
// Users spawn/focus/mute/remove bots in their *own* cluster and grant or
// revoke metaprogram-edit and modulation-write permissions. Spawn/remove go
// through the fleet service (fleet-request over the sidecar); mute rides the
// existing remote-control path; permissions ride bot-permission. Selection
// helpers are pure so conditional focus ("every other bot", "index > 1c")
// stays unit-testable.

import {
  getAllPeers,
  getLocalPeer,
  sendFleetRequest,
  sendRemoteMute,
  sendRemoteVideo,
  sendBotPermission,
  sendSampleFile,
  subscribePeerState
} from '../peer-state.js';
import { flag, parseBotConfig } from '../bot-config.js';
import { readSampleBanks } from '../user-samples.js';

// --- Pure selection helpers -----------------------------------------------------

// All bots in `peers` belonging to ownerIndex, sorted by cluster ordinal.
export function clusterBotsOf(peers, ownerIndex) {
  if (ownerIndex == null) return [];
  const owner = String(ownerIndex);
  return (peers || [])
    .filter(p => p.isBot && typeof p.roomIndex === 'string' &&
      p.roomIndex.startsWith(owner) && /^[a-z]+$/.test(p.roomIndex.slice(owner.length)))
    .sort((a, b) => {
      const sa = a.roomIndex.slice(owner.length), sb = b.roomIndex.slice(owner.length);
      return sa.length - sb.length || (sa < sb ? -1 : sa > sb ? 1 : 0);
    });
}

// Focus a subset by explicit indices, or by condition (predicate on the peer).
export function selectBots(bots, selector) {
  if (selector === 'all' || selector == null) return bots.slice();
  if (typeof selector === 'function') return bots.filter(selector);
  if (Array.isArray(selector)) {
    const set = new Set(selector.map(String));
    return bots.filter(b => set.has(b.roomIndex));
  }
  return [];
}

// --- Cluster actions ---------------------------------------------------------------

export function myClusterBots() {
  return clusterBotsOf(getAllPeers(), getLocalPeer().roomIndex);
}

// Spawn N bots on the local user's behalf. May be interrupted by health
// measures — the fleet answers with a fleet-status carrying the reason.
//
// The local peer's code rides along: it is both the master the cluster plays
// and the carrier of the `botConfig(...)` declaration that shapes it. Sent at
// spawn and only at spawn — a bot plays what its author was playing when it
// arrived, and only a `retroactive: true` config re-captures later.
//
// `editorCode` is what the author currently has in the box, which the caller
// passes because it is NOT the same thing as `peer.pattern`: the pattern only
// advances when a block is evaluated, and a botConfig declaration is stripped
// before evaluation and makes no sound, so an author has no reason to re-run
// their block after typing one. Reading the last-evaluated pattern instead is
// what made a freshly typed config spawn a cluster of plain copies. Callers
// with no editor to read (tests, anything driving a spawn programmatically)
// omit it and get the published pattern as before.
export function spawnBots(count, editorCode) {
  const n = Math.max(1, Math.floor(count) || 1);
  const code = typeof editorCode === 'string' ? editorCode : localPerformerCode();
  const parsed = parseBotConfig(code);
  logSpawn(n, code, parsed);
  // Samples first, spawn second: the fleet builds each bot's assignment when
  // the spawn arrives, and a bank that lands after that is one the bot has
  // already been told does not exist.
  shareSamplesIfAsked(parsed)
    .catch((err) => { console.error('[trussal] sharing samples with bots failed', err); })
    .finally(() => sendFleetRequest('spawn', { count: n, code }));
}

// The first of the three prints that bracket a botConfig's journey (the sidecar
// logs the relay hop, the fleet logs what it built). A config that fails to
// parse still spawns a cluster of exact copies, and so does a stale editor
// snapshot that never carried the declaration at all — from the outside those
// are the same bots, so say which one this is at the moment we send it.
function logSpawn(count, code, parsed) {
  const what = `[trussal] spawn ${count} — sending ${code.length} chars of code`;
  if (!parsed.present) {
    console.log(`${what}, no botConfig() declared (bots play exact copies)`);
    return;
  }
  if (!parsed.ok) {
    console.warn(`${what}, botConfig REJECTED: ${parsed.error} (bots play exact copies)`);
    return;
  }
  console.log(`${what}, botConfig parsed:`, parsed.config);
}

// Ship the local performer's uploaded samples to the fleet when their config
// asks for it. Sent as base64 over the peer-state bus — the only channel a
// browser has to the bots VM — and capped fleet-side, which reports anything it
// refuses as a fleet-status the studio surfaces.
async function shareSamplesIfAsked(parsed) {
  if (!parsed.ok || !flag(parsed.config.samples)) return;

  const banks = await readSampleBanks();
  for (const { bank, name, blob } of banks) {
    const buffer = await blob.arrayBuffer();
    sendSampleFile({ bank, name, data: base64FromBuffer(buffer) });
  }
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  // Chunked so a multi-megabyte sample doesn't blow the argument limit that a
  // single String.fromCharCode(...bytes) spread would hit.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// What the local performer currently has in their editor, as the bus sees it.
// Falls back to an empty string rather than throwing: a spawn with no code is
// legal and the fleet substitutes its own master.
function localPerformerCode() {
  const local = getLocalPeer();
  return typeof local?.pattern === 'string' ? local.pattern : '';
}

// Remove a subset ('all', index array, or predicate) of one's own cluster.
export function removeBots(selector = 'all') {
  if (selector === 'all') {
    sendFleetRequest('remove', { targets: 'all' });
    return;
  }
  const targets = selectBots(myClusterBots(), selector).map(b => b.roomIndex);
  if (targets.length) sendFleetRequest('remove', { targets });
}

// Remove a single bot from one's own cluster by its room index (e.g. '1a').
// The × button on a bot row sends exactly one index in `targets` — the field
// the sidecar relays (it drops any other keys) — and the fleet matches it
// against the bot's cluster index (roomIndex === clusterIndex for bots).
export function removeOneBot(index) {
  if (index == null) return;
  sendFleetRequest('removeOne', { targets: [String(index)] });
}

// Mute/unmute audio for a subset (all-at-once or conditional).
export function muteBots(selector, muted) {
  for (const bot of selectBots(myClusterBots(), selector)) {
    sendRemoteMute(bot.peerId, !!muted);
  }
}

// Turn a subset's video tiles on or off. Bots join dark like every other
// non-aggregator participant; what appears when a tile is on is that bot's own
// Hydra output, or black when its script has none.
export function setBotsVideo(selector, videoOn) {
  for (const bot of selectBots(myClusterBots(), selector)) {
    sendRemoteVideo(bot.peerId, !!videoOn);
  }
}

// Grant/revoke metaprogram read-edit and network-modulation write permission.
export function setBotPermissions(selector, perms) {
  for (const bot of selectBots(myClusterBots(), selector)) {
    sendBotPermission(bot.peerId, perms);
  }
}

// --- Status feed ----------------------------------------------------------------------

const statusSubscribers = new Set();
subscribePeerState((event, payload) => {
  if (event !== 'fleet-status') return;
  statusSubscribers.forEach(fn => { try { fn(payload); } catch (e) {} });
});

export function subscribeFleetStatus(fn) {
  statusSubscribers.add(fn);
  return () => statusSubscribers.delete(fn);
}
