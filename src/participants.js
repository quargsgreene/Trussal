// Wraps the Jitsi participant list behind a tiny pub-sub so the studio UI can
// stay in sync with who is actually in the meeting. We poll APP.conference
// because the underlying event emitter is not part of any stable surface.

const subscribers = new Set();
let local = null;
const remotes = new Map();

function emit(event, payload) {
  subscribers.forEach(fn => {
    try { fn(event, payload); } catch (e) { console.warn('[participants] subscriber threw', e); }
  });
}

function readLocal() {
  try {
    const conf = window.APP && window.APP.conference;
    if (!conf || typeof conf.getMyUserId !== 'function') return null;
    const id = conf.getMyUserId();
    if (!id) return null;

    let displayName = null;
    if (typeof conf.getLocalDisplayName === 'function') {
      try { displayName = conf.getLocalDisplayName(); } catch (e) { /* ignore */ }
    }
    if (!displayName && window.APP.store && typeof window.APP.store.getState === 'function') {
      try {
        const st = window.APP.store.getState();
        const s = st['features/base/settings'];
        if (s && typeof s.displayName === 'string') displayName = s.displayName;
      } catch (e) { /* ignore */ }
    }
    return { id, displayName: displayName || 'You', isLocal: true };
  } catch (e) { return null; }
}

function readRemotes() {
  const map = new Map();
  try {
    const conf = window.APP && window.APP.conference;
    if (!conf) return map;
    const members = typeof conf.listMembers === 'function' ? conf.listMembers() : [];
    for (const m of members) {
      const id = typeof m.getId === 'function' ? m.getId() : m._id;
      if (!id) continue;
      let displayName = null;
      try { displayName = typeof m.getDisplayName === 'function' ? m.getDisplayName() : m._displayName; } catch (e) {}
      map.set(id, { id, displayName: displayName || 'Participant', isLocal: false });
    }
  } catch (e) { /* ignore */ }
  return map;
}

function tick() {
  const newLocal = readLocal();
  if (!newLocal) return;

  if (!local || local.id !== newLocal.id) {
    local = newLocal;
    emit('local', local);
  } else if (local.displayName !== newLocal.displayName) {
    local = newLocal;
    emit('local-update', local);
  }

  const newRemotes = readRemotes();
  for (const [id, p] of newRemotes) {
    const existing = remotes.get(id);
    if (!existing) {
      remotes.set(id, p);
      emit('join', p);
    } else if (existing.displayName !== p.displayName) {
      remotes.set(id, p);
      emit('update', p);
    }
  }
  for (const id of Array.from(remotes.keys())) {
    if (!newRemotes.has(id)) {
      const left = remotes.get(id);
      remotes.delete(id);
      emit('leave', left);
    }
  }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(tick, 1000);
  tick();
}

export function subscribeParticipants(fn) {
  subscribers.add(fn);
  if (local) fn('local', local);
  for (const r of remotes.values()) fn('join', r);
  return () => subscribers.delete(fn);
}

export function getLocalParticipant() { return local; }
export function getRemoteParticipants() { return Array.from(remotes.values()); }

// Jitsi tags remote `<audio>` elements with an id that embeds the participant
// id. The exact prefix has shifted across versions, so try a few shapes.
export function getParticipantIdForAudioTag(tag) {
  if (!tag || !tag.id) return null;
  if (tag.id === 'userAudio') return null;
  const patterns = [
    /^remoteAudio_(.+)$/,
    /^audio_(.+)$/,
    /^(.+)_audio$/
  ];
  for (const re of patterns) {
    const m = tag.id.match(re);
    if (m) return m[1];
  }
  return null;
}

startPolling();
