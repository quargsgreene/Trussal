import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chromiumArgs, spoofedUserAgent, jitsiRoomUrl } from '../src/bot/chromium-args.js';
import { ffmpegBedArgs } from '../src/bot/ffmpeg-bed.js';
import { jamulusArgs } from '../src/bot/jamulus.js';
import {
  pageAudioBridge, pageGumOverride, pageStrudelBoot, pageFpsSampler, pageReadSamples,
} from '../src/bot/page-scripts.js';
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

test('pageStrudelBoot loads the REPL, takes code as a structured arg, reports eval errors', () => {
  const js = String(pageStrudelBoot);
  assert.match(js, /strudel-editor/);
  assert.match(js, /initHydra|hydra/, 'hydra code path present');
  assert.match(js, /__trussalReportError/, 'runtime eval errors must reach the conductor');
  assert.match(js, /\{\s*strudel,\s*hydra\s*\}/, 'per-bot code arrives as a parameter, not spliced source');
});

test('pageFpsSampler counts rAF frames; pageReadSamples drains errors', () => {
  assert.match(String(pageFpsSampler), /requestAnimationFrame/);
  assert.match(String(pageReadSamples), /__trussalErrors/);
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
  // ...and explicitly publishes the Hydra canvas as its video track.
  const videoIdx = calls.evaluate.findIndex((s) => /muteVideo\(false\)/.test(s));
  assert.ok(videoIdx !== -1, 'bot publishes a Hydra video track after joining');

  const m = await bot.sampleMetrics();
  assert.equal(typeof m.ramBytes, 'number');
  assert.equal(typeof m.fps, 'number');
  assert.equal(m.botId, 2);

  await bot.stop();
  assert.equal(calls.closed, true);
});
