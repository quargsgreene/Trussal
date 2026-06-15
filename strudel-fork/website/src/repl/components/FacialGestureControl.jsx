/*
FacialGestureControl.jsx - UI for enabling facial gesture control of the REPL
Copyright (C) 2025 Strudel contributors
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import cx from '@src/cx.mjs';
import { useFacialGestures } from '../useFacialGestures.jsx';
import { initStrudelButton } from '../strudelButton.mjs';

const STATUS_COLOR = {
  ready: 'text-green-400',
  loading: 'text-yellow-400',
  error: 'text-red-400',
};

const GESTURE_LABELS = {
  play: '▶ play',
  stop: '■ stop',
  mouthOpen: '◉ mouth open → update',
  headTiltLeft: '← tilt left → update',
  headTiltRight: '→ tilt right → update',
};

// ms the cursor must dwell over a StrudelButton before toggling.
const DWELL_MS = 1000;
// SVG progress ring geometry (r=16 → circumference = 2π×16 ≈ 100.53)
const RING_R = 16;
const RING_C = 2 * Math.PI * RING_R;

// Parse /* @mediapipe { ... } */ annotation blocks from the editor code.
function parseMediapipeConfigs(code) {
  const configs = [];
  const re = /\/\*\s*@mediapipe\s+(\{[\s\S]*?\})\s*\*\//g;
  let m;
  while ((m = re.exec(code)) !== null) {
    try {
      configs.push(JSON.parse(m[1]));
    } catch {
      // silently skip malformed blocks
    }
  }
  return configs;
}

function applyRegexMutation(code, pattern, replacement) {
  try {
    return code.replace(new RegExp(pattern, 'g'), replacement);
  } catch {
    return code;
  }
}

// Cycle the first hi-hat subdivision: hh → hh*2 → hh*4 → hh*8 → hh
const HH_CYCLE = ['', '*2', '*4', '*8'];
function cycleHiHat(code) {
  const re = /\bhh(\*\d+)?/;
  const m = code.match(re);
  if (!m) return code;
  const current = m[1] ?? '';
  const idx = HH_CYCLE.indexOf(current);
  const next = HH_CYCLE[(idx + 1) % HH_CYCLE.length];
  return code.replace(re, `hh${next}`);
}

// Shift the first .transpose(N) or .add(N) value by delta semitones.
function shiftTranspose(code, delta) {
  if (/\.transpose\((-?\d+)\)/.test(code)) {
    return code.replace(/\.transpose\((-?\d+)\)/, (_, n) => `.transpose(${parseInt(n, 10) + delta})`);
  }
  if (/\.add\((-?\d+)\)/.test(code)) {
    return code.replace(/\.add\((-?\d+)\)/, (_, n) => `.add(${parseInt(n, 10) + delta})`);
  }
  return code;
}

// Apply a mutation and re-evaluate. Skips evaluate when code is unchanged
// to avoid spurious audio clock restarts.
function mutateAndEvaluate(mutatorFn) {
  const mirror = window.strudelMirror;
  if (!mirror) return;
  const newCode = mutatorFn(mirror.code);
  if (newCode !== mirror.code) {
    mirror.setCode(newCode);
    mirror.evaluate();
  }
}

// Toggle a StrudelButton's code at the bottom of the editor.
// First dwell → appends the code (active).
// Second dwell → comments it out (inactive).
// Third dwell → uncomments it (active again), and so on.
const BTN_MARKER = ' // strudel-btn';
function toggleButtonCode(code) {
  const mirror = window.strudelMirror;
  if (!mirror) return;
  const cur = mirror.code;
  const activeLine = `\n${code}${BTN_MARKER}`;
  const commentedLine = `\n// ${code}${BTN_MARKER}`;

  let next;
  if (cur.includes(commentedLine)) {
    // Currently commented-out → uncomment
    next = cur.replace(commentedLine, activeLine);
  } else if (cur.includes(activeLine)) {
    // Currently active → comment out
    next = cur.replace(activeLine, commentedLine);
  } else {
    // Not present → append
    next = cur + activeLine;
  }
  mirror.setCode(next);
  mirror.evaluate();
}

