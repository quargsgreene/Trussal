// pageMosaic runs in the browser, but it is a plain function — so run it here
// against a DOM stub rather than only asserting on its serialized source.
//
// This exists because of a bug that source-regex assertions could never see:
// the published canvas was created but never appended, and the getUserMedia
// override finds it with document.querySelector, which cannot match a detached
// node. The aggregator's join would then hang waiting for a canvas that was
// there all along.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  pageMosaic, pageGumOverride, pageSetMosaicOutput, pageInstallOutputVendor,
} from '../src/bot/page-scripts.js';

// --- the smallest DOM that pageMosaic touches ---------------------------------

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.className = '';
    this.children = [];
    this.parent = null;
    this.style = { cssText: '' };
    this.dataset = {};
    this.width = 0;
    this.height = 0;
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i !== -1) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  getContext() {
    return { fillRect() {}, drawImage() {}, set fillStyle(_v) {}, get fillStyle() { return '#000'; } };
  }
  captureStream() { return { getVideoTracks: () => [{ kind: 'video' }] }; }
  // Depth-first walk, enough for the `canvas#id` / tag selectors in play.
  *walk() {
    for (const child of this.children) { yield child; yield* child.walk(); }
  }
}

function matches(node, selector) {
  return selector.split(',').map((s) => s.trim()).some((sel) => {
    const [tag, id] = sel.split('#');
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    return !id || node.id === id;
  });
}

let root;
beforeEach(() => {
  root = new FakeNode('html');
  const body = new FakeNode('body');
  root.appendChild(body);
  globalThis.document = {
    body,
    documentElement: root,
    createElement: (tag) => new FakeNode(tag),
    addEventListener: () => {},
    querySelector: (sel) => [...root.walk()].find((n) => matches(n, sel)) || null,
    querySelectorAll: (sel) => [...root.walk()].filter((n) => matches(n, sel)),
  };
  globalThis.window = {};
  globalThis.performance = { now: () => 0 };
  globalThis.requestAnimationFrame = () => 1;   // never actually paint
  globalThis.setInterval = () => 1;
  globalThis.setTimeout = () => 1;
});
afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.performance;
  delete globalThis.requestAnimationFrame;
  delete globalThis.setInterval;
  delete globalThis.setTimeout;
});

// --- the regression -----------------------------------------------------------

test('mosaic page: the published canvas is IN the document, where gUM looks for it', () => {
  pageMosaic({ width: 1280, height: 720 });
  const found = document.querySelector('canvas#trussal-mosaic-out');
  assert.ok(found, 'a detached output canvas is invisible to the gUM override');
  assert.equal(found.width, 1280);
  assert.equal(found.height, 720);
});

test('mosaic page: the output canvas exists before any participant runs Hydra', () => {
  // This is the join-hang case: with no Hydra cells there is no other canvas
  // in the page at all, so waitForCanvas would poll for ever.
  pageMosaic({ width: 640, height: 360 });
  const canvases = document.querySelectorAll('canvas');
  assert.equal(canvases.length, 1, 'exactly the output canvas, no cells yet');
  assert.equal(canvases[0].id, 'trussal-mosaic-out');
});

test('mosaic page: the gUM override prefers the mosaic over any cell canvas', () => {
  // The cell canvases are frame-sized too, so a "largest canvas" fallback
  // would pick an arbitrary participant and publish them full-frame.
  const js = String(pageGumOverride);
  const mosaicAt = js.indexOf('trussal-mosaic-out');
  const largestAt = js.indexOf('b.width * b.height');
  assert.ok(mosaicAt !== -1, 'the override matches the mosaic canvas');
  assert.ok(mosaicAt < largestAt, 'and does so BEFORE falling back to the largest canvas');
});

test('mosaic page: installs its api and is idempotent', () => {
  pageMosaic({ width: 640, height: 360 });
  const first = window.__trussalMosaic;
  assert.ok(first, 'api installed');
  pageMosaic({ width: 640, height: 360 });
  assert.equal(window.__trussalMosaic, first, 'a second install is a no-op');
  assert.equal(document.querySelectorAll('canvas').length, 1, 'and does not add a second canvas');
});

