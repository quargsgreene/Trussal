// landmark-gesture-core.js
// The one rule for a `gestureAndLandmarkConfig({...})` argument: which gesture
// triggers and actions exist, what a single gesture mapping looks like, and how
// a caller-supplied config object is validated and normalised before
// facial-gesture.js and the on-screen keyboard act on it.
//
// Pure — no DOM, no MediaPipe — so it is unit-testable and the browser modules
// stay a thin layer over it. A gesture mapping has the SAME shape as the legacy
// `/* @mediapipe {…} */` code annotation: { trigger, action, regex?, replacement? }.

// Every gesture the detector can raise. `leftEyeClosed2s` is the sustained
// one-eyed hold the top-left instruction advertises as an enable path (the name
// is historical — the detector fires it for whichever eye is held shut).
export const GESTURE_TRIGGERS = [
  'smile',
  'thumbsUp',
  'thumbsDown',
  'leftBlink',
  'browRaise',
  'headTiltLeft',
  'headTiltRight',
  'mouthOpen',
  'leftEyeClosed2s',
];

// Every action a mapping may name. `regex-swap` reads `regex`/`replacement`;
// the rest ignore them. `enable-landmark-gesture-mode` is the only action that
// still runs while gesture detection itself is switched off.
export const GESTURE_ACTIONS = [
  'play',
  'stop',
  'update-code',
  'toggle-caret-lock',
  'drum-density',
  'transpose-down',
  'transpose-up',
  'regex-swap',
  'apply-metaprogram',
  'enable-landmark-gesture-mode',
];

// Defaults === the mappings that were hard-wired into facial-gesture.js before
// gestureAndLandmarkConfig existed, plus the left-eye-closed enable gesture.
// Passing no `gestureMappings` leaves these in force ("default settings being
// as things currently are").
export const DEFAULT_GESTURE_MAPPINGS = [
  { trigger: 'smile',           action: 'play' },
  { trigger: 'thumbsUp',        action: 'stop' },
  { trigger: 'thumbsDown',      action: 'toggle-caret-lock' },
  { trigger: 'leftBlink',       action: 'update-code' },
  { trigger: 'browRaise',       action: 'drum-density' },
  { trigger: 'headTiltLeft',    action: 'transpose-down' },
  { trigger: 'headTiltRight',   action: 'transpose-up' },
  { trigger: 'leftEyeClosed2s', action: 'enable-landmark-gesture-mode' },
];

// An unknown trigger or action is kept, not rejected — a newer bundle may add
// one, and an old draft naming it should still round-trip — but it is logged so
// a typo ("smiile") does not fail silently.
export function normalizeGestureMapping(m, i = 0) {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) {
    throw new TypeError(`gestureMappings[${i}] must be an object`);
  }
  if (typeof m.trigger !== 'string' || !m.trigger.trim()) {
    throw new TypeError(`gestureMappings[${i}].trigger must be a non-empty string`);
  }
  if (typeof m.action !== 'string' || !m.action.trim()) {
    throw new TypeError(`gestureMappings[${i}].action must be a non-empty string`);
  }
  const out = { trigger: m.trigger.trim(), action: m.action.trim() };
  if (m.regex != null) out.regex = String(m.regex);
  if (m.replacement != null) out.replacement = String(m.replacement);
  if (!GESTURE_TRIGGERS.includes(out.trigger)) {
    console.warn(`[landmark-gesture] unknown trigger "${out.trigger}" — kept, but nothing detects it`);
  }
  if (!GESTURE_ACTIONS.includes(out.action)) {
    console.warn(`[landmark-gesture] unknown action "${out.action}" — kept, but nothing runs it`);
  }
  return out;
}

// Returns only the keys the caller actually supplied, each validated. A missing
// key is left for the live modules to keep unchanged; a present key with the
// wrong type throws rather than being coerced, so a bad call is loud.
export function normalizeGestureAndLandmarkConfig(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError('gestureAndLandmarkConfig(config): config must be a plain object');
  }
  const out = {};
  if ('gestureMappings' in obj) {
    if (!Array.isArray(obj.gestureMappings)) {
      throw new TypeError('gestureAndLandmarkConfig: gestureMappings must be an array');
    }
    out.gestureMappings = obj.gestureMappings.map((m, i) => normalizeGestureMapping(m, i));
  }
  for (const key of ['virtualKeyboardEnabled', 'headCursorEnabled', 'gestureDetectionEnabled']) {
    if (key in obj) {
      if (typeof obj[key] !== 'boolean') {
        throw new TypeError(`gestureAndLandmarkConfig: ${key} must be a boolean`);
      }
      out[key] = obj[key];
    }
  }
  return out;
}