/**
 * Header button + floating overlay for facial gesture REPL control.
 *
 * Gestures:
 *   Blink both eyes firmly  → play/stop toggle
 *   Raise both eyebrows     → stop
 *   Open mouth wide         → Macro A (cycle hi-hat density, or custom regex)
 *   Tilt head left          → Macro B- (transpose -2, or custom regex)
 *   Tilt head right         → Macro B+ (transpose +2, or custom regex)
 *
 * Head cursor:
 *   A visual cursor tracks the forehead landmark.  Dwell over any inline
 *   StrudelButton widget for 1 s to append/toggle its code and re-evaluate.
 *
 * In-code config: /* @mediapipe { "trigger": "mouthOpen", "action": "regex-swap",
 *   "regex": "<pattern>", "replacement": "<text>" } *\/ anywhere in the editor.
 *
 * Continuous values: window.faceCtx.jawOpen, .browInnerUp, .headTilt,
 *   .eyeBlinkLeft, .eyeBlinkRight, .mouthSmileLeft, .mouthSmileRight (0–1, EMA-smoothed),
 *   .cursorX, .cursorY (viewport pixels, EMA-smoothed).
 *
 * StrudelButton usage: write `new StrudelButton("s('bd')")` anywhere in the editor.
 *   The button widget appears inline after the expression is parsed.
 */
