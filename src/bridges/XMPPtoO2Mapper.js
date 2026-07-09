// Maps Jitsi/XMPP identities to O2 service names and back.
//
// O2 addresses are service-rooted (`/perf/<roomIndex>/...`), while Jitsi
// speaks in opaque endpoint ids (JID resources). The room index assigned by
// the latency sidecar (see latency-instrument/room-indices.js) is the stable
// pivot: this module keeps the jitsiId ↔ roomIndex ↔ service-name bijection
// current as peers join and leave. Pure module — testable under node:test.
// not sure if this is necessary

const SERVICE_PREFIX = '/perf/';

export function serviceNameForIndex(roomIndex) {
  if (roomIndex == null || !/^\d+[a-z]*$/.test(String(roomIndex))) return null;
  return `${SERVICE_PREFIX}${roomIndex}`;
}

export function indexForServiceName(serviceName) {
  if (typeof serviceName !== 'string' || !serviceName.startsWith(SERVICE_PREFIX)) return null;
  // Accept both the bare service name and a full address under it.
  const rest = serviceName.slice(SERVICE_PREFIX.length);
  const idx = rest.split('/')[0];
  return /^\d+[a-z]*$/.test(idx) ? idx : null;
}

export class XMPPtoO2Mapper {
  constructor() {
    this._indexByJitsiId = new Map();
    this._jitsiIdByIndex = new Map();
  }

  register(jitsiId, roomIndex) {
    if (!jitsiId || roomIndex == null) return false;
    const idx = String(roomIndex);
    if (!/^\d+[a-z]*$/.test(idx)) return false;
    // Re-registering the same pair is a no-op; a changed mapping evicts the
    // old entries on both sides to keep the bijection intact.
    const prevIdx = this._indexByJitsiId.get(jitsiId);
    if (prevIdx !== undefined && prevIdx !== idx) this._jitsiIdByIndex.delete(prevIdx);
    const prevJid = this._jitsiIdByIndex.get(idx);
    if (prevJid !== undefined && prevJid !== jitsiId) this._indexByJitsiId.delete(prevJid);
    this._indexByJitsiId.set(jitsiId, idx);
    this._jitsiIdByIndex.set(idx, jitsiId);
    return true;
  }

  unregister(jitsiId) {
    const idx = this._indexByJitsiId.get(jitsiId);
    if (idx === undefined) return false;
    this._indexByJitsiId.delete(jitsiId);
    this._jitsiIdByIndex.delete(idx);
    return true;
  }

  roomIndexFor(jitsiId) {
    return this._indexByJitsiId.get(jitsiId) ?? null;
  }

  jitsiIdForIndex(roomIndex) {
    return this._jitsiIdByIndex.get(String(roomIndex)) ?? null;
  }

  serviceNameFor(jitsiId) {
    const idx = this.roomIndexFor(jitsiId);
    return idx == null ? null : serviceNameForIndex(idx);
  }

  jitsiIdForService(serviceName) {
    const idx = indexForServiceName(serviceName);
    return idx == null ? null : this.jitsiIdForIndex(idx);
  }

  size() { return this._indexByJitsiId.size; }
}

// Room-wide singleton kept in sync from the peer-state bus (wired by the
// browser entrypoint; tests construct their own instances).
export const roomMapper = new XMPPtoO2Mapper();

export function syncMapperFromPeerEvent(mapper, event, peer) {
  if (!peer) return;
  if (event === 'peer-upsert' && peer.jitsiId && peer.roomIndex != null) {
    mapper.register(peer.jitsiId, peer.roomIndex);
  } else if (event === 'peer-leave' && peer.jitsiId) {
    mapper.unregister(peer.jitsiId);
  }
}
