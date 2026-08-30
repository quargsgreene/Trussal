// Explicit undo/redo history for the `.ts-code` textareas.
//
// The browser's native undo stack only records keystrokes that go through
// real user typing (or execCommand). Two things in this app bypass that: the
// on-screen keyboard (head-cursor dwell) splices `.value` directly, and the
// remote/JPattern editors periodically overwrite `.value` from live peer
// state. Both leave native Ctrl+Z with nothing to undo, so history is tracked
// here instead, keyed off the 'input' event (which fires for both real
// typing and the on-screen keyboard's dispatched Event('input'), but not for
// a silent external `.value` assignment).

const HISTORY_LIMIT = 200;
const handles = new WeakMap();

function snapshot(ta) {
  return { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
}

export function attachUndoHistory(ta) {
  const undo = [];
  const redo = [];
  let last = snapshot(ta);
  let restoring = false;

  ta.addEventListener('input', () => {
    if (restoring) return;
    undo.push(last);
    if (undo.length > HISTORY_LIMIT) undo.shift();
    redo.length = 0;
    last = snapshot(ta);
  });

  ta.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    const [from, to] = e.shiftKey ? [redo, undo] : [undo, redo];
    const state = from.pop();
    if (!state) return;
    to.push(last);
    restoring = true;
    ta.value = state.value;
    ta.setSelectionRange(state.selStart, state.selEnd);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    restoring = false;
    last = state;
  });

  handles.set(ta, { resetBaseline: () => { last = snapshot(ta); } });
}

// Call after any programmatic `.value` overwrite that a live sync (not the
// user) is responsible for, so the next undo doesn't jump back past it.
export function resetUndoBaseline(ta) {
  handles.get(ta)?.resetBaseline();
}
