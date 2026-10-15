// meeting-adapter.js — the single, swappable seam between Trussal and the
// underlying meeting implementation.
//
// Today the meeting implementation is the Jitsi Meet web app, whose `APP`
// singleton exposes a `conference` we poll for roster data (see
// participants.js). Tomorrow it will be a direct lib-jitsi-meet conference
// object. Everything else in the bundle (participants.js, studio.js, the
// latency/analytics code) should talk to *this* module and never reach for
// `window.APP` directly, so that swapping the backend is a localised change
// in this file rather than a hunt through the whole tree.
//
// The interface is deliberately tiny and read-only: Trussal's audio/UI layers
// only need to know who is in the room and whether the local peer has joined.
// Track publishing, mute, and video overrides remain gUM/app concerns and are
// deliberately left to their own modules (published-video.js etc.).

// Return the Jitsi Meet Redux store when available, or null. Many UI-facing
// features (reactions, chat-entry, panel-bg) only use it to dispatch a kept
// set of actions such as `OPEN_CHAT`; callers should degrade to no-ops.
export function getStore() {
  try {
    if (typeof window === 'undefined') return null;
    const app = window.APP;
    return app && app.store ? app.store : null;
  } catch (e) {
    console.warn('[meeting-adapter] operation failed', e);
    return null;
  }
}

// Return the active conference object, or null when none is joined / not yet
// initialised. Under the current backend this is `window.APP.conference`;
// under lib-jitsi-meet it will be the conference returned by
// `connection.createConference(...)`.
export function getConference() {
  try {
    if (typeof window === 'undefined') return null;
    const app = window.APP;
    return app && app.conference ? app.conference : null;
  } catch (e) {
    console.warn('[meeting-adapter] getConference failed', e);
    return null;
  }
}

// Read the local participant in a normalised { id, displayName, isLocal } shape,
// or null when not joined. Returns null (rather than throwing) for every
// transient/missing state so callers can keep polling.
export function readLocal() {
  try {
    const conf = getConference();
    if (!conf || typeof conf.getMyUserId !== 'function') return null;
    const id = conf.getMyUserId();
    if (!id) return null;

    let displayName = null;
    if (typeof conf.getLocalDisplayName === 'function') {
      try { displayName = conf.getLocalDisplayName(); } catch (e) { console.warn('[meeting-adapter] reading local display name failed', e); }
    }
    if (!displayName) {
      const store = getStore();
      if (store && typeof store.getState === 'function') {
        try {
          const st = store.getState();
          const s = st && st['features/base/settings'];
          if (s && typeof s.displayName === 'string') displayName = s.displayName;
        } catch (e) { console.warn('[meeting-adapter] reading local display name failed', e); }
      }
    }
    return { id, displayName: displayName || 'You', isLocal: true };
  } catch (e) {
    console.warn('[meeting-adapter] operation failed', e);
    return null;
  }
}

// Read remote participants as a Map<id, { id, displayName, isLocal:false }>.
// Hidden/virtual participants are filtered just as the roster layer requires.
export function readRemotes() {
  const map = new Map();
  try {
    const conf = getConference();
    if (!conf) return map;
    const localId = typeof conf.getMyUserId === 'function' ? conf.getMyUserId() : null;
    const members = typeof conf.listMembers === 'function' ? conf.listMembers() : [];
    for (const m of members) {
      const id = typeof m.getId === 'function' ? m.getId() : m._id;
      if (!id) continue;
      if (localId && id === localId) continue;
      try { if (typeof m.isHidden === 'function' && m.isHidden()) continue; } catch (e) { console.warn('[meeting-adapter] reading remote participant failed', e); }
      let displayName = null;
      try { displayName = typeof m.getDisplayName === 'function' ? m.getDisplayName() : m._displayName; } catch (e) { console.warn('[meeting-adapter] reading remote participant failed', e); }
      map.set(id, { id, displayName: displayName || 'Participant', isLocal: false });
    }
  } catch (e) { console.warn('[meeting-adapter] readRemotes failed', e); }
  return map;
}

// Best-effort joined check, mirroring the check used to gate Trussal's UI.
export function isJoined() {
  try {
    const conf = getConference();
    if (!conf) return false;
    if (typeof conf.isJoined === 'function') return conf.isJoined();
    if (conf._room && typeof conf._room.isJoined === 'function') return conf._room.isJoined();
    return false;
  } catch (e) {
    console.warn('[meeting-adapter] isJoined failed', e);
    return false;
  }
}

// Escape hatch for the long tail of code that has not yet been ported and still
// needs the raw conference object (published-video tag resolution, NetStats,
// bots). New code should prefer getConference() over `window.APP.conference`.
export function getRawConference() {
  return getConference();
}
