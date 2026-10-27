// `.out("device")` routing: what the call is read as, what it leaves behind
// for evaluation, how a typed name finds a local device, and the Metaprogram's
// `# out` directive. The browser glue (output-route.js) is not exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractOutRoutes, stripOutRoutes, parseChannels, statementMedium, matchOutputDevice,
  matchScreen, channelMap, metaprogramRoutes, permissionKey, permissionPrompt, OUT_MEDIA,
} from '../src/output-route-core.js';
import { normalizePeerCode, peerOutRoutes, hasHydraCode } from '../src/hydra-code.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';
import { resolveMedia } from '../src/audio-net/EffectMedia.js';

// --- the call ------------------------------------------------------------------

test('a labelled Hydra voice routes video and keeps rendering with a plain .out()', () => {
  const { code, routes } = extractOutRoutes('vid: osc(100).out("some monitor")');
  assert.equal(code, 'osc(100).out()', "the label goes too — Strudel's transpiler would add .p() to undefined");
  assert.deepEqual(routes, [{ voice: 'vid', medium: 'video', target: 'some monitor', channels: null }]);
});

test('a Strudel voice routes audio, keeps its label, and loses the call', () => {
  const { code, routes } = extractOutRoutes('drums: s("bd*4").out("MOTU M4", [3, 4])');
  assert.equal(code, 'drums: s("bd*4")');
  assert.deepEqual(routes, [{ voice: 'drums', medium: 'audio', target: 'MOTU M4', channels: [3, 4] }]);
});

test('a single channel number, and single-quoted names, are accepted', () => {
  assert.deepEqual(extractOutRoutes("$: s('hh*8').out('Studio Monitors', 2)").routes,
    [{ voice: '$1', medium: 'audio', target: 'Studio Monitors', channels: [2] }]);
});

test('word() and css() voices route text and css', () => {
  const { routes } = extractOutRoutes([
    '$: word("hello").out("lobby screen")',
    '$: css(".x { color: red }").out("lobby screen")',
  ].join('\n'));
  assert.deepEqual(routes.map((r) => [r.voice, r.medium]), [['$1', 'text'], ['$2', 'css']]);
});

test('a multi-line Hydra chain is classified by its head line', () => {
  const src = 'vid: osc(10)\n  .rotate(0.1)\n  .out("some monitor")';
  const { code, routes } = extractOutRoutes(src);
  assert.equal(code, 'osc(10)\n  .rotate(0.1)\n  .out()');
  assert.equal(routes[0].medium, 'video');
  assert.equal(routes[0].voice, 'vid');
});

test("Hydra's own .out() / .out(o1) and code with no routes pass through untouched", () => {
  const src = 'osc(5).out()\nsrc(o0).out(o1)\n$: s("bd")';
  assert.deepEqual(extractOutRoutes(src), { code: src, routes: [] });
  assert.equal(stripOutRoutes(src), src);
});

test('a route on its own continuation line takes the line with it', () => {
  assert.equal(stripOutRoutes('$: s("bd")\n  .out("x")\n  .lpf(200)'), '$: s("bd")\n  .lpf(200)');
});

test('an empty device name is rewritten away but routes nowhere', () => {
  assert.deepEqual(extractOutRoutes('$: s("bd").out("")'), { code: '$: s("bd")', routes: [] });
});

test('parseChannels and statementMedium', () => {
  assert.deepEqual(parseChannels('[4, 3, 3]'), [3, 4]);
  assert.equal(parseChannels('0'), null);
  assert.equal(parseChannels(undefined), null);
  assert.equal(statementMedium('vid: shape(4).out("x")'), 'video');
  assert.equal(statementMedium('$: note("c e g").out("x")'), 'audio');
});

// --- through the shared normalizer ---------------------------------------------

test('normalizePeerCode strips routes before sniffing for Hydra', () => {
  const src = "'personal editor'\n$: s(\"bd*4\").out(\"speakers\")";
  assert.equal(normalizePeerCode(src), '$: s("bd*4")', 'a Strudel .out("…") must not read as a Hydra render');
  assert.equal(hasHydraCode(src), false);
  assert.deepEqual(peerOutRoutes(src), [{ voice: '$1', medium: 'audio', target: 'speakers', channels: null }]);
});

test('a routed Hydra voice still earns its preamble and its mosaic cell', () => {
  const src = "'personal editor'\nvid: osc(100).out(\"some monitor\")";
  assert.equal(normalizePeerCode(src), 'await initHydra()\n\nosc(100).out()');
  assert.equal(hasHydraCode(src), true);
});

