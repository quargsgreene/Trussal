import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chromiumArgs, spoofedUserAgent, jitsiRoomUrl } from '../src/bot/chromium-args.js';
import { ffmpegBedArgs } from '../src/bot/ffmpeg-bed.js';
import { jamulusArgs } from '../src/bot/jamulus.js';
import {
  pageAudioBridge, pageGumOverride, pageStrudelBoot, pageFpsSampler, pageReadSamples,
  pageEnsureAudioPublished, pageMasterPlayer,
} from '../src/bot/page-scripts.js';
import {
  noiseParams, fillNoise, normalizeRms, NOISE_RMS, NOISE_LOOP_S
} from '../../src/audio-net/av-effects/Noise.js';
import { crushParams, makeCrushCurve } from '../../src/audio-net/av-effects/Crush.js';
import { echoParams, ECHO_MAX_DELAY_S, LIMITER_THRESHOLD_DB } from '../../src/audio-net/av-effects/Echo.js';
import { Bot } from '../src/bot/bot.js';

test('chromiumArgs includes the four spec-required flags plus fake-media + no-prompt flags', () => {
  const args = chromiumArgs();
  for (const required of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream', // suppresses the media permission prompt
    '--autoplay-policy=no-user-gesture-required',
  ]) {
    assert.ok(args.includes(required), `missing ${required}`);
  }
});

test('spoofedUserAgent is deterministic per bot and looks like a real browser', () => {
  const ua0 = spoofedUserAgent(0);
  assert.equal(ua0, spoofedUserAgent(0));
  assert.match(ua0, /Mozilla\/5\.0/);
  assert.doesNotMatch(ua0, /Headless/i, 'must not leak headlessness');
  const uas = new Set(Array.from({ length: 10 }, (_, i) => spoofedUserAgent(i)));
  assert.ok(uas.size > 1, 'fleet does not share a single UA');
});

test('jitsiRoomUrl joins unmuted with music-friendly audio config and the breed display name', () => {
  const url = jitsiRoomUrl('http://localhost/0', 'Bloodhound');
  assert.ok(url.startsWith('http://localhost/0#'));
  assert.match(url, /config\.startWithAudioMuted=false/, 'bot publishes its Strudel audio at join');
  assert.match(url, /config\.disableAP=true/, 'speech audio processing would mangle music');
  assert.match(url, /config\.stereo=true/, 'preserve the stereo field for music');
  assert.match(url, /userInfo\.displayName="Bloodhound"/);
  assert.match(url, /config\.prejoinConfig\.enabled=false/, 'bots must not stop at the prejoin screen');
});

test('jitsiRoomUrl applies home-network bandwidth guards by default', () => {
  const url = jitsiRoomUrl('http://jitsi.lan/0', 'Beagle');
  assert.match(url, /config\.channelLastN=0/, 'bots receive no remote video');
  assert.match(url, /config\.constraints\.video\.height\.max=360/, 'send capped at 360p');
  assert.match(url, /config\.startBitrate=800/);
  const hd = jitsiRoomUrl('http://jitsi.lan/0', 'Beagle', { videoHeight: 720, channelLastN: 2 });
  assert.match(hd, /height\.max=720/);
  assert.match(hd, /channelLastN=2/);
});

test('ffmpegBedArgs renders the bot band as an ALSA loopback bed with staged gain', () => {
  const args = ffmpegBedArgs({ loFreq: 200, hiFreq: 400, gain: 0.22, alsaDevice: 'plughw:Loopback,0,0' });
  const cmd = args.join(' ');
  assert.match(cmd, /anoisesrc/, 'noise source band-passed to the bot band');
  assert.match(cmd, /highpass=f=200/);
  assert.match(cmd, /lowpass=f=400/);
  assert.match(cmd, /volume=0\.22/);
  assert.match(cmd, /-f alsa/);
  assert.ok(args.at(-1) === 'plughw:Loopback,0,0');
});

test('jamulusArgs connects headless to the spec server with the breed name', () => {
  const args = jamulusArgs({ server: 'trussal.duckdns.org:22000', name: 'Beagle' });
  const cmd = args.join(' ');
  assert.match(cmd, /--connect trussal\.duckdns\.org:22000/);
  assert.match(cmd, /--clientname Beagle/);
  assert.match(cmd, /--nogui/);
});

