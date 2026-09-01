import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GESTURE_TRIGGERS,
  GESTURE_ACTIONS,
  DEFAULT_GESTURE_MAPPINGS,
  normalizeGestureMapping,
  normalizeGestureAndLandmarkConfig,
} from '../src/landmark-gesture-core.js';

// Silence the intentional console.warn for unknown trigger/action while a test
// deliberately feeds one; restore afterwards.
function withoutWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
}

// --- DEFAULT_GESTURE_MAPPINGS integrity ----------------------------------

test('defaults: every entry is a known trigger → known action', () => {
  for (const m of DEFAULT_GESTURE_MAPPINGS) {
    assert.ok(GESTURE_TRIGGERS.includes(m.trigger), `trigger ${m.trigger}`);
    assert.ok(GESTURE_ACTIONS.includes(m.action), `action ${m.action}`);
  }
});

test('defaults: preserve the pre-config hard-wired behaviour', () => {
  const byTrigger = Object.fromEntries(DEFAULT_GESTURE_MAPPINGS.map((m) => [m.trigger, m.action]));
  assert.equal(byTrigger.smile, 'play');
  assert.equal(byTrigger.thumbsUp, 'stop');
  assert.equal(byTrigger.thumbsDown, 'toggle-caret-lock');
  assert.equal(byTrigger.leftBlink, 'update-code');
  assert.equal(byTrigger.browRaise, 'drum-density');
  assert.equal(byTrigger.headTiltLeft, 'transpose-down');
  assert.equal(byTrigger.headTiltRight, 'transpose-up');
});

test('defaults: left-eye-closed hold enables the mode', () => {
  const m = DEFAULT_GESTURE_MAPPINGS.find((x) => x.trigger === 'leftEyeClosed2s');
  assert.equal(m.action, 'enable-landmark-gesture-mode');
});

// --- normalizeGestureMapping -------------------------------------------

test('mapping: trims and passes trigger/action through', () => {
  assert.deepEqual(
    normalizeGestureMapping({ trigger: ' smile ', action: ' play ' }),
    { trigger: 'smile', action: 'play' },
  );
});

test('mapping: keeps regex + replacement for regex-swap, coerced to string', () => {
  assert.deepEqual(
    normalizeGestureMapping({ trigger: 'mouthOpen', action: 'regex-swap', regex: 'bd', replacement: 'sd' }),
    { trigger: 'mouthOpen', action: 'regex-swap', regex: 'bd', replacement: 'sd' },
  );
});

test('mapping: an empty replacement is preserved (delete match)', () => {
  const out = normalizeGestureMapping({ trigger: 'mouthOpen', action: 'regex-swap', regex: 'x', replacement: '' });
  assert.equal(out.replacement, '');
});

test('mapping: missing trigger or action throws', () => {
  assert.throws(() => normalizeGestureMapping({ action: 'play' }), TypeError);
  assert.throws(() => normalizeGestureMapping({ trigger: 'smile' }), TypeError);
  assert.throws(() => normalizeGestureMapping({ trigger: '', action: 'play' }), TypeError);
  assert.throws(() => normalizeGestureMapping('smile'), TypeError);
});

test('mapping: unknown trigger/action is kept, not thrown', () => {
  const out = withoutWarn(() => normalizeGestureMapping({ trigger: 'smiile', action: 'levitate' }));
  assert.deepEqual(out, { trigger: 'smiile', action: 'levitate' });
});

// --- normalizeGestureAndLandmarkConfig --------------------------------

test('config: only supplied keys come back', () => {
  assert.deepEqual(normalizeGestureAndLandmarkConfig({ virtualKeyboardEnabled: true }), {
    virtualKeyboardEnabled: true,
  });
  assert.deepEqual(normalizeGestureAndLandmarkConfig({}), {});
});

test('config: all four properties normalise together', () => {
  const out = normalizeGestureAndLandmarkConfig({
    gestureMappings: [{ trigger: 'smile', action: 'stop' }],
    virtualKeyboardEnabled: true,
    headCursorEnabled: false,
    gestureDetectionEnabled: true,
  });
  assert.deepEqual(out, {
    gestureMappings: [{ trigger: 'smile', action: 'stop' }],
    virtualKeyboardEnabled: true,
    headCursorEnabled: false,
    gestureDetectionEnabled: true,
  });
});

test('config: non-object argument throws', () => {
  assert.throws(() => normalizeGestureAndLandmarkConfig(null), TypeError);
  assert.throws(() => normalizeGestureAndLandmarkConfig([]), TypeError);
  assert.throws(() => normalizeGestureAndLandmarkConfig('x'), TypeError);
});

test('config: gestureMappings must be an array', () => {
  assert.throws(() => normalizeGestureAndLandmarkConfig({ gestureMappings: {} }), TypeError);
});

test('config: a non-boolean flag throws rather than being coerced', () => {
  assert.throws(() => normalizeGestureAndLandmarkConfig({ virtualKeyboardEnabled: 1 }), TypeError);
  assert.throws(() => normalizeGestureAndLandmarkConfig({ headCursorEnabled: 'yes' }), TypeError);
  assert.throws(() => normalizeGestureAndLandmarkConfig({ gestureDetectionEnabled: null }), TypeError);
});

test('config: a bad mapping inside the array propagates', () => {
  assert.throws(
    () => normalizeGestureAndLandmarkConfig({ gestureMappings: [{ trigger: 'smile' }] }),
    TypeError,
  );
});
