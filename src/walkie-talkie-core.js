// walkie-talkie-core.js — the pure half of Walkie Talkie Mode (walkie-talkie.js).
//
// No DOM, no WebRTC: just the decisions the browser module makes from the
// sidecar's walkie roster, so they can be unit-tested under node:test.

// Jitsi's own public STUN, used when the deployment's config names none. The
// walkie mesh is peer to peer and never touches the JVB.
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:meet-jit-si-turnrelay.jitsi.net:443' }];

// Which side of a pair sends the offer. Exactly one of the two must, or both
// offer at once (glare) and neither connection settles; comparing the
// sidecar-assigned peerIds gives both browsers the same answer with no extra
// round trip.
export function isOfferer(myPeerId, theirPeerId) {
  return String(myPeerId) < String(theirPeerId);
}

// The jitsiIds whose Jitsi tiles and audio this browser hides: every walkie
// participant — unless we are one too, in which case the main meeting is
// silenced wholesale instead and nobody's tile needs hiding.
export function walkieAwayJitsiIds(roster, { localWalkie = false, myPeerId = null } = {}) {
  if (localWalkie) return [];
  return (roster || [])
    .filter((p) => p && p.jitsiId && p.peerId !== myPeerId)
    .map((p) => p.jitsiId);
}

// The other walkie peers this browser should be connected to right now.
export function walkiePartners(roster, myPeerId) {
  return (roster || []).filter((p) => p && p.peerId && p.peerId !== myPeerId);
}

// Which connections to open and close to match `partners`, given the peerIds
// of the connections already open.
export function diffConnections(openPeerIds, partners) {
  const open = new Set(openPeerIds || []);
  const wanted = new Set((partners || []).map((p) => p.peerId));
  return {
    add: [...wanted].filter((id) => !open.has(id)),
    remove: [...open].filter((id) => !wanted.has(id)),
  };
}

// ICE servers from the deployment's Jitsi config (config.p2p.stunServers is
// what Jitsi's own P2P connection uses), falling back to DEFAULT_ICE_SERVERS.
export function iceServersFrom(config) {
  const servers = config && config.p2p && config.p2p.stunServers;
  return Array.isArray(servers) && servers.length ? servers : DEFAULT_ICE_SERVERS;
}

// A label for a walkie tile: the display name, else the room index, else a
// generic fallback.
export function walkieLabel(peer) {
  if (!peer) return 'Participant';
  if (typeof peer.displayName === 'string' && peer.displayName.trim()) return peer.displayName.trim();
  if (peer.roomIndex != null) return `Participant ${peer.roomIndex}`;
  return 'Participant';
}