test('jamulusArgs truncates long breed names to fit JACK\'s 33-char client limit', () => {
  const args = jamulusArgs({ server: 'x:22000', name: 'Petit Basset Griffon Vendeen' });
  const clientname = args[args.indexOf('--clientname') + 1];
  assert.ok(clientname.length <= 25, `"Jamulus ${clientname}" must fit in 33 chars`);
  assert.ok('Petit Basset Griffon Vendeen'.startsWith(clientname));
});

// Page scripts are real functions Puppeteer serializes into the page; we
// assert on their serialized form, which is exactly what the page receives.
test('pageGumOverride swaps video tracks for the hydra canvas captureStream', () => {
  const js = String(pageGumOverride);
  assert.match(js, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(js, /captureStream/);
  assert.match(js, /canvas/i);
});

test('pageGumOverride publishes the Strudel audio tap as the bot microphone', () => {
  const js = String(pageGumOverride);
  assert.match(js, /__trussalMicStream/, 'audio requests resolve to the bridge tap');
});

test('pageAudioBridge fans the shared AudioContext destination to hardware and a Jitsi tap', () => {
  const js = String(pageAudioBridge);
  assert.match(js, /createMediaStreamDestination/, 'creates the Jitsi mic track source');
  assert.match(js, /window\.__trussalMicStream/, 'exposes the tap stream to the gUM override');
  assert.match(js, /Object\.defineProperty\([^)]*destination/, 'reroutes audioContext.destination');
});

test('pageAudioBridge meters the fan output so silence is diagnosable from metrics', () => {
  const js = String(pageAudioBridge);
  assert.match(js, /createAnalyser/, 'taps the fan output with an analyser');
  assert.match(js, /window\.__trussalReadFanRms/, 'exposes a read-and-reset peak-RMS reader');
  assert.match(js, /window\.__trussalHardwareMaxChannelCount/, 'snapshots the real device channel count');
});

test('pageStrudelBoot loads the REPL, takes code as a structured arg, reports eval errors', () => {
  const js = String(pageStrudelBoot);
  assert.match(js, /strudel-editor/);
  assert.match(js, /initHydra|hydra/, 'hydra code path present');
  assert.match(js, /__trussalReportError/, 'runtime eval errors must reach the conductor');
  // Pins the intent (arguments, not string-spliced source) without pinning the
  // exact field list — the boot payload also carries the owner's sample banks.
  assert.match(js, /\{\s*strudel,\s*hydra\b[^}]*\}/, 'per-bot code arrives as a parameter, not spliced source');
  assert.match(js, /__trussalSamples/, 'shared sample banks reach the page');
});

test('pageFpsSampler counts rAF frames; pageReadSamples drains errors', () => {
  assert.match(String(pageFpsSampler), /requestAnimationFrame/);
  assert.match(String(pageReadSamples), /__trussalErrors/);
});

test('pageReadSamples reports the fan audio level + channel routing in diag', () => {
  const js = String(pageReadSamples);
  assert.match(js, /fanRms/, 'surfaces whether the bot is actually audible');
  assert.match(js, /fanChannelCount/, 'surfaces the fan channel routing');
  assert.match(js, /hardwareMaxChannelCount/, 'surfaces the device channel count superdough keys off');
  assert.match(js, /directTap/, 'surfaces whether the setEffect direct tap is attached');
});

test('pageEnsureAudioPublished taps Strudel directly onto the track via setEffect', () => {
  const js = String(pageEnsureAudioPublished);
  // The publish path proven to carry Strudel audibly (NodeOutputEffect in the
  // human client): the fan connects straight into the effect's own
  // MediaStreamDestination, handed to lib-jitsi-meet through setEffect rather
  // than smuggled in as a gUM microphone.
  assert.match(js, /setEffect/, 'attaches a track effect');
  assert.match(js, /startEffect/, 'implements the jitsi effect protocol');
  assert.match(js, /stopEffect/, 'implements effect teardown');
  assert.match(js, /fan\.connect\(dest\)/, 'the effect output is the fan, connected directly');
  assert.match(js, /__trussalDirectTapEffect/, 'records the attach for idempotence + diag');
});

test('pageEnsureAudioPublished never rebinds away an effect-carrying track', () => {
  const js = String(pageEnsureAudioPublished);
  // The rebind (step 2) replaces tracks whose MediaStreamTrack isn't the gUM
  // tap; a track carrying the direct-tap effect fails that identity check by
  // design, so the rebind must also treat it as publishing-correctly or every
  // later call (the aggregator retries) would strip the effect.
  assert.match(js, /directTapLive/, 'effect-carrying track counts as publishing correctly');
  assert.match(js, /!publishingTap && !directTapLive/, 'rebind skipped while the direct tap is live');
});

