// meeting-adapter.js — the single, swappable seam between Trussal and the
// underlying meeting implementation.
//
// The meeting implementation is a direct lib-jitsi-meet conference object,
// created by lib-jitsi-bootstrap.js and handed in via setConference(). The Jitsi
// Meet web app may still be hosting the page, but its `APP.conference` is no
// longer consulted: `participants.js` and everything else talk to *this* module
// and never reach for `window.APP` directly, so the backend stays a localised
// change in this file rather than a hunt through the whole tree.
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

// The one conference handle the rest of Trussal should treat as "the meeting".
// Only ever the conference lib-jitsi-bootstrap.js injects: nothing else joins a
// meeting, so there is no second conference to fall back to.
let injectedConference = null;

export function setConference(conf) {
  try {
    injectedConference = conf || null;
    return injectedConference;
  } catch (e) {
    console.warn('[meeting-adapter] setConference failed', e);
    return null;
  }
}

export function clearConference() {
  injectedConference = null;
}

export function hasInjectedConference() {
  return !!injectedConference;
}

// Return the active conference object, or null when none is joined / not yet
// initialised. This is the conference lib-jitsi-bootstrap.js injected; there is
// no other backend to read from.
export function getConference() {
  try {
    if (injectedConference) return injectedConference;
    if (typeof window === 'undefined') return null;
    return null;
  } catch (e) {
    console.warn('[meeting-adapter] getConference failed', e);
    return null;
  }
}

// The underlying lib-jitsi-meet JitsiConference for the active meeting (the
// conference injected via setConference). It exposes the authoritative
// participant model.
function getRoomFor(conf) {
  if (!conf) return null;
  return conf._room || conf;
}

// The object that owns the conference's track/participant API. Prefer `_room`
// if a wrapper parked the JitsiConference there; otherwise the conference
// itself (a bare JitsiConference IS that object, and its own `.room` is its
// XMPP room — no addTrack/getLocalTrack API — so it must never be chosen over
// the conference). Capability-checked. Mirrors published-video.js's roomFor()
// so the bundle and the bot page scripts agree on "the room".
export function getMeetingRoom(conf = null) {
  try {
    const c = conf || getConference();
    if (!c) return null;
    const hasTrackApi = (o) => !!o && (typeof o.addTrack === 'function' || typeof o.removeTrack === 'function');
    if (hasTrackApi(c._room)) return c._room;
    if (hasTrackApi(c)) return c;
    if (hasTrackApi(c.room)) return c.room;
    return c._room || c || null;
  } catch (e) {
    console.warn('[meeting-adapter] getMeetingRoom failed', e);
    return null;
  }
}

// Our own endpoint id. A wrapper exposes getMyUserId(); a bare JitsiConference
// exposes myUserId().
function getLocalUserIdFrom(conf) {
  try {
    if (conf && typeof conf.getMyUserId === 'function') return conf.getMyUserId();
    const room = getRoomFor(conf);
    if (room && typeof room.myUserId === 'function') return room.myUserId();
  } catch (e) { console.warn('[meeting-adapter] reading local user id failed', e); }
  return null;
}

// The remote member objects, from whichever backend is active. Prefer the web
// wrapper's listMembers() when present (it filters for display), otherwise fall
// back to the lib-jitsi JitsiConference's getParticipants(). Both return
// JitsiParticipant-shaped objects.
function listRemoteMembers(conf) {
  if (!conf) return [];
  try {
    if (typeof conf.listMembers === 'function') return conf.listMembers() || [];
  } catch (e) { console.warn('[meeting-adapter] listMembers failed', e); }
  try {
    const room = getRoomFor(conf);
    if (room && typeof room.getParticipants === 'function') return room.getParticipants() || [];
  } catch (e) { console.warn('[meeting-adapter] getParticipants failed', e); }
  return [];
}

