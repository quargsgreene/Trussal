// Music-mode config guard.
//
// The instrument-audio settings live in Jitsi's config.js, generated on the
// web container from env vars (see docker-jitsi-meet/env.example, the "Trussal:
// music / instrument audio mode" block). custom-config.js can't *set* them — by
// the time this bundle loads, lib-jitsi-meet has already read `config` and
// applied the mic constraints. So instead we VERIFY them at load and warn
// loudly if a stale/speech-mode config.js is being served. Otherwise a missed
// redeploy fails silently: instruments quietly mangled by AEC/AGC/NS, collapsed
// to mono, at a low speech bitrate, with no error anywhere.

// Each check maps a config.js key (set from an env var) to the env var that
// drives it, so the warning tells the operator exactly what to change.
const EXPECTED = [
  {
    ok: (c) => c.disableAP === true,
    key: 'config.disableAP === true',
    env: 'ENABLE_AUDIO_PROCESSING=false',
    why: 'echo cancellation / noise suppression / AGC mangle instruments',
  },
  {
    ok: (c) => !!c.audioQuality && c.audioQuality.stereo === true,
    key: 'config.audioQuality.stereo === true',
    env: 'ENABLE_STEREO=true',
    why: 'mono collapses stereo instrument feeds',
  },
  {
    ok: (c) => !!c.audioQuality && Number(c.audioQuality.opusMaxAverageBitrate) >= 256000,
    key: 'config.audioQuality.opusMaxAverageBitrate >= 256000',
    env: 'AUDIO_QUALITY_OPUS_BITRATE=510000',
    why: 'default speech bitrate is too low for music',
  },
  {
    ok: (c) => c.enableNoAudioDetection === false,
    key: 'config.enableNoAudioDetection === false',
    env: 'ENABLE_NO_AUDIO_DETECTION=false',
    why: 'false "is your mic working?" prompts on quiet instruments',
  },
  {
    ok: (c) => c.enableNoisyMicDetection === false,
    key: 'config.enableNoisyMicDetection === false',
    env: 'ENABLE_NOISY_MIC_DETECTION=false',
    why: 'flags instruments as a "noisy" microphone',
  },
];

function runCheck() {
  const c = window.config;
  if (!c || typeof c !== 'object') return false; // config.js not populated yet
  const failures = EXPECTED.filter(e => {
    try { return !e.ok(c); } catch (_) { return true; }
  });
  if (!failures.length) {
    console.info('[trussal] music-mode audio config OK');
    return true;
  }
  console.warn(
    '[trussal] Jitsi is NOT in music/instrument mode — config.js looks stale or unset.\n' +
    'Instruments will be degraded (speech DSP, mono, low bitrate). Set these in\n' +
    'docker-jitsi-meet/.env and recreate the web container:\n' +
    failures.map(f => `  • ${f.env}  (${f.why})\n      missing: ${f.key}`).join('\n')
  );
  return true;
}

export function renderAudioConfigCheck() {
  // Expose for manual re-check from the browser console.
  window.trussalAudioConfigCheck = runCheck;
  // config.js normally loads before this bundle, but retry briefly in case the
  // global isn't populated yet on this page.
  let tries = 0;
  const tick = () => {
    if (runCheck()) return;
    if (++tries > 10) {
      console.warn('[trussal] audio config guard: window.config never appeared');
      return;
    }
    setTimeout(tick, 500);
  };
  tick();
}