// Executes pageEnsureAudioPublished outside a browser to pin the watchdog
// behavior behind the bots-spawn total-mute: a renegotiation (the P2P↔JVB flip
// when the room crosses 2→3 participants) replaces the published
// JitsiLocalTrack, the one-shot effect rides the dead old object, and the bot —
// the aggregator included — streams silence forever. The watchdog must re-attach
// the direct tap to whatever track is current, exactly once per replacement.
test('direct-tap watchdog re-attaches the effect when the published track is replaced', async (t) => {
  const savedWindow = globalThis.window;
  const savedAPP = globalThis.APP;
  const savedSetInterval = globalThis.setInterval;
  t.after(() => {
    globalThis.window = savedWindow;
    globalThis.APP = savedAPP;
    globalThis.setInterval = savedSetInterval;
  });

  const tapTrack = { id: 'tap' };
  const fanDisconnects = [];
  const makeTrack = (name) => ({
    name,
    setEffectCalls: [],
    getTrack: () => tapTrack, // publishingTap=true → step 2 rebind is skipped
    async setEffect(effect) { this.setEffectCalls.push(effect); },
  });
  const track1 = makeTrack('track1');
  const track2 = makeTrack('track2');
  let currentTrack = track1;

  globalThis.window = {
    __trussalMicStream: { getAudioTracks: () => [tapTrack] },
    __trussalFanGain: {
      context: { createMediaStreamDestination: () => ({ stream: { id: 'fanStream' } }) },
      connect() {},
      disconnect(dest) { fanDisconnects.push(dest); },
    },
    // no JitsiMeetJS: the createLocalTracks rebind path stays out of the test
  };
  globalThis.APP = {
    // no muteAudio → step 1 (and its 1.5s sleep) is skipped
    conference: { _room: { getLocalAudioTrack: () => currentTrack } },
  };
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };

  await pageEnsureAudioPublished();

  assert.equal(globalThis.window.__trussalDirectTapEffect.track, track1, 'effect attached to the joined track');
  assert.equal(track1.setEffectCalls.length, 1);
  assert.ok(globalThis.window.__trussalDirectTapWatchdog, 'watchdog installed');
  assert.equal(intervals.length, 1, 'exactly one watchdog interval');

  const tick = intervals[0].fn;
  const settle = () => new Promise((r) => setImmediate(r));

  // Healthy track: a tick must not churn the effect.
  tick(); await settle();
  assert.equal(track1.setEffectCalls.length, 1, 'no re-attach while the track is unchanged');

  // Renegotiation replaces the published track.
  currentTrack = track2;
  tick(); await settle();
  assert.equal(globalThis.window.__trussalDirectTapEffect.track, track2, 're-attached to the replacement track');
  assert.equal(track2.setEffectCalls.length, 1);
  assert.equal(fanDisconnects.length, 1, "old effect's fan connection dropped (stopEffect)");

  // Stable again: no further churn.
  tick(); await settle();
  assert.equal(track2.setEffectCalls.length, 1, 'idempotent once re-attached');

  // Idempotent install: a second pageEnsureAudioPublished call (the aggregator
  // retries it) must not stack a second watchdog.
  await pageEnsureAudioPublished();
  assert.equal(intervals.length, 1, 'watchdog installed once across repeat calls');
});