test('mosaic page: starts black with nothing playing', () => {
  pageMosaic({ width: 640, height: 360 });
  const diag = window.__trussalMosaic.diag();
  assert.equal(diag.activeToken, null, 'nobody is streaming yet');
  assert.deepEqual(diag.cells, [], 'no cells until a participant runs Hydra');
  assert.equal(diag.enabled, true, 'the mosaic is the resting state');
});

test('mosaic page: a cycle anchor drives the H() clock forward', () => {
  let now = 1000;
  globalThis.performance = { now: () => now };
  pageMosaic({ width: 640, height: 360 });
  const m = window.__trussalMosaic;

  assert.equal(m.diag().cyclePos, 0, 'no grid yet -> cycle 0, not a runaway clock');

  // Cycle 4 begins half a second from now, and a cycle lasts 2s.
  m.setCycle({ cycle: 4, seconds: 2, inSeconds: 0.5 });
  now = 1500;                       // the boundary itself
  assert.equal(m.diag().cyclePos, 4);
  now = 2500;                       // one second later = half a cycle
  assert.equal(m.diag().cyclePos, 4.5);

  // Nonsense anchors are refused rather than freezing the clock at NaN.
  m.setCycle({ cycle: 9, seconds: 0 });
  assert.equal(m.diag().cyclePos, 4.5);
});

// --- the output stage (shape programs) ---------------------------------------
//
// pageSetMosaicOutput is what the aggregator's #syncMosaicOutput pushes: the
// resolved stage state, answered with `{ ok, wants }` naming the vendored
// libraries the page still needs. These run against the DOM stub with no
// vendor installed and no WebGL, which is exactly the state a real page is in
// between the first push and the install landing — the stage must sit on the
// plain mosaic, ask for what it needs, and never try to half-render.

test('output stage: a page with no shape program has no stage at all', () => {
  pageMosaic({ width: 1280, height: 720 });
  const m = window.__trussalMosaic;
  assert.deepEqual(m.diag().output, { active: false, libs: {} });
  assert.deepEqual(m.outputVendorNeeds(), [], 'nothing to source');

  assert.deepEqual(pageSetMosaicOutput(null), { ok: true, wants: [] });
  assert.deepEqual(m.diag().output, { active: false, libs: {} },
    'a null push does not build a stage');
});

test('output stage: a three.js shape asks for its library and stays off until it lands', () => {
  pageMosaic({ width: 1280, height: 720 });
  const m = window.__trussalMosaic;
  const res = pageSetMosaicOutput({
    shape: { name: 'tetrahedron', family: 'three', geometry: [1.5], scene: [], animation: [] },
    tiling: null, skybox: false, particle2: null, particle3: null,
    tessellation: null, background: null,
  });
  assert.equal(res.ok, true, 'the state reached the page');
  assert.deepEqual(res.wants, ['three'], 'the page names what it is missing');

  const out = m.diag().output;
  assert.equal(out.active, false, 'never a half-composed frame: no lib, no stage');
  assert.deepEqual(out.libs, { three: 'waiting', p5: 'off' });
  assert.equal(out.state.shape.name, 'tetrahedron');
  assert.equal(out.state.shape.family, 'three');
  assert.equal(out.state.background, null);
  assert.deepEqual(m.outputVendorNeeds(), ['three'],
    'the handshake repeats until the install answers it');
});

test('output stage: works from serialized source, as evaluateOnNewDocument runs it', () => {
  // Calling pageMosaic directly lets it see this module's scope; the page only
  // ever gets its source text. Rebuild it from that text in global scope so a
  // helper left beside it, rather than inside it, fails here too.
  const serialized = new Function(`return (${pageMosaic.toString()})`)();
  serialized({ width: 1280, height: 720 });
  const m = window.__trussalMosaic;
  const res = pageSetMosaicOutput({
    shape: { name: 'sphere', family: 'three', geometry: [], scene: [], animation: [] },
    tiling: null, skybox: true, particle2: null, particle3: null,
    tessellation: null, background: null,
  });
  assert.deepEqual(m.diag().errors, [], 'the stage was built without a ReferenceError');
  assert.deepEqual(res.wants, ['three'], 'and it asked for its library');
  assert.equal(m.diag().output.state.shape.name, 'sphere');
});

