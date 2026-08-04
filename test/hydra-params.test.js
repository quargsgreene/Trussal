// `H(...)` in the aggregator's mosaic: reading a Strudel pattern's value at a
// point on the room's cycle grid.
//
// The Strudel half cannot be exercised here — @strudel/web is a browser bundle
// that assigns window.initStrudel at import — so these cover the logic this
// repo actually owns: how a pattern is sampled, and what happens when the
// pattern machinery is absent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleAt, installHydraParamApi, resetHydraParamApi } from '../src/hydra-params.js';

// Stand-in for a Strudel pattern: records the arcs it was queried over.
function fakePattern(events, { emptyAtZeroWidth = false } = {}) {
  const queries = [];
  return {
    queries,
    queryArc(begin, end) {
      queries.push([begin, end]);
      if (emptyAtZeroWidth && begin === end) return [];
      return events;
    }
  };
}

test('H: samples the zero-width arc, as Strudel\'s own H does', () => {
  const pattern = fakePattern([{ value: 40 }]);
  assert.equal(sampleAt(pattern, 3.25), 40);
  assert.deepEqual(pattern.queries, [[3.25, 3.25]], 'one zero-width query, no nudge needed');
});

test('H: falls back to a hair-width arc when the instant yields nothing', () => {
  const pattern = fakePattern([{ value: 7 }], { emptyAtZeroWidth: true });
  assert.equal(sampleAt(pattern, 2), 7);
  assert.equal(pattern.queries.length, 2, 'zero-width first, then the nudge');
  const [, nudged] = pattern.queries;
  assert.equal(nudged[0], 2);
  assert.ok(nudged[1] > 2 && nudged[1] < 2.001, 'the nudge is a hair, not a whole cycle');
});

test('H: a pattern with nothing at that point samples undefined, not a crash', () => {
  const pattern = { queryArc: () => [] };
  assert.equal(sampleAt(pattern, 1), undefined);
});

test('H: a non-finite cycle position reads cycle 0 rather than NaN', () => {
  const pattern = fakePattern([{ value: 1 }]);
  sampleAt(pattern, NaN);
  assert.deepEqual(pattern.queries, [[0, 0]]);
});

test('H: the first value of the queried arc wins', () => {
  const pattern = fakePattern([{ value: 'first' }, { value: 'second' }]);
  assert.equal(sampleAt(pattern, 0), 'first');
});

// --- degraded path ------------------------------------------------------------

test('H: without the pattern machinery, a numeric argument holds its own value', async () => {
  globalThis.window = {};
  try {
    const api = installHydraParamApi();
    // @strudel/web does not resolve under node: the import rejects and the
    // API stays usable but unpatterned.
    assert.equal(await api.whenReady, false);

    // A performer writing H(40) still gets 40 — the parameter is simply not
    // animated, rather than snapping the cell to zero.
    assert.equal(api.makeH(() => 0)(40)(), 40);
    // And a pattern argument holds a defined number instead of throwing into
    // Hydra's render loop every frame.
    assert.equal(api.makeH(() => 0)('<10 40>')(), 0);
  } finally {
    resetHydraParamApi();
    delete globalThis.window;
  }
});

test('H: installing twice returns the same api rather than re-importing', () => {
  globalThis.window = {};
  try {
    assert.equal(installHydraParamApi(), installHydraParamApi());
    assert.equal(window.__trussalHydraParams, installHydraParamApi());
  } finally {
    resetHydraParamApi();
    delete globalThis.window;
  }
});