test('Bot lifecycle: launches injected browser, joins jitsi, evaluates code, reports metrics', async () => {
  const calls = { goto: [], evalOnNewDoc: [], evaluate: [], metrics: 0 };
  const fakePage = {
    evaluateOnNewDocument: async (js) => calls.evalOnNewDoc.push(String(js)),
    goto: async (url) => calls.goto.push(url),
    evaluate: async (js) => { calls.evaluate.push(String(js)); return { fps: 30 }; },
    metrics: async () => { calls.metrics++; return { JSHeapUsedSize: 100e6 }; },
    setUserAgent: async () => {},
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => { calls.closed = true; } };
  const fakeLauncher = { launch: async (opts) => { calls.launchOpts = opts; return fakeBrowser; } };

  const bot = new Bot({
    botId: 2,
    name: 'Harrier',
    jitsiUrl: 'http://localhost/0',
    script: { strudel: 's("bd")', hydra: 'await initHydra()', entryDelayMs: 0 },
  }, { launcher: fakeLauncher });

  await bot.start();
  assert.ok(calls.launchOpts.args.includes('--use-fake-device-for-media-stream'));
  assert.equal(calls.goto.length, 1);
  assert.match(calls.goto[0], /displayName="Harrier"/);
  assert.ok(calls.evalOnNewDoc.length >= 1, 'getUserMedia override installed before navigation');
  const bridgeIdx = calls.evalOnNewDoc.findIndex((s) => /__trussalMicStream\s*=/.test(s));
  const gumIdx = calls.evalOnNewDoc.findIndex((s) => /navigator\.mediaDevices\.getUserMedia\s*=/.test(s));
  assert.ok(bridgeIdx !== -1 && gumIdx !== -1, 'both audio bridge and gUM override installed');
  assert.ok(bridgeIdx < gumIdx, 'audio bridge must precede the gUM override so the mic stream exists');
  // The unmute URL flag alone doesn't reliably publish a headless track, so the
  // bot must also drive pageEnsureAudioPublished after joining.
  const ensureIdx = calls.evaluate.findIndex((s) => /muteAudio\(false\)/.test(s));
  assert.ok(ensureIdx !== -1, 'bot publishes an unmuted audio track after joining');
  // ...but does NOT publish video: a bot joins dark like every other
  // non-aggregator participant, and its owner turns the tile on from the
  // studio. The publisher is installed and waiting, not called.
  assert.match(calls.goto[0], /config\.startWithVideoMuted=true/, 'bot joins with video off');
  assert.ok(!calls.evaluate.some((s) => /__trussalEnsureVideoPublished/.test(s)),
    'bot does not publish video at startup');
  assert.ok(calls.evalOnNewDoc.some((s) => /muteVideo\(false\)/.test(s)),
    'the publisher is installed so the owner can toggle the tile on later');

  const m = await bot.sampleMetrics();
  assert.equal(typeof m.ramBytes, 'number');
  assert.equal(typeof m.fps, 'number');
  assert.equal(m.botId, 2);

  await bot.stop();
  assert.equal(calls.closed, true);
});

// The master-bus reverb is built page-side (the page-script contract forbids
// imports), so it is a hand-kept mirror of Room.js createRoomNode rather than
// a shared function. This is the copy in the audible path — every client hears
// the mix the aggregator publishes — so its graph shape is asserted directly.
test('pageMasterPlayer: master-room allpass stages are chained in series', () => {
  const edges = [];
  let id = 0;
  const mk = (kind) => {
    const node = {
      id: `${kind}#${id++}`,
      gain: { value: 0 }, delayTime: { value: 0 }, frequency: { value: 0 },
      connect(t) { edges.push([node.id, t && t.id ? t.id : 'destination']); },
      disconnect() {}
    };
    return node;
  };
  class StubCtx {
    constructor() { this.destination = { id: 'destination' }; }
    createGain() { return mk('gain'); }
    createDelay() { return mk('delay'); }
    createBiquadFilter() { return Object.assign(mk('biquad'), { type: '' }); }
    createScriptProcessor() { return Object.assign(mk('proc'), { onaudioprocess: null }); }
  }

  const savedWindow = global.window;
  global.window = { AudioContext: StubCtx };
  try {
    pageMasterPlayer();
    const player = global.window.__trussalMasterPlayer;
    player.enqueue([0, 0, 0]);            // forces ensure() -> ctx exists
    player.setRoom({
      combDelaysS: [0.0297, 0.0371, 0.0411, 0.0437],
      allpassDelaysS: [0.005, 0.0017],
      combFeedbacks: [0.5, 0.5, 0.5, 0.5],
      wetGain: 0.5,
      cutoffHz: 6000
    });

    const delays = [...new Set(edges.flat())].filter(n => n.startsWith('delay#'));
    const allpassIds = delays.slice(4); // combs are created first
    assert.equal(allpassIds.length, 2, 'two allpass stages');

    const feedersOf = (n) => edges.filter(([, to]) => to === n).map(([from]) => from);
    const sinksOf = (n) => edges.filter(([from]) => from === n).map(([, to]) => to);

    assert.ok(feedersOf(allpassIds[1]).includes(allpassIds[0]),
      'stage 2 must be fed by stage 1 (series), not tapped off the comb sum');
    const onward = sinksOf(allpassIds[0]).filter(to => !feedersOf(allpassIds[0]).includes(to));
    assert.ok(onward.length > 0, 'stage 1 output goes nowhere — dead branch');
    assert.ok(sinksOf(allpassIds[1]).some(to => to.startsWith('biquad#')),
      'the final allpass must feed the cascaded lowpass');
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
  }
});

