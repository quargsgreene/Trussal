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

import { pageMosaic, pageGumOverride } from '../src/bot/page-scripts.js';

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