test('output stage: a p5 shape asks for p5, and layers can need both libraries', () => {
  pageMosaic({ width: 1280, height: 720 });
  const m = window.__trussalMosaic;
  const base = {
    tiling: null, skybox: false, particle2: null, particle3: null,
    tessellation: null, background: null,
  };

  pageSetMosaicOutput({
    ...base,
    shape: { name: 'star', family: 'p5', geometry: [100, 5, 0.4], scene: [], animation: [] },
  });
  assert.deepEqual(m.outputVendorNeeds(), ['p5']);
  assert.deepEqual(m.diag().output.libs, { three: 'off', p5: 'waiting' });

  // Independent layers stack: a skybox needs three.js while the p5 shape and
  // the 2D particle cloud need p5 — both requested, three named first.
  const res = pageSetMosaicOutput({
    ...base,
    skybox: true,
    particle2: { count: 400, size: 3, speed: 1 },
    shape: { name: 'star', family: 'p5', geometry: [100, 5, 0.4], scene: [], animation: [] },
  });
  assert.deepEqual(res.wants, ['three', 'p5']);
});

test('output stage: tessellation follows the shape — a 3D honeycomb needs three.js only', () => {
  pageMosaic({ width: 1280, height: 720 });
  const m = window.__trussalMosaic;
  const base = {
    tiling: null, skybox: false, particle2: null, particle3: null, background: null,
    tessellation: { cols: 6, rows: 4, spin: 0.35 },
  };
  const res = pageSetMosaicOutput({
    ...base, shape: { name: 'sphere', family: 'three', geometry: [], scene: [], animation: [] },
  });
  assert.deepEqual(res.wants, ['three'], 'the honeycomb never loads p5');
  assert.deepEqual(m.diag().output.libs, { three: 'waiting', p5: 'off' });

  pageSetMosaicOutput({
    ...base, shape: { name: 'star', family: 'p5', geometry: [], scene: [], animation: [] },
  });
  assert.deepEqual(m.outputVendorNeeds(), ['p5'], 'a 2D shape tiles the page in p5');
});

test('output stage: camera, controls and lighting alone draw nothing', () => {
  pageMosaic({ width: 1280, height: 720 });
  const m = window.__trussalMosaic;
  const res = pageSetMosaicOutput({
    shape: null, tiling: null, skybox: false, particle2: null, particle3: null,
    tessellation: null, background: null,
    camera3d: { azimuth: 30, polar: 60, zoom: 1, fov: 50, roll: 0 },
    controls3d: { mode: 'orbit', speed: 0.125, amount: 20 },
    lighting3d: { mode: 'studio', intensity: 1, azimuth: 45, polar: 45, spin: 0, color: '#ffffff' },
  });
  assert.deepEqual(res.wants, []);
  const out = m.diag().output;
  assert.equal(out.active, false);
  assert.equal(out.state.controls3d, 'orbit');
  assert.equal(out.state.lighting3d, 'studio');
});

test('output stage: a background alone never asks for a library or arms the stage', () => {
  pageMosaic({ width: 1280, height: 720 });
  const m = window.__trussalMosaic;
  const res = pageSetMosaicOutput({
    shape: null, tiling: null, skybox: false, particle2: null, particle3: null,
    tessellation: null, background: { type: 'color', color: '#123456' },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.wants, [],
    'drawable() is false — a backdrop has nothing to sit behind');
  const out = m.diag().output;
  assert.equal(out.active, false);
  assert.equal(out.state.background, 'color');
  assert.deepEqual(out.libs, { three: 'off', p5: 'off' });
});

test('output vendor: install is per-library and a missing argument never clobbers', () => {
  assert.deepEqual(pageInstallOutputVendor('THREE-SRC', null), { three: true, p5: false });
  assert.equal(window.__trussalVendor.three, 'THREE-SRC');

  assert.deepEqual(pageInstallOutputVendor(null, 'P5-SRC'), { three: true, p5: true },
    'a null three does not clobber the installed one');
  assert.equal(window.__trussalVendor.three, 'THREE-SRC');
  assert.equal(window.__trussalVendor.p5, 'P5-SRC');

  assert.deepEqual(pageInstallOutputVendor('THREE-SRC', 'P5-SRC'), { three: true, p5: true },
    're-installing the same sources is a no-op');
});