// Recording stand-in for the page's AudioContext, with the buffer surface the
// noise bed needs on top of what the reverb uses. Node ids count up in
// creation order, which is how the tests below name the nodes an effect built.
function masterPlayerStub() {
  const edges = [];
  const byId = new Map();
  const buffers = [];
  const ramps = [];
  const state = { next: 0 };
  // AudioParam stand-in. The automation methods record what was scheduled and
  // settle .value on the ramp target, so a test reads the value an effect
  // asked for whether it was written directly (room, noise) or ramped (echo).
  const param = (owner, name) => ({
    value: 0,
    cancelScheduledValues() {},
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v, t) { ramps.push({ node: owner.id, name, value: v, at: t }); this.value = v; },
  });
  const mk = (kind) => {
    const node = {
      id: `${kind}#${state.next++}`,
      connect(t) { edges.push([node.id, t && t.id ? t.id : 'destination']); },
      disconnect() { for (let i = edges.length - 1; i >= 0; i--) if (edges[i][0] === node.id) edges.splice(i, 1); }
    };
    node.gain = param(node, 'gain');
    node.delayTime = param(node, 'delayTime');
    node.frequency = param(node, 'frequency');
    byId.set(node.id, node);
    return node;
  };
  class StubCtx {
    constructor() { this.destination = { id: 'destination' }; this.sampleRate = 48000; this.currentTime = 0; }
    createGain() { return mk('gain'); }
    createDelay(max) { return Object.assign(mk('delay'), { maxDelayTime: max }); }
    createBiquadFilter() { return Object.assign(mk('biquad'), { type: '' }); }
    createWaveShaper() { return Object.assign(mk('shaper'), { curve: null }); }
    createDynamicsCompressor() { const n = mk('comp'); n.threshold = param(n, 'threshold'); return n; }
    createScriptProcessor() { return Object.assign(mk('proc'), { onaudioprocess: null }); }
    createBuffer(channels, length) {
      const data = new Float32Array(length);
      buffers.push(data);
      return { getChannelData: () => data };
    }
    createBufferSource() { return Object.assign(mk('src'), { buffer: null, loop: false, start() {}, stop() {} }); }
  }
  return { edges, byId, buffers, ramps, state, StubCtx };
}

const ROOM_PARAMS = {
  combDelaysS: [0.0297, 0.0371, 0.0411, 0.0437],
  allpassDelaysS: [0.005, 0.0017],
  combFeedbacks: [0.5, 0.5, 0.5, 0.5],
  wetGain: 0.5,
  cutoffHz: 6000,
};

