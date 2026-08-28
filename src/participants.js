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
    const localId = typeof conf.getMyUserId === 'function' ? conf.getMyUserId() : null;
    const members = typeof conf.listMembers === 'function' ? conf.listMembers() : [];
    for (const m of members) {
      const id = typeof m.getId === 'function' ? m.getId() : m._id;
      if (!id) continue;
      if (localId && id === localId) continue;
      // Skip hidden participants (Jicofo, SMACKS ghost sessions, virtual sources).
      try { if (typeof m.isHidden === 'function' && m.isHidden()) continue; } catch (e) {}
      let displayName = null;
      try { displayName = typeof m.getDisplayName === 'function' ? m.getDisplayName() : m._displayName; } catch (e) {}
      map.set(id, { id, displayName: displayName || 'Participant', isLocal: false });
    }
  } catch (e) { /* ignore */ }
  return map;
}

function tick() {
  const newLocal = readLocal();
  if (!newLocal) {
    // We were in a conference and now read as absent (APP.conference torn
    // down or getMyUserId() gone null): a genuine local departure, e.g. an
    // in-app hangup that leaves the tab open on a post-call/welcome screen
    // rather than closing or reloading it. Reset so a same-tab rejoin is
    // treated as a fresh 'local' join (below) instead of silently ignored.
    if (local) {
      const left = local;
      local = null;
      emit('local-leave', left);
    }
    return;
  }

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

// Resolve the owner of a remote audio tag by TRACK IDENTITY: match the tag's
// srcObject audio track ids against each remote participant's audio
// JitsiTracks in lib-jitsi-meet (the authoritative participant/track model —
// a remote audio track's owner IS the endpoint id). This deployment labels
// remote audio tags with GENERIC ids (remoteAudio_remote-audio-N) that do not
// embed the endpoint id, so the id-parsing fallback below "matches" but
// returns a token no roster knows; the tag is then never routed into a
// per-peer chain and plays natively at full volume — which is exactly how
// peers stayed audible OUTSIDE the aggregator's master (duplicated audio),
// and why aggregator-mode solo muting looked flaky. Same redesign as the
// aggregator bot's capture tap (commit be2e94a), client-side.
function ownerIdForAudioSrcObject(srcObject) {
  try {
    if (!srcObject || typeof srcObject.getAudioTracks !== 'function') return null;
    const tagTrackIds = new Set(srcObject.getAudioTracks().map((t) => t.id));
    if (!tagTrackIds.size) return null;
    const conf = window.APP && window.APP.conference;
    const room = conf && conf._room; // lib-jitsi-meet JitsiConference (underscore-convention, reachable)
    if (!room || typeof room.getParticipants !== 'function') return null;
    const match = room.getParticipants()
      .flatMap((participant) => (typeof participant.getTracks === 'function' ? participant.getTracks() : [])
        .filter((track) => typeof track.getType !== 'function' || track.getType() === 'audio')
        .map((track) => ({
          participant,
          mediaStreamTrack: typeof track.getTrack === 'function' ? track.getTrack() : null,
        })))
      .find(({ mediaStreamTrack }) => mediaStreamTrack && tagTrackIds.has(mediaStreamTrack.id));
    return match ? match.participant.getId() : null;
  } catch (e) {
    // Resolution failing must not wedge the caller's tag scan; the element-id
    // fallback still runs. Log it — a persistent failure means the
    // lib-jitsi-meet API shape changed and tags are back to native playback.
    console.warn('[participants] track-identity tag resolution failed', e);
    return null;
  }
}

// Jitsi tags remote `<audio>` elements with an id that (in some versions)
// embeds the participant id. Track identity is authoritative and tried first;
// the id patterns remain as fallback for layouts whose ids do embed it.
export function getParticipantIdForAudioTag(tag) {
  if (!tag) return null;
  if (tag.id === 'userAudio') return null; // local mic, never a remote owner
  const byTrack = ownerIdForAudioSrcObject(tag.srcObject);
  if (byTrack) return byTrack;
  if (!tag.id) return null;
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