test('mondo `# out` lowers to the same route', () => {
  const src = "'personal editor'\n$ s \"bd*4\"\n# out \"MOTU M4\" 3";
  assert.deepEqual(peerOutRoutes(src), [{ voice: '$1', medium: 'audio', target: 'MOTU M4', channels: [3] }]);
  assert.equal(normalizePeerCode(src), '$: s("bd*4")');
});

// --- devices ----------------------------------------------------------------------

test('matchOutputDevice: exact, then substring, then raw id; inputs ignored', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'in1', label: 'MOTU M4 In' },
    { kind: 'audiooutput', deviceId: 'a', label: 'MOTU M4 (Out)' },
    { kind: 'audiooutput', deviceId: 'b', label: 'motu m4' },
  ];
  assert.equal(matchOutputDevice(devices, 'MOTU M4').deviceId, 'b');
  assert.equal(matchOutputDevice(devices, '(out)').deviceId, 'a');
  assert.equal(matchOutputDevice(devices, 'a').deviceId, 'a');
  assert.equal(matchOutputDevice(devices, 'in1'), null);
  assert.equal(matchOutputDevice(devices, ''), null);
});

test('matchScreen: by label, or "screen N" by position', () => {
  const screens = [{ label: 'Built-in Retina Display' }, { label: 'DELL U2720Q' }];
  assert.equal(matchScreen(screens, 'dell u2720q'), screens[1]);
  assert.equal(matchScreen(screens, 'retina'), screens[0]);
  assert.equal(matchScreen(screens, 'screen 2'), screens[1]);
  assert.equal(matchScreen(screens, 'some monitor'), null);
});

test('channelMap: 1-based to 0-based, clipped to the device', () => {
  assert.deepEqual(channelMap([3, 4], 8), [2, 3]);
  assert.deepEqual(channelMap([1, 9], 4), [0]);
  assert.equal(channelMap([9], 4), null);
  assert.equal(channelMap(null, 8), null);
});

test('permission is asked per author and device, and says who and what', () => {
  assert.equal(permissionKey({ author: 'abc', deviceId: 'd1' }), 'abc|d1');
  assert.equal(
    permissionPrompt({ authorName: 'Ada', voices: ['vid'], medium: 'video', deviceLabel: 'some monitor' }),
    `Ada wants to stream voice 'vid' (video) to your device "some monitor".`);
  assert.match(
    permissionPrompt({ authorName: 'Ada', voices: ['a', 'b'], medium: 'audio', deviceLabel: 'M4', channels: [3, 4] }),
    /voices 'a', 'b' \(audio\) .* on channels 3, 4\.$/);
});

// --- the Metaprogram ------------------------------------------------------------------

const meta = (body) => parseMetaprogram(`'metaprogram editor'\n$ participants <0>\n${body}`);

test('# out parses a device, channels and a medium set', () => {
  const { ast, errors } = meta('# out "lobby screen" ["video" "text"]\n# out "MOTU M4" 4 3 ["audio"]');
  assert.deepEqual(errors, []);
  assert.deepEqual(ast.chain.map(({ fn, target, channels, media }) => ({ fn, target, channels, media: media && [...media] })), [
    { fn: 'out', target: 'lobby screen', channels: null, media: ['text', 'video'] },
    { fn: 'out', target: 'MOTU M4', channels: [3, 4], media: ['audio'] },
  ]);
});

test('# out in mini notation', () => {
  const { ast, errors } = parseMetaprogram(`'metaprogram editor'\n$: participants("<0>").out("MOTU M4", 3)`);
  assert.deepEqual(errors, []);
  assert.equal(ast.chain[0].target, 'MOTU M4');
  assert.deepEqual(ast.chain[0].channels, [3]);
});

test('# out errors name the fix', () => {
  const msgs = (body) => meta(body).errors.map((e) => e.message);
  assert.ok(msgs('# out monitor').some((m) => /device names are quoted/.test(m)));
  assert.ok(msgs('# out').some((m) => /needs a quoted device name/.test(m)));
  assert.ok(msgs('# out "a" "b"').some((m) => /one device name/.test(m)));
  assert.ok(msgs('# out "a" 0').some((m) => /whole numbers from 1/.test(m)));
  assert.ok(msgs('# out "a" <["audio"] ["video"]>').some((m) => /not a pattern of them/.test(m)));
});

test('metaprogramRoutes expands a route across its media (all four when unwritten)', () => {
  const { ast } = meta('# out "lobby screen"\n# out "M4" 1 ["audio"]');
  const routes = metaprogramRoutes(ast.chain, (m) => resolveMedia(m, 0));
  assert.deepEqual(routes.filter((r) => r.target === 'lobby screen').map((r) => r.medium), [...OUT_MEDIA]);
  assert.deepEqual(routes.filter((r) => r.target === 'M4'), [{ voice: 'metaprogram', medium: 'audio', target: 'M4', channels: [1] }]);
});