// The other half of the aggregator's master bus. Order matters audibly: the
// bed is additive and belongs ON the mix, so it must sit after the reverb
// rather than being fed through its tail.
test('pageMasterPlayer: the noise bed runs after the room on the master path', () => {
  const { edges, byId, state, StubCtx } = masterPlayerStub();
  const savedWindow = global.window;
  global.window = { AudioContext: StubCtx };
  try {
    pageMasterPlayer();
    const player = global.window.__trussalMasterPlayer;
    player.enqueue([0, 0, 0]); // forces ensure() -> ctx exists

    const proc = [...byId.keys()].find((n) => n.startsWith('proc#'));
    const busOut = edges.find(([from]) => from === proc)[1];
    const sinksOf = (n) => edges.filter(([from]) => from === n).map(([, to]) => to);
    assert.deepEqual(sinksOf(busOut), ['destination'], 'bare master bus goes straight out');

    // buildRoom/buildNoise each create their input gain first and their output
    // gain second, so the ids at the boundary name those two nodes.
    const roomAt = state.next;
    player.setRoom(ROOM_PARAMS);
    const noiseAt = state.next;
    const params = noiseParams({ wcl: 500, wcrtt: 60 }, {
      spectrum: { metric: 'wcl', factor: 1, fixed: null },
      volume: { metric: 'wcrtt', factor: 10, fixed: null },
    });
    player.setNoise(params);

    const roomIn = `gain#${roomAt}`, roomOut = `gain#${roomAt + 1}`;
    const noiseIn = `gain#${noiseAt}`, noiseOut = `gain#${noiseAt + 1}`, level = `gain#${noiseAt + 2}`;
    assert.deepEqual(sinksOf(busOut), [roomIn], 'the bus now feeds the reverb');
    assert.deepEqual(sinksOf(roomOut), [noiseIn], 'the reverb feeds the bed, not the destination');
    assert.deepEqual(sinksOf(noiseOut), ['destination'], 'the bed is last before the fan');
    assert.ok(sinksOf(noiseIn).includes(noiseOut), 'the mix passes through dry — the bed is additive');

    // Three generators, each through its own gain into the shared level.
    const sources = [...byId.keys()].filter((n) => n.startsWith('src#'));
    assert.equal(sources.length, 3, 'brown, pink and white all run');
    sources.forEach((src) => {
      const [voiceGain] = sinksOf(src);
      assert.ok(voiceGain.startsWith('gain#'));
      assert.deepEqual(sinksOf(voiceGain), [level], 'every generator lands on the level gain');
    });
    assert.equal(byId.get(level).gain.value, params.gain);
    // wcl 0.5 s × 1 is halfway along the colour axis: pure pink, the other two
    // silent but running.
    const voiceGains = sources.map((src) => byId.get(sinksOf(src)[0]).gain.value).sort();
    assert.deepEqual(voiceGains, [0, 0, 1]);

    // Clearing one effect must leave the other wired, not orphan the bus.
    player.setNoise(null);
    assert.deepEqual(sinksOf(busOut), [roomIn]);
    assert.deepEqual(sinksOf(roomOut), ['destination'], 'the reverb reconnects to the fan');
    player.setRoom(null);
    assert.deepEqual(sinksOf(busOut), ['destination'], 'a bare bus again');
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
  }
});

// buildNoise re-implements Noise.js's generators inline (the page-script
// contract forbids imports) and, since noise is a master-bus effect, the page
// copy is the ONLY one that makes sound — createNoiseNode never runs in
// production. So the copy is checked against the module's own output rather
// than trusted to stay in step by inspection.
test('pageMasterPlayer: the page-side generators match Noise.js in level and character', () => {
  const { buffers, StubCtx } = masterPlayerStub();
  const savedWindow = global.window;
  global.window = { AudioContext: StubCtx };
  try {
    pageMasterPlayer();
    const player = global.window.__trussalMasterPlayer;
    player.enqueue([0, 0, 0]);
    player.setNoise(noiseParams({ wcl: 0 }, {}));

    assert.equal(buffers.length, 3, 'one buffer per colour');
    buffers.forEach((buf) => assert.equal(buf.length, 48000 * NOISE_LOOP_S, 'loop length matches'));

    const rms = (b) => Math.sqrt(b.reduce((a, v) => a + v * v, 0) / b.length);
    const meanAbsDelta = (b) => {
      let s = 0; for (let i = 1; i < b.length; i++) s += Math.abs(b[i] - b[i - 1]);
      return s / (b.length - 1);
    };
    // Every colour normalized to the module's target, so the page's crossfade
    // is level-flat exactly as noiseMix() assumes.
    buffers.forEach((buf, i) => {
      assert.ok(Math.abs(rms(buf) - NOISE_RMS) < 1e-5, `buffer ${i} is off the module's RMS target`);
    });
    // Built dark → bright, matching NOISE_COLORS, and each colour's spectral
    // character matches the module's own generator for that colour.
    const pageRoughness = buffers.map((b) => meanAbsDelta(b) / rms(b));
    const moduleRoughness = ['brown', 'pink', 'white'].map((color) => {
      const b = normalizeRms(fillNoise(new Float32Array(48000 * NOISE_LOOP_S), color));
      return meanAbsDelta(b) / rms(b);
    });
    pageRoughness.forEach((r, i) => {
      assert.ok(Math.abs(r - moduleRoughness[i]) / moduleRoughness[i] < 0.05,
        `page colour ${i} does not match the module's generator (${r} vs ${moduleRoughness[i]})`);
    });
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
  }
});

