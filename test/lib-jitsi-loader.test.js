// lib-jitsi-loader.js brings the lib-jitsi-meet bundle in when the page does
// not already provide it (a standalone deployment with no Jitsi web app). These
// tests cover URL resolution and the load/wait/timeout/error paths against a
// stub DOM, so no network is touched.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getLibJitsi,
  getLibJitsiUrl,
  ensureLibJitsi,
  resetLibJitsiLoader,
} from '../src/lib-jitsi-loader.js';

const LIB_PATH = 'libs/lib-jitsi-meet.min.js';

// Stub document. `onAppend` decides what the browser does once the script is
// added — the default fires onload on a later tick.
function installDom(onAppend) {
  const scripts = [];
  globalThis.document = {
    head: {
      appendChild(el) {
        scripts.push(el);
        if (onAppend) onAppend(el);
        else setTimeout(() => el.onload && el.onload(), 0);
      },
    },
    createElement(tag) {
      return { tagName: tag, src: '', async: false, onload: null, onerror: null };
    },
    querySelectorAll() { return scripts; },
  };
  return scripts;
}

beforeEach(() => {
  globalThis.window = { config: {} };
  resetLibJitsiLoader();
});

afterEach(() => {
  resetLibJitsiLoader();
  delete globalThis.document;
});

test('lib-jitsi-loader: an explicit url wins over everything', () => {
  window.config = { libJitsiUrl: 'https://config.example/lib.js' };
  window.__TRUSSAL_LIB_JITSI_URL = 'https://global.example/lib.js';
  assert.equal(getLibJitsiUrl({ url: 'https://explicit.example/lib.js' }), 'https://explicit.example/lib.js');
});

test('lib-jitsi-loader: window override beats config and bundle base', () => {
  window.config = { libJitsiUrl: 'https://config.example/lib.js' };
  window.__TRUSSAL_LIB_JITSI_URL = 'https://global.example/lib.js';
  assert.equal(getLibJitsiUrl({ bundleUrl: 'https://bundle.example/custom-config.js' }), 'https://global.example/lib.js');
});

test('lib-jitsi-loader: config url is used when no override', () => {
  window.config = { libJitsiMeetUrl: 'https://config.example/lib.js' };
  assert.equal(getLibJitsiUrl({ bundleUrl: 'https://bundle.example/custom-config.js' }), 'https://config.example/lib.js');
});

test('lib-jitsi-loader: defaults to the bundle-relative libs path', () => {
  assert.equal(
    getLibJitsiUrl({ bundleUrl: 'https://host.example/sub/custom-config.js?v=9' }),
    'https://host.example/sub/' + LIB_PATH,
  );
});

test('lib-jitsi-loader: falls back to the root libs path with no base', () => {
  assert.equal(getLibJitsiUrl(), '/libs/lib-jitsi-meet.min.js');
});

test('lib-jitsi-loader: an already-present global is returned without a script', async () => {
  const fake = { init() {} };
  window.JitsiMeetJS = fake;
  const scripts = installDom();
  assert.equal(await ensureLibJitsi(), fake);
  assert.equal(scripts.length, 0, 'the bundle must not be fetched twice');
});

test('lib-jitsi-loader: loads the bundle and resolves the global', async () => {
  const fake = { init() {} };
  const scripts = installDom((el) => {
    window.JitsiMeetJS = fake;
    el.onload && el.onload();
  });
  const lib = await ensureLibJitsi({ timeoutMs: 500 });
  assert.equal(lib, fake);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, '/libs/lib-jitsi-meet.min.js');
  assert.equal(getLibJitsi(), fake);
});

test('lib-jitsi-loader: a script error resolves to null, never throws', async () => {
  installDom((el) => { el.onerror && el.onerror(); });
  assert.equal(await ensureLibJitsi({ timeoutMs: 500 }), null);
});

test('lib-jitsi-loader: a loaded script that never defines the global times out', async () => {
  installDom(); // default: onload fires, but window.JitsiMeetJS stays undefined
  assert.equal(await ensureLibJitsi({ timeoutMs: 40 }), null);
});

test('lib-jitsi-loader: concurrent callers share one script tag', async () => {
  const fake = { init() {} };
  let fireLoad;
  const scripts = installDom((el) => { fireLoad = () => el.onload && el.onload(); });
  const first = ensureLibJitsi({ timeoutMs: 500 });
  const second = ensureLibJitsi({ timeoutMs: 500 });
  assert.equal(scripts.length, 1, 'only one <script> is ever appended');
  window.JitsiMeetJS = fake;
  fireLoad();
  assert.equal(await first, fake);
  assert.equal(await second, fake);
  assert.equal(scripts.length, 1);
});

test('lib-jitsi-loader: skips injecting when the page already has that script tag', async () => {
  const fake = { init() {} };
  installDom();
  // Simulate the Jitsi web page's own <script src="/libs/lib-jitsi-meet.min.js">
  // still in flight: it is in the DOM, the global has not landed yet.
  const existing = { tagName: 'script', src: '/libs/lib-jitsi-meet.min.js' };
  document.querySelectorAll = () => [existing];
  const p = ensureLibJitsi({ timeoutMs: 500 });
  setTimeout(() => { window.JitsiMeetJS = fake; }, 5);
  assert.equal(await p, fake);
  assert.equal(document.querySelectorAll().length, 1, 'no duplicate tag was appended');
});

test('lib-jitsi-loader: recognizes a relative script src already in the page', async () => {
  const fake = { init() {} };
  installDom();
  document.baseURI = 'https://host.example/room';
  document.querySelectorAll = () => [{
    tagName: 'script',
    src: 'https://host.example/libs/lib-jitsi-meet.min.js',
  }];
  const p = ensureLibJitsi({ timeoutMs: 500 });
  setTimeout(() => { window.JitsiMeetJS = fake; }, 5);
  assert.equal(await p, fake);
  assert.equal(document.querySelectorAll().length, 1);
});

test('lib-jitsi-loader: getLibJitsi reads the window it is given', () => {
  const fake = { init() {} };
  assert.equal(getLibJitsi({ JitsiMeetJS: fake }), fake);
  assert.equal(getLibJitsi({}), null);
});
