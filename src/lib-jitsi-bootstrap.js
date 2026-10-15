// lib-jitsi-bootstrap.js — connect to a Jitsi deployment with lib-jitsi-meet
// and inject the resulting conference into meeting-adapter.js so the rest of
// Trussal treats it as "the meeting". The Jitsi web app shell may host the page,
// but its own client must never join a conference: this bootstrap is the only
// path into a meeting, for humans, bots and the aggregator alike.
//
// There is deliberately no opt-out flag. Dropping one backend for another is
// now the whole point — a flag that let the Jitsi web app join *in addition*
// produced two presences for one client (the bot double-join).
//
// The roster (participants.js), the local microphone and video publication
// (published-audio.js and published-video.js's ensureVideoPublished) and remote
// media consumption (remote-tracks.js) all run through backend-neutral seams,
// so the adapter below can serve a bare lib-jitsi-meet conference.
//
// The prejoin is handled here too: Trussal renders its own (prejoin.js) and the
// conference starts on its Join, carrying the display name it collected —
// rather than connecting at page load and bypassing the Join step. Bots and the
// aggregator must join unattended, so they skip the prejoin and carry the name
// the meeting URL already specifies (the `userInfo.displayName` fragment).
//
// On a page that does not already ship the library (a standalone deployment
// with no Jitsi web app), the bundle is loaded on demand by lib-jitsi-loader.js
// before connecting.

import { setConference, clearConference } from './meeting-adapter.js';
import { ensureLibJitsi } from './lib-jitsi-loader.js';
import { resetRemoteTracks } from './remote-tracks.js';
import { ensureAudioPublishedWhenReady } from './published-audio.js';
import { getRoomNameFromUrl } from './get-room-name-from-url.js';
import { renderPrejoin } from './prejoin.js';
import { normaliseDisplayName, shouldOwnPrejoin } from './prejoin-core.js';

// The display name a Jitsi meeting URL carries in its fragment
// (`userInfo.displayName`, e.g. a bot's dog-breed identity). lib-jitsi-meet
// parses no URL of its own, so without this a bot — which skips the prejoin and
// never collects a name — would join with no name at all. Trussal's prejoin
// supplies the name directly for humans, which takes precedence over this.
//
// Jitsi writes the value quoted (`userInfo.displayName="Bloodhound"`); the
// surrounding quotes are delimiters, not part of the name.
export function displayNameFromUrl() {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    const hash = String(window.location.hash || '').replace(/^#/, '');
    if (!hash) return '';
    const raw = new URLSearchParams(hash).get('userInfo.displayName');
    if (!raw) return '';
    return normaliseDisplayName(raw.replace(/^"(.*)"$/, '$1'));
  } catch (e) {
    return '';
  }
}

export function getLibJitsi() {
  try {
    if (typeof window === 'undefined') return null;
    return window.JitsiMeetJS || null;
  } catch (e) {
    return null;
  }
}

