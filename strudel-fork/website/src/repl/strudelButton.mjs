/*
strudelButton.mjs - Global StrudelButton class for use inside Strudel patterns
Copyright (C) 2025 Strudel contributors

Usage in the REPL (preferred shorthand — transpiler rewrites this automatically):
  *bass: note("c2 f2").s('bass')

Explicit form (also valid):
  new StrudelButton("bass: note('c2 f2').s('bass')")

The CodeMirror plugin (strudel-button.mjs) renders the inline widget by scanning the source text.
This file just needs to define the class in globalThis so eval doesn't throw when the line executes.
*/

let registered = false;

export function initStrudelButton() {
  if (registered || typeof window === 'undefined') return;
  registered = true;

  // Extend HTMLButtonElement so instanceof checks work and the DOM element
  // is a real button (accessible, focusable).
  class StrudelButton extends HTMLButtonElement {
    constructor(code) {
      super();
      this._strudelCode = code;
      // The CodeMirror plugin renders the visual widget; this DOM element is
      // never actually inserted into the document during pattern evaluation.
    }
  }

  try {
    customElements.define('strudel-button', StrudelButton, { extends: 'button' });
  } catch {
    // Already registered (hot reload) or not supported (Safari) — both are fine.
  }

  globalThis.StrudelButton = StrudelButton;
}