export function FacialGestureControl({ started, handleTogglePlay }) {
  const [enabled, setEnabled] = useState(false);
  const [regex, setRegex] = useState('');
  const [replacement, setReplacement] = useState('');
  const [triggerGesture, setTriggerGesture] = useState('mouthOpen');

  // Stable refs so gesture callbacks always read the latest UI state.
  const startedRef = useRef(started);
  const regexRef = useRef('');
  const replacementRef = useRef('');
  const triggerGestureRef = useRef('mouthOpen');

  useEffect(() => { startedRef.current = started; }, [started]);
  useEffect(() => { regexRef.current = regex; }, [regex]);
  useEffect(() => { replacementRef.current = replacement; }, [replacement]);
  useEffect(() => { triggerGestureRef.current = triggerGesture; }, [triggerGesture]);

  // Refs for the head cursor DOM elements — updated imperatively in the RAF loop
  // to avoid triggering React re-renders at 60 fps.
  const cursorElRef = useRef(null);
  const progressRingRef = useRef(null);

  // Dwell state: which button is under the cursor, since when, and whether it fired.
  const dwellRef = useRef({ code: null, el: null, startMs: 0, fired: false });

  // Register StrudelButton globally so eval doesn't throw regardless of camera state.
  useEffect(() => {
    initStrudelButton();
  }, []);

  // RAF loop: read cursor position from window.faceCtx, move the cursor element,
  // and run dwell detection over all inline StrudelButton widgets.
  useEffect(() => {
    if (!enabled) return;
    let rafId;

    function tick() {
      const faceCtx = window.faceCtx;
      const cursorEl = cursorElRef.current;
      const ring = progressRingRef.current;

      if (cursorEl && faceCtx?.cursorX != null) {
        cursorEl.style.left = `${faceCtx.cursorX}px`;
        cursorEl.style.top = `${faceCtx.cursorY}px`;
        cursorEl.style.display = 'block';
      }

      // Dwell detection over .strudel-head-btn elements.
      const cx = faceCtx?.cursorX ?? -1;
      const cy = faceCtx?.cursorY ?? -1;
      const buttons = document.querySelectorAll('.strudel-head-btn');
      let hoveredCode = null;
      let hoveredEl = null;

      for (const btn of buttons) {
        const r = btn.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          hoveredCode = btn.dataset.strudelCode;
          hoveredEl = btn;
          break;
        }
      }

      const dwell = dwellRef.current;
      const now = performance.now();

      if (hoveredCode !== dwell.code) {
        // Cursor moved to a different button (or none) — reset dwell.
        if (dwell.el) {
          dwell.el.classList.remove('strudel-dwell-hover');
        }
        dwell.code = hoveredCode;
        dwell.el = hoveredEl;
        dwell.startMs = hoveredCode ? now : 0;
        dwell.fired = false;
        if (ring) ring.style.strokeDashoffset = RING_C.toFixed(2);
      }

      if (hoveredCode && !dwell.fired) {
        const progress = Math.min((now - dwell.startMs) / DWELL_MS, 1);
        if (dwell.el) dwell.el.classList.add('strudel-dwell-hover');
        if (ring) ring.style.strokeDashoffset = (RING_C * (1 - progress)).toFixed(2);

        if (progress >= 1) {
          dwell.fired = true;
          if (dwell.el) {
            dwell.el.classList.remove('strudel-dwell-hover');
            // Brief flash to confirm activation.
            dwell.el.classList.add('strudel-btn-active');
            setTimeout(() => dwell.el?.classList.remove('strudel-btn-active'), 600);
          }
          if (ring) ring.style.strokeDashoffset = RING_C.toFixed(2);
          toggleButtonCode(hoveredCode);
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      // Hide cursor and reset dwell when disabled.
      if (cursorElRef.current) cursorElRef.current.style.display = 'none';
      dwellRef.current = { code: null, el: null, startMs: 0, fired: false };
    };
  }, [enabled]);

  function makeGestureHandler(triggerName, defaultMutator) {
    return () => {
      const code = window.strudelMirror?.code ?? '';
      const configs = parseMediapipeConfigs(code);
      let ran = false;

      for (const cfg of configs) {
        if (cfg.trigger === triggerName && cfg.action === 'regex-swap' && cfg.regex) {
          mutateAndEvaluate((c) => applyRegexMutation(c, cfg.regex, cfg.replacement ?? ''));
          ran = true;
        }
      }

      if (triggerGestureRef.current === triggerName && regexRef.current) {
        mutateAndEvaluate((c) => applyRegexMutation(c, regexRef.current, replacementRef.current));
        ran = true;
      }

      if (!ran) mutateAndEvaluate(defaultMutator);
    };
  }

  // useCallback with [] deps is intentional: all mutable values are read via refs.
  const handleMouthOpen = useCallback(makeGestureHandler('mouthOpen', cycleHiHat), []);
  const handleHeadTiltLeft = useCallback(makeGestureHandler('headTiltLeft', (c) => shiftTranspose(c, -2)), []);
  const handleHeadTiltRight = useCallback(makeGestureHandler('headTiltRight', (c) => shiftTranspose(c, 2)), []);

  const { videoRef, canvasRef, status, detectedGesture } = useFacialGestures({
    enabled,
    onPlay: () => { if (!startedRef.current) handleTogglePlay(); },
    onStop: () => { if (startedRef.current) handleTogglePlay(); },
    onMouthOpen: handleMouthOpen,
    onHeadTiltLeft: handleHeadTiltLeft,
    onHeadTiltRight: handleHeadTiltRight,
  });

  return (
    <>
      <button
        onClick={() => setEnabled((v) => !v)}
        title={
          enabled
            ? 'disable facial control'
            : 'enable facial control — blink to play/stop, open mouth or tilt head to mutate code, head cursor for StrudelButton widgets'
        }
        className={cx('px-2 hover:opacity-50 flex items-center', enabled && 'text-green-400')}
        aria-pressed={enabled}
      >
        <CameraIcon />
      </button>

      {/* Head cursor — always mounted when enabled so the RAF can reference it */}
      {enabled && (
        <div
          ref={cursorElRef}
          style={{
            position: 'fixed',
            display: 'none',
            pointerEvents: 'none',
            zIndex: 9999,
            transform: 'translate(-50%, -50%)',
          }}
          aria-hidden="true"
        >
          <svg width={RING_R * 2 + 8} height={RING_R * 2 + 8} viewBox={`0 0 ${RING_R * 2 + 8} ${RING_R * 2 + 8}`}>
            {/* Inner dot */}
            <circle cx={RING_R + 4} cy={RING_R + 4} r="4" fill="rgba(255,255,255,0.85)" />
            {/* Dwell progress ring */}
            <circle
              ref={progressRingRef}
              cx={RING_R + 4}
              cy={RING_R + 4}
              r={RING_R}
              fill="none"
              stroke="#ffcc00"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${RING_C} ${RING_C}`}
              strokeDashoffset={RING_C}
              transform={`rotate(-90 ${RING_R + 4} ${RING_R + 4})`}
            />
          </svg>
        </div>
      )}

      {enabled && (
        <div className="fixed bottom-12 right-4 z-50 rounded border border-muted bg-background text-foreground p-2 text-xs space-y-1.5 shadow-lg select-none w-56">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">facial control</span>
            <span className={cx(STATUS_COLOR[status] ?? 'text-muted')}>{status}</span>
          </div>

          {/* Mirror the feed so left/right match the performer's perspective */}
          <div className="relative w-full">
            <video
              ref={videoRef}
              className="w-full rounded block"
              style={{ transform: 'scaleX(-1)' }}
              muted
              playsInline
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full rounded pointer-events-none"
              style={{ transform: 'scaleX(-1)' }}
            />
          </div>

          {detectedGesture && (
            <div
              className={cx(
                'text-center font-bold py-0.5 transition-opacity',
                detectedGesture === 'play'
                  ? 'text-green-400'
                  : detectedGesture === 'stop'
                    ? 'text-red-400'
                    : 'text-yellow-400',
              )}
            >
              {GESTURE_LABELS[detectedGesture] ?? detectedGesture}
            </div>
          )}

          <div className="space-y-0.5" style={{ color: 'var(--muted)' }}>
            <div>blink both eyes → play</div>
            <div>raise eyebrows → stop</div>
            <div>open mouth → drum density</div>
            <div>tilt head → transpose ±2</div>
            <div>head cursor dwell → StrudelButton</div>
          </div>

          <div className="border-t border-muted pt-1.5 space-y-1">
            <div className="font-medium">regex mutator</div>
            <select
              className="w-full bg-background border border-muted rounded px-1 py-0.5 text-xs"
              value={triggerGesture}
              onChange={(e) => setTriggerGesture(e.target.value)}
            >
              <option value="mouthOpen">mouth open</option>
              <option value="headTiltLeft">head tilt left</option>
              <option value="headTiltRight">head tilt right</option>
            </select>
            <input
              className="w-full bg-background border border-muted rounded px-1 py-0.5 font-mono"
              placeholder="regex pattern"
              value={regex}
              onChange={(e) => setRegex(e.target.value)}
              spellCheck={false}
            />
            <input
              className="w-full bg-background border border-muted rounded px-1 py-0.5 font-mono"
              placeholder="replacement"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              spellCheck={false}
            />
            <div style={{ color: 'var(--muted)', lineHeight: '1.4' }}>
              or annotate code:
              <br />
              <code className="font-mono break-all" style={{ fontSize: '9px' }}>
                {`/* @mediapipe {"trigger":"mouthOpen","action":"regex-swap","regex":"bd","replacement":"sd"} */`}
              </code>
            </div>
          </div>

          <div className="border-t border-muted pt-1.5 space-y-0.5">
            <div className="font-medium">StrudelButton</div>
            <div style={{ color: 'var(--muted)', lineHeight: '1.4' }}>
              write in code:
              <br />
              <code className="font-mono block" style={{ fontSize: '9px' }}>
                {`*bass: note("c2").s('bass')`}
              </code>
              dwell with head cursor (1 s) to append/toggle that voice.
            </div>
          </div>

          <div className="border-t border-muted pt-1.5 space-y-0.5" style={{ color: 'var(--muted)' }}>
            <div className="font-medium text-foreground">window.faceCtx</div>
            <code className="font-mono block" style={{ fontSize: '9px' }}>
              {`.gain(() => window.faceCtx.jawOpen)`}
            </code>
            <div>jawOpen, browInnerUp, headTilt,</div>
            <div>eyeBlinkL/R, mouthSmileL/R,</div>
            <div>cursorX, cursorY</div>
          </div>
        </div>
      )}
    </>
  );
}

function CameraIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="w-5 h-5"
      aria-hidden="true"
    >
      <path d="M12 9a3.75 3.75 0 1 0 0 7.5A3.75 3.75 0 0 0 12 9Z" />
      <path
        fillRule="evenodd"
        d="M9.344 3.071a49.52 49.52 0 0 1 5.312 0c.967.052 1.83.585 2.332 1.39l.821 1.317c.24.383.645.643 1.11.71.386.054.77.113 1.152.177 1.432.239 2.429 1.493 2.429 2.909V18a3 3 0 0 1-3 3h-15a3 3 0 0 1-3-3V9.574c0-1.416.997-2.67 2.429-2.909.382-.064.766-.123 1.151-.178a1.56 1.56 0 0 0 1.11-.71l.822-1.315a2.942 2.942 0 0 1 2.332-1.39ZM6.75 12.75a5.25 5.25 0 1 1 10.5 0 5.25 5.25 0 0 1-10.5 0Zm12-1.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
