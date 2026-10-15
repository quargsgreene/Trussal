// lib-jitsi-bootstrap.js — Step 2 of the migration: connect to a Jitsi
// deployment with lib-jitsi-meet (no Jitsi web app involved) and inject the
// resulting conference into meeting-adapter.js so the rest of Trussal treats it
// as "the meeting".
//
// This is OFF by default. Enable it with either `window.__TRUSSAL_USE_LIB_JITSI
// = true` before the bundle runs, or `?libjitsi=1` in the page URL. With it
// off, behaviour is byte-identical to today's build (getConference() keeps
// reading window.APP.conference).
//
// This module only SCAFFOLDS the connection. The roster (participants.js), the
// local microphone and video publication (published-audio.js and
// published-video.js's ensureVideoPublished) and remote media consumption
// (remote-tracks.js) already run through backend-neutral seams; screen-share
// and bots are subsequent migration steps. The point here is to exercise the
// seam end to end against a real lib-jitsi-meet conference and prove the
// adapter can serve one.
//
// The prejoin is handled here too: under this backend there is no Jitsi web
// app, so Trussal renders its own prejoin (prejoin.js) and the conference
// starts on its Join, carrying the display name it collected — rather than
// connecting at page load and bypassing the Join step.
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

export function isLibJitsiEnabled() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.__TRUSSAL_USE_LIB_JITSI === true) return true;
    try {
      const params = new URLSearchParams(window.location && window.location.search ? window.location.search : '');
      if (params.get('libjitsi') === '1' || params.get('libJitsi') === '1') return true;
    } catch (e) { /* ignore */ }
    return false;
  } catch (e) {
    console.warn('[lib-jitsi-bootstrap] isLibJitsiEnabled failed', e);
    return false;
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
    console.warn('[lib-jitsi-bootstrap] window.JitsiMeetJS not available and could not be loaded; falling back to APP conference');
    return null;
  }
  const cfg = resolveConfig(overrides);
  if (!cfg.domain || !cfg.room) {
    console.error('[lib-jitsi-bootstrap] missing domain/room; cannot connect', cfg);
    return null;
  }

  const displayName = normaliseDisplayName(overrides.displayName);

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
      // Parity with the Jitsi web app, which publishes the microphone itself at
      // join (unmuted by default). A bare lib-jitsi-meet conference creates no
      // tracks, so publish the mic through the backend-neutral seam unless the
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

// Only attempt a bootstrap when explicitly enabled. Returning false preserves
// the current deployment behaviour.
//
// With the flag on, the display name is collected through Trussal's own prejoin
// (prejoin.js) and the conference starts on the user's Join — the backend's
// equivalent of the Jitsi web app's prejoin step. On the welcome page no room is
// resolvable yet (a room is chosen there and the browser then navigates to
// /<room>), so there is nothing to join and we do nothing. Bots and the
// aggregator must join unattended and skip the prejoin entirely.
export async function maybeBootstrapLibJitsi({ renderPrejoinFn = renderPrejoin } = {}) {
  const enabled = isLibJitsiEnabled();
  if (!enabled) return null;

  const w = (typeof window !== 'undefined') ? window : {};
  const isBot = !!w.__trussalIsBot;
  const isAggregator = !!w.__trussalIsAggregator;
  if (!shouldOwnPrejoin({ libJitsiEnabled: enabled, isBot, isAggregator })) {
    return connectLibJitsiConference();
  }

  const cfg = resolveConfig();
  if (!cfg.domain || !cfg.room) return null;

  let displayName = '';
  try { displayName = await renderPrejoinFn({ room: cfg.room }); }
  catch (e) { console.warn('[lib-jitsi-bootstrap] prejoin failed; joining without a display name', e); }
  return connectLibJitsiConference({ displayName });
}