function resolveConfig(overrides = {}) {
  const cfg = (typeof window !== 'undefined' && window.config) ? window.config : {};
  const hosts = (cfg && cfg.hosts) ? cfg.hosts : {};
  // The room lives in the URL PATH (`/<room>`), the same source studio.js and
  // peer-state.js read via getRoomNameFromUrl(). Joining a different room than
  // the sidecar/studio do would split the roster in two, so prefer the path
  // over a hash or a config.roomName that this deployment does not set.
  let urlRoom = null;
  try { urlRoom = getRoomNameFromUrl(); } catch (e) { /* no window.location — leave null */ }
  return {
    domain: overrides.domain || hosts.domain || (typeof window !== 'undefined' ? window.location.hostname : ''),
    muc: overrides.muc || hosts.muc || ('conference.' + (hosts.domain || (typeof window !== 'undefined' ? window.location.hostname : ''))),
    focus: overrides.focus || hosts.focus || ('focus.' + (hosts.domain || (typeof window !== 'undefined' ? window.location.hostname : ''))),
    room: overrides.room || cfg.roomName || urlRoom || (typeof window !== 'undefined' ? (window.location.hash || '').replace(/^#/, '') || cfg.room : '') || '',
    serviceUrl: overrides.serviceUrl || cfg.serviceUrl || null,
    bosh: overrides.bosh || cfg.bosh || null,
  };
}

export async function connectLibJitsiConference(overrides = {}) {
  const JitsiMeetJS = getLibJitsi() || await ensureLibJitsi();
  if (!JitsiMeetJS) {
    console.warn('[lib-jitsi-bootstrap] window.JitsiMeetJS not available and could not be loaded');
    return null;
  }
  const cfg = resolveConfig(overrides);
  if (!cfg.domain || !cfg.room) {
    console.error('[lib-jitsi-bootstrap] missing domain/room; cannot connect', cfg);
    return null;
  }

  // An explicitly supplied name (the prejoin's, even if blank) wins; otherwise
  // fall back to the name the meeting URL already specifies (bots/aggregator).
  const displayName = normaliseDisplayName(
    overrides.displayName !== undefined ? overrides.displayName : displayNameFromUrl()
  );

  let connection = null;
  let conference = null;
  try {
    try { JitsiMeetJS.init?.({}); } catch (e) { console.warn('[lib-jitsi-bootstrap] JitsiMeetJS.init failed (non-fatal)', e); }

    const options = {
      hosts: { domain: cfg.domain, muc: cfg.muc, focus: cfg.focus },
    };
    if (cfg.serviceUrl) options.serviceUrl = cfg.serviceUrl;
    if (cfg.bosh) options.bosh = cfg.bosh;

    connection = new JitsiMeetJS.JitsiConnection(null, null, options);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CONNECTION_TIMEOUT')), 15000);
      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => {
        clearTimeout(timeout);
        resolve();
      });
      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, (err) => {
        clearTimeout(timeout);
        reject(err || new Error('CONNECTION_FAILED'));
      });
      connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED, () => {
        clearTimeout(timeout);
        reject(new Error('CONNECTION_DISCONNECTED'));
      });
      connection.connect();
    });

    // Mirror the web bundle's startWithVideoMuted() default: lib-jitsi-meet
    // would otherwise create and publish a camera track at join, and the
    // raw camera must never reach the wire. Publication is explicit —
    // published-video.js's ensureVideoPublished().
    const startWithVideoMuted = !!(typeof window !== 'undefined'
      && window.config && window.config.startWithVideoMuted);
    const startWithAudioMuted = !!(typeof window !== 'undefined'
      && window.config && window.config.startWithAudioMuted);

    conference = connection.initJitsiConference(cfg.room, {
      openBridgeChannel: true,
      startWithVideoMuted,
    });
    conference.addEventListener?.(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => {
      resetRemoteTracks(); // drop any cache from a previous conference
      setConference(conference);
      // The display name travels as the MUC presence nick, so it has to be set
      // once the room is actually joined (setDisplayName sends presence). An
      // empty name is simply left unset; the roster then shows its own default.
      if (displayName && typeof conference.setDisplayName === 'function') {
        try { conference.setDisplayName(displayName); }
        catch (e) { console.warn('[lib-jitsi-bootstrap] could not set the display name', e); }
      }
      // A bare lib-jitsi-meet conference creates no tracks, so publish the mic
      // through the backend-neutral seam (joining unmuted) unless the
      // deployment asked to start muted.
      if (!startWithAudioMuted) {
        ensureAudioPublishedWhenReady({ conference })
          .then((ok) => { if (!ok) console.warn('[lib-jitsi-bootstrap] could not publish the microphone'); })
          .catch((e) => console.warn('[lib-jitsi-bootstrap] publishing the microphone failed', e));
      }
      console.log('[lib-jitsi-bootstrap] conference joined', cfg.domain, cfg.room);
    });
    conference.addEventListener?.(JitsiMeetJS.events.conference.CONFERENCE_LEFT, () => {
      clearConference();
      resetRemoteTracks();
    });
    conference.join();
    return conference;
  } catch (e) {
    console.error('[lib-jitsi-bootstrap] connect failed', e);
    try { connection && connection.disconnect?.(); } catch (err) { console.warn('[lib-jitsi-bootstrap] disconnect failed', err); }
    clearConference();
    resetRemoteTracks();
    return null;
  }
}

export function disconnectLibJitsiConference() {
  clearConference();
}

// Start a conference for this page. Trussal's own prejoin (prejoin.js) collects
// the display name and the conference starts on the user's Join — the
// equivalent of the Jitsi web app's prejoin step. On the welcome page no room
// is resolvable yet (a room is chosen there and the browser then navigates to
// /<room>), so there is nothing to join and we do nothing. Bots and the
// aggregator must join unattended and skip the prejoin entirely.
export async function maybeBootstrapLibJitsi({ renderPrejoinFn = renderPrejoin } = {}) {
  const w = (typeof window !== 'undefined') ? window : {};
  const isBot = !!w.__trussalIsBot;
  const isAggregator = !!w.__trussalIsAggregator;
  if (!shouldOwnPrejoin({ isBot, isAggregator })) {
    return connectLibJitsiConference();
  }

  const cfg = resolveConfig();
  if (!cfg.domain || !cfg.room) return null;

  let displayName = '';
  try { displayName = await renderPrejoinFn({ room: cfg.room }); }
  catch (e) { console.warn('[lib-jitsi-bootstrap] prejoin failed; joining without a display name', e); }
  return connectLibJitsiConference({ displayName });
}