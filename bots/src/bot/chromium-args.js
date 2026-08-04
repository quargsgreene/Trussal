/**
 * Chromium launch configuration.
 *
 * The first four flags are verbatim spec requirements. The rest:
 *  - use-fake-device-for-media-stream: spec — lets WebRTC accept our injected
 *    canvas stream without a physical camera.
 *  - use-fake-ui-for-media-stream: auto-grants getUserMedia, satisfying the
 *    "disable media permission prompts" constraint (headless has no UI to
 *    click).
 *  - autoplay-policy: Strudel's AudioContext must start without a user
 *    gesture.
 *  - window-size matches the Xvfb screen so Hydra renders at the size Jitsi
 *    streams.
 */

// A function that optionally takes a width/height object to represent the width and height of the Chromium window, and returns an array of Chromium launch arguments.
export function chromiumArgs({ width = 1280, height = 720 } = {}) {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // Self-hosted Jitsi on a LAN serves a self-signed cert, and WebRTC
    // (navigator.mediaDevices) only exists in secure contexts — so bots must
    // use HTTPS and tolerate the cert. Bots only ever visit the configured
    // Jitsi URL, so the reduced TLS validation is contained.
    '--ignore-certificate-errors',
    `--window-size=${width},${height}`,
    '--disable-notifications',
  ];
}

/**
 * Puppeteer launch options for the bot's Chromium. Shared by the runtime bot
 * (bot.js) and the build-time launch smoke test (docker/verify-launch.mjs), so
 * the guard always exercises the exact config production uses.
 *
 * Debian ships a ROLLING Chromium (150+ as of 2026-07). Puppeteer's stock
 * default-arg set + pipe transport make that Chromium abort instantly at
 * startup ("Failed to launch the browser process: Code: null"), so the bot
 * would spawn and immediately die without ever joining. Supplying ONLY our own
 * args (ignoreDefaultArgs: true) over a WS port (pipe: false) launches it
 * reliably; ignoreDefaultArgs also drops --mute-audio (the bot needs audio) and
 * puppeteer's temp-profile flag, so userDataDir is explicit.
 *
 * headless:false because Xvfb is already up per bot — non-headless X11 audio
 * falls through to ALSA (loopback → JACK → Jamulus); headless:'new' would route
 * Web Audio to a null sink. extraArgs lets the build smoke test add
 * --disable-dev-shm-usage for the constrained 64 MB /dev/shm build environment.
 */
export function browserLaunchOptions(executablePath, { extraArgs = [], userDataDir = '/tmp/chrome-profile' } = {}) {
  return {
    headless: false,
    executablePath,
    args: [...chromiumArgs(), ...extraArgs],
    ignoreDefaultArgs: true,
    pipe: false,
    userDataDir,
    timeout: 60000,
  };
}

/**
 * UA spoofing (spec): rotate across a small pool of current real-browser UA
 * strings, deterministic per botId so reconnects look like the same client.
 * None contain "HeadlessChrome", which is the primary headless tell.
 */
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

export function spoofedUserAgent(botId) {
  return UA_POOL[botId % UA_POOL.length];
}

/**
 * Jitsi room URL with hash-config overrides — the URL fragment is Jitsi
 * Meet's supported mechanism for per-participant config without touching the
 * server:
 *  - startWithAudioMuted=false: the bot publishes audio at join. Its
 *    "microphone" is Strudel's WebAudio output (see pageAudioBridge), so
 *    Jitsi carries the music directly to listeners.
 *  - disableAP / stereo: Jitsi's mic pipeline is tuned for speech — the
 *    audio processor (AGC/AEC/noise suppression/high-pass) would gate and
 *    mangle music, and the default mono Opus would collapse the stereo
 *    field. disableAP=true sends the tap untouched; stereo=true preserves it.
 *  - prejoinConfig.enabled=false: a bot cannot click "Join meeting".
 *  - displayName: the dog-breed identity.
 *  - channelLastN / resolution / startBitrate: bandwidth guards for a
 *    self-hosted bridge — bots send, never watch, so they receive no
 *    remote streams and send capped video.
 */
export function jitsiRoomUrl(baseUrl, displayName, {
  channelLastN = 0,
  videoHeight = 360,
  startBitrateKbps = 800,
  // Joining with video unmuted makes Jitsi request a camera, which the gUM
  // override answers with a canvas — so it may only be false for a bot that
  // HAS one at document-start, or the join hangs waiting. Regular bots have
  // their Hydra canvas; the aggregator has the mosaic's output canvas.
  videoMuted = false,
} = {}) {
  const params = [
    'config.startWithAudioMuted=false',
    'config.disableAP=true',
    'config.stereo=true',
    'config.prejoinConfig.enabled=false',
    `config.startWithVideoMuted=${videoMuted}`,
    `config.channelLastN=${channelLastN}`,
    `config.startBitrate=${startBitrateKbps}`,
    `config.constraints.video.height.ideal=${videoHeight}`,
    `config.constraints.video.height.max=${videoHeight}`,
    `userInfo.displayName="${encodeURIComponent(displayName)}"`,
  ];
  return `${baseUrl}#${params.join('&')}`;
}