// All four `#` audio effects live on this bus — none of them runs in a
// browser — so the chain order is decided here and nowhere else. It is fixed
// rather than read from the written program, and each position is a musical
// claim the graph has to keep making.
test('pageMasterPlayer: the master path runs crush -> echo -> room -> noise', () => {
  const { edges, byId, state, StubCtx } = masterPlayerStub();
  const savedWindow = global.window;
  global.window = { AudioContext: StubCtx };
  try {
    pageMasterPlayer();
    const player = global.window.__trussalMasterPlayer;
    player.enqueue([0, 0, 0]); // forces ensure() -> ctx exists

    const proc = [...byId.keys()].find((n) => n.startsWith('proc#'));
    const busOut = edges.find(([from]) => from === proc)[1];
    const sinksOf = (n) => edges.filter(([from]) => from === n).map(([, to]) => to);

    // Pushed in the REVERSE of the audio order, so passing this can only mean
    // the path is fixed by the bus rather than by the order they arrived in.
    // Every build creates its input gain first and its output gain second, so
    // the ids at each boundary name those two nodes.
    const noiseAt = state.next;
    player.setNoise(noiseParams({ wcl: 0 }, {}));
    const roomAt = state.next;
    player.setRoom(ROOM_PARAMS);
    const echoAt = state.next;
    player.setEcho(echoParams({ wcl: 500 }, null, { cycleSeconds: 2 }));
    const crushAt = state.next;
    player.setCrush(crushParams({ wcl: 100 }));

    const io = (at) => [`gain#${at}`, `gain#${at + 1}`];
    const [crushIn, crushOut] = io(crushAt);
    const [echoIn, echoOut] = io(echoAt);
    const [roomIn, roomOut] = io(roomAt);
    const [noiseIn, noiseOut] = io(noiseAt);

    assert.deepEqual(sinksOf(busOut), [crushIn], 'the bus hits the quantizer first');
    assert.deepEqual(sinksOf(crushOut), [echoIn], 'the repeats carry crushed audio, not the reverse');
    assert.deepEqual(sinksOf(echoOut), [roomIn], 'the room contains the repeats, not the reverse');
    assert.deepEqual(sinksOf(roomOut), [noiseIn]);
    assert.deepEqual(sinksOf(noiseOut), ['destination'], 'the bed stays last, on the mix and dry');

    // Dropping a link from the MIDDLE has to close the gap: the classic
    // failure is the removed effect keeping its edge and the mix reaching the
    // fan by two paths, or the tail being stranded with no path at all.
    player.setEcho(null);
    assert.deepEqual(sinksOf(crushOut), [roomIn], 'crush feeds the room directly once echo is gone');
    assert.deepEqual(sinksOf(echoOut), [], 'the dropped echo holds no edge');
    player.setCrush(null);
    assert.deepEqual(sinksOf(busOut), [roomIn], 'the bus reconnects to whatever is still first');
    player.setRoom(null);
    player.setNoise(null);
    assert.deepEqual(sinksOf(busOut), ['destination'], 'a bare bus again');
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
  }
});

// buildCrush re-implements makeCrushCurve inline (the page-script contract
// forbids imports) and this copy is the only one that makes sound —
// createCrushNode never runs in production — so it is checked against the
// module rather than trusted to stay in step by inspection.
test('pageMasterPlayer: the page-side crush curve matches Crush.js, and is rebuilt only on a depth change', () => {
  const { byId, StubCtx } = masterPlayerStub();
  const savedWindow = global.window;
  global.window = { AudioContext: StubCtx };
  try {
    pageMasterPlayer();
    const player = global.window.__trussalMasterPlayer;
    player.enqueue([0, 0, 0]);

    const params = crushParams({ wcl: 100 });          // 100 ms of wcl = one halving
    player.setCrush(params);
    const shaper = [...byId.values()].find((n) => n.id.startsWith('shaper#'));
    const lp = [...byId.values()].find((n) => n.id.startsWith('biquad#'));
    assert.deepEqual(shaper.curve, makeCrushCurve(params.bitDepth), 'page curve differs from the module');
    assert.equal(lp.type, 'lowpass');
    assert.equal(lp.frequency.value, 48000 / 2 / params.srDivisor, 'lowpass sits at the decimated Nyquist');

    // The pattern tick pushes 20x/s; a curve rebuild there would allocate a
    // 2048-float array every 50 ms for a depth that never moved.
    const firstCurve = shaper.curve;
    player.setCrush(crushParams({ wcl: 100 }));
    assert.equal(shaper.curve, firstCurve, 'unchanged depth rebuilt the curve anyway');

    const deeper = crushParams({ wcl: 300 });
    player.setCrush(deeper);
    assert.notEqual(shaper.curve, firstCurve, 'a real depth change must rebuild');
    assert.deepEqual(shaper.curve, makeCrushCurve(deeper.bitDepth));
    assert.equal(lp.frequency.value, 48000 / 2 / deeper.srDivisor);
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
  }
});