// Read the local participant in a normalised { id, displayName, isLocal } shape,
// or null when not joined. Returns null (rather than throwing) for every
// transient/missing state so callers can keep polling.
export function readLocal() {
  try {
    const conf = getConference();
    if (!conf) return null;
    const id = getLocalUserIdFrom(conf);
    if (!id) return null;

    let displayName = null;
    if (typeof conf.getLocalDisplayName === 'function') {
      try { displayName = conf.getLocalDisplayName(); } catch (e) { console.warn('[meeting-adapter] reading local display name failed', e); }
    }
    if (!displayName) {
      const room = getRoomFor(conf);
      try {
        const me = room && typeof room.getParticipantById === 'function' ? room.getParticipantById(id) : null;
        if (me && typeof me.getDisplayName === 'function') displayName = me.getDisplayName();
      } catch (e) { console.warn('[meeting-adapter] reading local display name failed', e); }
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
    const localId = getLocalUserIdFrom(conf);
    const members = listRemoteMembers(conf);
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

// Read remote participants' live media tracks straight from the conference
// model, as a Map<id, { audio: MediaStreamTrack[], video: MediaStreamTrack[] }>.
// Local and hidden participants are excluded, matching readRemotes().
//
// This is the backend-neutral replacement for scraping Jitsi's injected
// <audio>/<video> elements. The Jitsi web app hangs each remote stream off such
// an element; a bare lib-jitsi-meet conference injects none, so consumers that
// want remote media must read participant.getTracks() instead. Its element ids
// are generic in this deployment (see participants.js), so callers get the same
// tracks here either way.
export function readRemoteTracks() {
  const map = new Map();
  try {
    const conf = getConference();
    const room = getRoomFor(conf);
    if (!room || typeof room.getParticipants !== 'function') return map;
    const localId = getLocalUserIdFrom(conf);
    for (const p of room.getParticipants()) {
      const id = typeof p.getId === 'function' ? p.getId() : (p && p._id);
      if (!id) continue;
      if (localId && id === localId) continue;
      try { if (typeof p.isHidden === 'function' && p.isHidden()) continue; } catch (e) { console.warn('[meeting-adapter] reading remote tracks failed', e); continue; }
      const audio = [];
      const video = [];
      let tracks = [];
      try { tracks = typeof p.getTracks === 'function' ? (p.getTracks() || []) : []; } catch (e) {
        console.warn('[meeting-adapter] reading remote tracks failed', e);
        continue;
      }
      for (const t of tracks) {
        let kind = null;
        try { kind = typeof t.getType === 'function' ? t.getType() : null; } catch (e) { /* fall through to predicates */ }
        if (kind !== 'audio' && kind !== 'video') {
          if (typeof t.isVideoTrack === 'function' && t.isVideoTrack()) kind = 'video';
          else if (typeof t.isAudioTrack === 'function' && t.isAudioTrack()) kind = 'audio';
        }
        const mediaStreamTrack = typeof t.getTrack === 'function' ? t.getTrack() : (t && t.track) || null;
        if (!mediaStreamTrack || !kind) continue;
        (kind === 'video' ? video : audio).push(mediaStreamTrack);
      }
      map.set(id, { audio, video });
    }
  } catch (e) { console.warn('[meeting-adapter] readRemoteTracks failed', e); }
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

// Whether the local user is in the meeting. The injected lib-jitsi-meet
// conference is the sole authority: it reports joined via isJoined(). A page
// with no conference — the welcome screen or the prejoin — is not in a meeting.
// This is the backend-neutral replacement for the old scattered
// `document.getElementById('largeVideoContainer')` checks (studio.js,
// on-screen-keyboard.js, facial-gesture.js): with the Jitsi web app shell gone,
// there is no large-video element and no premeeting-screen DOM to consult.
export function isInMeeting() {
  try {
    const conf = getConference();
    if (!conf) return false;
    if (typeof conf.isJoined === 'function' && conf.isJoined()) return true;
    if (conf._room && typeof conf._room.isJoined === 'function' && conf._room.isJoined()) return true;
    return false;
  } catch (e) {
    console.warn('[meeting-adapter] isInMeeting: conference check failed', e);
    return false;
  }
}

// The raw conference object for the long tail of code that still needs it
// (published-video tag resolution, NetStats, bots). Identical to
// getConference(); new code should prefer that name.
export function getRawConference() {
  return getConference();
}

// Give participants an event-driven trigger layer. The conference lib-jitsi-
// bootstrap.js injects is an EventEmitter over `JitsiMeetJS.events.conference`;
// we attach the caller's `handler` to every known membership/track event so the
// roster can refresh promptly instead of waiting for the next poll. Returns a
// teardown or null when no event surface is available, in which case callers
// keep polling.
export function subscribeConferenceEvents(conf, handler) {
  try {
    if (typeof handler !== 'function') return null;
    const target = conf && (conf._room || conf);
    if (!target) return null;

    const JitsiMeetJS = (typeof window !== 'undefined' && window.JitsiMeetJS) ? window.JitsiMeetJS : null;
    let names = [];
    try {
      const ev = JitsiMeetJS && JitsiMeetJS.events && JitsiMeetJS.events.conference;
      if (ev && typeof ev === 'object') names = Object.values(ev);
    } catch (e) { /* ignore */ }
    // Cover the common lib-jitsi-meet event names even without the global.
    if (!names.length) {
      names = [
        'conference.joined',
        'conference.left',
        'participant.joined',
        'participant.left',
        'display.name.changed',
        'track.added',
        'track.removed',
      ];
    }

    const disposers = [];
    for (const name of names) {
      if (typeof target.on !== 'function') break;
      try {
        const cb = () => { try { handler(name); } catch (e) { console.warn('[meeting-adapter] roster event handler threw', e); } };
        target.on(name, cb);
        disposers.push(() => { try { if (typeof target.off === 'function') target.off(name, cb); } catch (e) { /* ignore */ } });
      } catch (e) {
        console.warn('[meeting-adapter] subscribeConferenceEvents: on(' + name + ') failed', e);
      }
    }
    if (!disposers.length) return null;
    return () => { for (const d of disposers) { try { d(); } catch (e) {} } };
  } catch (e) {
    console.warn('[meeting-adapter] subscribeConferenceEvents failed', e);
    return null;
  }
}
