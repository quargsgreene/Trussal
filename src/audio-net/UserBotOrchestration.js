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
  subscribePeerState
} from '../peer-state.js';

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
export function spawnBots(count) {
  const n = Math.max(1, Math.floor(count) || 1);
  sendFleetRequest('spawn', { count: n });
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
