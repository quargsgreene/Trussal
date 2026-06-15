/*
strudel-button.mjs - Inline CodeMirror widget for StrudelButton head-cursor targets
Copyright (C) 2025 Strudel contributors
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
*/

import { Decoration, EditorView, WidgetType, ViewPlugin } from '@codemirror/view';

// Matches: new StrudelButton("...") / new StrudelButton('...') / new StrudelButton(`...`)
const BUTTON_RE = /new\s+StrudelButton\((['"`])([\s\S]*?)\1\)/g;

// Matches: *name: code  (shorthand syntax — transpiler rewrites this to new StrudelButton(...))
const STARRED_VOICE_RE = /^\*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(.+)$/mg;

class StrudelButtonWidget extends WidgetType {
  constructor(code) {
    super();
    this.code = code;
  }

  eq(other) {
    return other instanceof StrudelButtonWidget && this.code === other.code;
  }

  toDOM() {
    const btn = document.createElement('button');
    btn.className = 'cm-strudel-btn strudel-head-btn';
    btn.dataset.strudelCode = this.code;
    const label = this.code.length > 22 ? this.code.slice(0, 22) + '…' : this.code;
    btn.textContent = `▶ ${label}`;
    btn.title = `StrudelButton — dwell with head cursor to toggle`;
    return btn;
  }

  // Allow pointer events so getBoundingClientRect is reliable and the element is hoverable.
  ignoreEvent() {
    return false;
  }
}

export const strudelButtonPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.buildDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view) {
      const widgets = [];
      const text = view.state.doc.toString();
      let m;

      BUTTON_RE.lastIndex = 0;
      while ((m = BUTTON_RE.exec(text)) !== null) {
        const code = m[2];
        const pos = m.index + m[0].length;
        widgets.push(Decoration.widget({ widget: new StrudelButtonWidget(code), side: 1 }).range(pos));
      }

      // *name: code shorthand — button code stored as "name: code" so dwell-toggle
      // appends a properly-labelled voice declaration.
      STARRED_VOICE_RE.lastIndex = 0;
      while ((m = STARRED_VOICE_RE.exec(text)) !== null) {
        const code = `${m[1]}: ${m[2].trim()}`;
        const pos = m.index + m[0].length;
        widgets.push(Decoration.widget({ widget: new StrudelButtonWidget(code), side: 1 }).range(pos));
      }

      return Decoration.set(widgets, true);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Global object of EMA-smoothed face metrics updated every animation frame when the camera is active.
 * Enable the camera by clicking the camera icon in the REPL header.
 * All values are initialised to 0 at page load — safe to read before the camera starts.
 * Because updates happen in the animation frame (not the audio clock), reading inside pattern
 * callbacks never affects audio timing.
 *
 * Properties (all numbers):
 * - `jawOpen` 0–1: how wide the mouth is open
 * - `browInnerUp` 0–1: inner eyebrow raise
 * - `headTilt` −1–1: head roll (negative = left, positive = right)
 * - `eyeBlinkLeft` 0–1: left-eye closure
 * - `eyeBlinkRight` 0–1: right-eye closure
 * - `mouthSmileLeft` 0–1: left-side smile depth
 * - `mouthSmileRight` 0–1: right-side smile depth
 * - `cursorX`: head cursor X in viewport pixels (derived from forehead landmark, mirrored)
 * - `cursorY`: head cursor Y in viewport pixels
 * @name faceCtx
 * @tags face_control external_io
 * @example
 * // jaw open controls gain — open your mouth to bring drums up
 * $: s("bd sd hh cp").gain(() => window.faceCtx.jawOpen)
 * @example
 * // eyebrow raise sweeps a low-pass filter
 * $: note("c3").s("supersaw").lpf(() => 300 + window.faceCtx.browInnerUp * 5000)
 * @example
 * // head tilt controls stereo pan
 * $: s("tabla").note("<c3 e3 g3>").pan(() => 0.5 + window.faceCtx.headTilt * 0.45)
 */

/**
 * Renders an inline head-cursor button widget in the REPL editor.
 *
 * **Preferred syntax** — put an asterisk before a voice name:
 * ```
 * *voiceName: <pattern code>
 * ```
 * The transpiler rewrites this to `new StrudelButton('voiceName: <code>')` before evaluation,
 * so the line is syntactically valid and the button widget appears inline.
 *
 * **Explicit syntax** (still supported):
 * ```
 * new StrudelButton("code")
 * ```
 *
 * With the camera active, hover the head cursor over the button for 1 second to toggle:
 * - 1st dwell: appends `voiceName: code` at the bottom of the editor and re-evaluates
 * - 2nd dwell: comments out the appended line and re-evaluates
 * - 3rd dwell: uncomments the line and re-evaluates (repeats indefinitely)
 *
 * You must move the cursor away and return before a second toggle fires (rising-edge latch).
 * @name StrudelButton
 * @param {string} code Valid Strudel pattern code to append/toggle on dwell.
 * @tags face_control external_io
 * @example
 * // Fixed rhythm; bass line toggled by head cursor:
 * $: s("bd sd hh*2 cp").bank("tr909")
 * *bass: note('<c2 f2 g2 bb2>').s('bass').dec(0.3).gain(0.8)
 */

/**
 * In-code annotation that binds a regex mutation to a face gesture.
 * Place a block comment anywhere in the editor with this JSON body:
 *
 *   trigger      — "mouthOpen" | "headTiltLeft" | "headTiltRight"
 *   action       — must be "regex-swap"
 *   regex        — JS regex string applied globally to the editor buffer
 *   replacement  — replacement string (supports $1, $& etc.) — defaults to ""
 *
 * When the gesture fires the replacement is applied and the code re-evaluates.
 * Multiple annotations may coexist; all matching ones run on the same gesture event.
 * The annotation fires before the custom UI regex mutator and before the hardcoded macro preset.
 * @name mediapipeAnnotation
 * @tags face_control
 * @example
 * // Write this as a block comment in your code (slash-star ... star-slash):
 * // @mediapipe { "trigger": "mouthOpen", "action": "regex-swap", "regex": "\\bbd\\b", "replacement": "sd" }
 * $: s("bd sd hh")
 * @example
 * // Head tilt right forces a fixed transpose:
 * // @mediapipe { "trigger": "headTiltRight", "action": "regex-swap", "regex": "\\.transpose\\(-?\\d+\\)", "replacement": ".transpose(7)" }
 * $: note("c3 e3 g3").s("supersaw").transpose(0)
 */

export const strudelButtonTheme = EditorView.baseTheme({
  '.cm-strudel-btn': {
    display: 'inline-block',
    padding: '1px 6px',
    marginLeft: '6px',
    borderRadius: '3px',
    border: '1px solid #4a5568',
    background: 'transparent',
    color: '#7dcfff',
    fontSize: '11px',
    fontFamily: 'monospace',
    cursor: 'default',
    userSelect: 'none',
    verticalAlign: 'middle',
    lineHeight: '1.6',
    transition: 'border-color 0.15s, color 0.15s',
  },
  '.cm-strudel-btn.strudel-dwell-hover': {
    borderColor: '#ffcc00',
    color: '#ffcc00',
  },
  '.cm-strudel-btn.strudel-btn-active': {
    borderColor: '#68d391',
    color: '#68d391',
  },
});
