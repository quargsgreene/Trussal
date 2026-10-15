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
// (remote-tracks.js) already run through backend-neutral seams; screen-share,
// prejoin and bots are subsequent migration steps. The point here is to
// exercise the seam end to end against a real lib-jitsi-meet conference and
// prove the adapter can serve one.
//
// On a page that does not already ship the library (a standalone deployment
// with no Jitsi web app), the bundle is loaded on demand by lib-jitsi-loader.js
// before connecting.

import { setConference, clearConference } from './meeting-adapter.js';
import { ensureLibJitsi } from './lib-jitsi-loader.js';
import { resetRemoteTracks } from './remote-tracks.js';
import { ensureAudioPublishedWhenReady } from './published-audio.js';

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
  return {
    domain: overrides.domain || hosts.domain || (typeof window !== 'undefined' ? window.location.hostname : ''),
    muc: overrides.muc || hosts.muc || ('conference.' + (hosts.domain || (typeof window !== 'undefined' ? window.location.hostname : ''))),
    focus: overrides.focus || hosts.focus || ('focus.' + (hosts.domain || (typeof window !== 'undefined' ? window.location.hostname : ''))),
    room: overrides.room || (typeof window !== 'undefined' ? (cfg.roomName || (window.location.hash || '').replace(/^#/, '') || cfg.room) : ''),
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
export async function maybeBootstrapLibJitsi() {
  if (!isLibJitsiEnabled()) return null;
  return connectLibJitsiConference();
}