test('pageMasterPlayer: the echo keeps the dry path clean, limits only the wet one, and ramps its gains', () => {
  const { edges, byId, ramps, state, StubCtx } = masterPlayerStub();
  const savedWindow = global.window;
  global.window = { AudioContext: StubCtx };
  try {
    pageMasterPlayer();
    const player = global.window.__trussalMasterPlayer;
    player.enqueue([0, 0, 0]);

    const at = state.next;
    const params = echoParams({ wcl: 500 }, null, { cycleSeconds: 2 });
    player.setEcho(params);
    const [input, output, delay, fb, wet, limiter] =
      [`gain#${at}`, `gain#${at + 1}`, `delay#${at + 2}`, `gain#${at + 3}`, `gain#${at + 4}`, `comp#${at + 5}`];
    const sinksOf = (n) => edges.filter(([from]) => from === n).map(([, to]) => to);

    assert.ok(sinksOf(input).includes(output), 'the dry signal reaches the output untouched');
    assert.ok(sinksOf(input).includes(delay));
    assert.deepEqual(sinksOf(fb), [delay], 'the feedback loop closes back onto the delay');
    assert.deepEqual(sinksOf(wet), [limiter], 'the wet path goes through the limiter');
    assert.deepEqual(sinksOf(limiter), [output]);
    assert.ok(!sinksOf(input).includes(limiter), 'the limiter must not sit on the dry signal');
    assert.equal(byId.get(delay).maxDelayTime, ECHO_MAX_DELAY_S, 'delay buffer sized for a long cycle');
    assert.equal(byId.get(limiter).threshold.value, LIMITER_THRESHOLD_DB);
    assert.equal(byId.get(delay).delayTime.value, params.delayS);
    assert.equal(byId.get(fb).gain.value, params.feedback);
    assert.equal(byId.get(wet).gain.value, params.wetGain);

    // A patterned argument steps at a boundary, so the gains glide across the
    // discontinuity rather than clicking — but delayTime JUMPS, because
    // ramping the read pointer is a pitch bend, not a re-timing.
    ramps.length = 0;
    const shorter = echoParams({ wcl: 250 }, null, { cycleSeconds: 2 });
    player.setEcho(shorter);
    assert.equal(byId.get(delay).delayTime.value, shorter.delayS, 'the delay re-timed');
    assert.deepEqual(ramps.map((r) => r.name).sort(), ['gain', 'gain'], 'only the two gains were ramped');
    assert.deepEqual(ramps.map((r) => r.node).sort(), [fb, wet].sort());

    // An unchanged push (the pattern tick's usual case) schedules nothing.
    ramps.length = 0;
    player.setEcho(echoParams({ wcl: 250 }, null, { cycleSeconds: 2 }));
    assert.deepEqual(ramps, [], 'a no-op update still scheduled automation');

    // Tearing the effect down has to break the recirculating ring too, or the
    // delay keeps feeding itself whatever was in it after the effect is gone.
    player.setEcho(null);
    assert.deepEqual(sinksOf(fb), [], 'the feedback loop survived teardown');
    assert.deepEqual(sinksOf(delay), []);
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
  }
});

test('pageMasterPlayer: master effects pushed before the context exists are applied on first audio', () => {
  const { edges, byId, StubCtx } = masterPlayerStub();
  const savedWindow = global.window;
  global.window = { AudioContext: StubCtx };
  try {
    pageMasterPlayer();
    const player = global.window.__trussalMasterPlayer;
    // The aggregator pushes as soon as a program is applied, which can precede
    // the first assembled chunk.
    player.setRoom(ROOM_PARAMS);
    player.setNoise(noiseParams({ wcl: 500 }, { spectrum: { metric: 'wcl', factor: 1, fixed: null } }));
    assert.deepEqual(edges, [], 'nothing is built without a context');

    player.enqueue([0, 0, 0]);
    assert.equal([...byId.keys()].filter((n) => n.startsWith('src#')).length, 3, 'the bed was built');
    assert.ok(edges.some(([, to]) => to === 'destination'));
  } finally {
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
  }
});
