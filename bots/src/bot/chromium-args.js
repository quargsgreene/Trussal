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
} = {}) {
  const params = [
    'config.startWithAudioMuted=false',
    'config.disableAP=true',
    'config.stereo=true',
    'config.prejoinConfig.enabled=false',
    'config.startWithVideoMuted=false',
    `config.channelLastN=${channelLastN}`,
    `config.startBitrate=${startBitrateKbps}`,
    `config.constraints.video.height.ideal=${videoHeight}`,
    `config.constraints.video.height.max=${videoHeight}`,
    `userInfo.displayName="${encodeURIComponent(displayName)}"`,
  ];
  return `${baseUrl}#${params.join('&')}`;
}
