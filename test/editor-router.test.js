import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyEditor,
  applyRegexMutation,
  toggleJPatternSnippet,
  parseJPatternButtons,
  participantTokensIn,
  isJPatternSnippetActive,
  toggleLineComment,
  JP_BTN_MARKER
} from '../src/editor-router-core.js';

test('editor classification: JPattern card wins over the shared ts-code class', () => {
  assert.equal(classifyEditor(['ts-code', 'jp-code']), 'jpattern');
  assert.equal(classifyEditor(['ts-code']), 'strudel');
  assert.equal(classifyEditor(['something-else']), null);
  assert.equal(classifyEditor([]), null);
  assert.equal(classifyEditor(null), null);
});

test('regex mutators apply globally to metaprogram text and never throw', () => {
  const program = '$ participants <0 1 0 2>\n# cycles wcl\n';
  assert.equal(
    applyRegexMutation(program, '\\b0\\b', '3'),
    '$ participants <3 1 3 2>\n# cycles wcl\n'
  );
  assert.equal(applyRegexMutation(program, 'cycles wcl', 'cycles wcpl'),
    '$ participants <0 1 0 2>\n# cycles wcpl\n');
  // Invalid pattern → unchanged, no throw mid-performance.
  assert.equal(applyRegexMutation(program, '([', 'x'), program);
  // Empty replacement deletes.
  assert.equal(applyRegexMutation('a # noise b', ' # noise', ''), 'a b');
});

test('JPatternButton snippet toggling: add → comment → reactivate', () => {
  const base = '$ participants <0 1>\n# cycles wcl';
  const snippet = '# room 2 3';
  const added = toggleJPatternSnippet(base, snippet);
  assert.equal(added, `${base}\n${snippet}${JP_BTN_MARKER}`);
  const commented = toggleJPatternSnippet(added, snippet);
  assert.ok(commented.includes(`\n// ${snippet}${JP_BTN_MARKER}`));
  const reactivated = toggleJPatternSnippet(commented, snippet);
  assert.equal(reactivated, added);
  // Empty doc: snippet lands on its own line.
  assert.equal(toggleJPatternSnippet('', snippet), `\n${snippet}${JP_BTN_MARKER}`);
});

// --- `*` button declarations -------------------------------------------------

test('button declarations are read off `*$` / `*#` lines, in source order', () => {
  const text = [
    '$ participants <0 2a>',
    '*$ participants <2a 2b>',
    '# cycles "wcl" 20',
    '  *  # crush "wcl" 2  // annotates the declaration, not the statement',
    '// *# noise "wcl" 3   — commented out, so no button',
    '*$ participants <2a 2b>' // the same statement twice is one button
  ].join('\n');

  const buttons = parseJPatternButtons(text);
  assert.deepEqual(buttons.map(b => b.snippet), ['$ participants <2a 2b>', '# crush "wcl" 2']);
  // A voice is labelled by its sequence — 'participants' on every one of them
  // would say nothing.
  assert.deepEqual(buttons.map(b => b.label), ['<2a 2b>', 'crush "wcl" 2']);
  // 2a is already in the ring but 2b is not, so the voice is not yet in force.
  assert.deepEqual(buttons.map(b => b.active), [false, false]);
  assert.deepEqual(parseJPatternButtons(''), []);
});

test('a commented declaration writes the statement, not the comment', () => {
  const text = '$ participants <0>\n*$ participants <1> // bring the guitarist in\n';
  const [button] = parseJPatternButtons(text);
  assert.equal(button.snippet, '$ participants <1>');
  assert.match(toggleJPatternSnippet(text, button.snippet), /\$ participants <0 1>/);
});

test('a `*$` voice merges into the one scheduling sequence, both ways', () => {
  const declared = '$ participants <0 1>\n*$ participants <2a 2b>\n# cycles "wcl" 20\n';
  const snippet = '$ participants <2a 2b>';
  assert.deepEqual(participantTokensIn(snippet), ['2a', '2b']);
  assert.equal(participantTokensIn('# crush "wcl" 2'), null);

  // On: the tokens join the live sequence — NOT a second `$ participants`
  // statement, which the language rejects as a duplicate.
  const on = toggleJPatternSnippet(declared, snippet);
  assert.match(on, /\$ participants <0 1 2a 2b>/);
  assert.equal(on.match(/^\$ participants/mg).length, 1);
  assert.equal(isJPatternSnippetActive(on, snippet), true);
  // The declaration survives, so the button is still there to press again.
  assert.match(on, /^\*\$ participants <2a 2b>$/m);

  // Off: only the declared tokens leave.
  const off = toggleJPatternSnippet(on, snippet);
  assert.match(off, /\$ participants <0 1>/);
  assert.equal(isJPatternSnippetActive(off, snippet), false);

  // Half-on (one token already listed) counts as off, and turning it on adds
  // only what is missing.
  const half = '$ participants <0 2a>\n*$ participants <2a 2b>\n';
  assert.equal(isJPatternSnippetActive(half, snippet), false);
  assert.match(toggleJPatternSnippet(half, snippet), /\$ participants <0 2a 2b>/);
});

test('a `*$` voice button works in a mini-notation metaprogram too', () => {
  const mini = "'metaprogram editor'\n$: participants(\"<0 1>\").cycles(\"wcl\", 20)\n*$: participants(\"<2a 2b>\")\n";
  const [btn] = parseJPatternButtons(mini);
  assert.equal(btn.snippet, '$ participants <2a 2b>');           // scanned as the mondo form
  assert.equal(isJPatternSnippetActive(mini, btn.snippet), false);

  // Toggling on merges the tokens into the live sequence and hands the buffer
  // BACK in mini notation — never a mix.
  const on = toggleJPatternSnippet(mini, btn.snippet);
  assert.match(on, /\$: participants\("<0 1 2a 2b>"\)/);
  assert.doesNotMatch(on, /^\s*#\s/m);                            // no stray mondo line
  assert.equal(isJPatternSnippetActive(on, btn.snippet), true);

  const off = toggleJPatternSnippet(on, btn.snippet);
  assert.match(off, /\$: participants\("<0 1>"\)/);
});

test('a `*$` voice with no sequence to merge into becomes the sequence', () => {
  const snippet = '$ participants <0 1>';
  const on = toggleJPatternSnippet('# cycles "wcl" 20', snippet);
  // Written plain, not marked: from here it is an ordinary statement that this
  // same button edits token by token.
  assert.equal(on, `# cycles "wcl" 20\n${snippet}\n`);
  assert.equal(isJPatternSnippetActive(on, snippet), true);
  assert.equal(toggleJPatternSnippet('', snippet), `${snippet}\n`);

  // Turning it off empties the ring — invalid, and the editor says so, but
  // recoverable: pressing again puts the voice straight back.
  const off = toggleJPatternSnippet(on, snippet);
  assert.match(off, /\$ participants <>/);
  assert.equal(isJPatternSnippetActive(off, snippet), false);
  assert.match(toggleJPatternSnippet(off, snippet), /\$ participants <0 1>/);
});

test('two voice buttons over one sequence stay independently reversible', () => {
  // The state machine has to survive being driven from an empty program by
  // more than one button — that is where an ownership rule based on which
  // button wrote the line would strand them both.
  const a = '$ participants <0 1>';
  const b = '$ participants <2a>';
  let text = toggleJPatternSnippet('# cycles "wcl" 20', a);
  text = toggleJPatternSnippet(text, b);
  assert.match(text, /\$ participants <0 1 2a>/);
  assert.deepEqual([isJPatternSnippetActive(text, a), isJPatternSnippetActive(text, b)], [true, true]);

  text = toggleJPatternSnippet(text, a);
  assert.match(text, /\$ participants <2a>/);
  assert.deepEqual([isJPatternSnippetActive(text, a), isJPatternSnippetActive(text, b)], [false, true]);

  text = toggleJPatternSnippet(text, a);
  assert.match(text, /\$ participants <2a 0 1>/);
  assert.equal(text.match(/^[ \t]*\$ participants/mg).length, 1);
});

test('declarations and commented-out lines are never mistaken for the program', () => {
  // A declaration written ABOVE the live statement — the roster helpers match
  // the first `$ participants` in the text, so an unanchored one edits the
  // declaration and reports the button on before it is ever pressed.
  const snippet = '$ participants <2a 2b>';
  const text = `*${snippet}\n$ participants <0 1>\n# cycles "wcl" 20\n`;
  assert.equal(parseJPatternButtons(text)[0].active, false);
  assert.match(toggleJPatternSnippet(text, snippet), /^\$ participants <0 1 2a 2b>$/m);
  assert.match(toggleJPatternSnippet(text, snippet), /^\*\$ participants <2a 2b>$/m);

  // A commented-out sequence is not a sequence.
  const commented = '// $ participants <0 1>\n# cycles "wcl" 20\n';
  assert.equal(isJPatternSnippetActive(commented, '$ participants <0 1>'), false);
  assert.match(toggleJPatternSnippet(commented, snippet), /^\$ participants <2a 2b>$/m);
});

test('a `$` declaration with no sequence declares nothing there is a button for', () => {
  assert.deepEqual(parseJPatternButtons('$ participants <0>\n*$ participants\n'), []);
  assert.deepEqual(parseJPatternButtons('$ participants <0>\n*$\n'), []);
  assert.deepEqual(parseJPatternButtons('$ participants <0>\n*#\n'), []);
});

test('a voice keeps its modifiers through both halves of the toggle', () => {
  const declared = '$ participants <0>\n*$ participants <1@2>\n';
  const snippet = '$ participants <1@2>';
  const on = toggleJPatternSnippet(declared, snippet);
  assert.match(on, /\$ participants <0 1@2>/);
  assert.equal(isJPatternSnippetActive(on, snippet), true);
  assert.match(toggleJPatternSnippet(on, snippet), /\$ participants <0>/);
});

// --- Ctrl+/ line-comment toggle ---------------------------------------------

test('toggleLineComment: collapsed cursor comments/uncomments just the current line', () => {
  const r1 = toggleLineComment('a\nb\nc', 2, 2);
  assert.equal(r1.value, 'a\n// b\nc');
  const r2 = toggleLineComment(r1.value, r1.selectionStart, r1.selectionEnd);
  assert.equal(r2.value, 'a\nb\nc');
  assert.equal(r2.selectionStart, 2);
  assert.equal(r2.selectionEnd, 2);
});

test('toggleLineComment: comments every line a multi-line selection touches, preserving indentation', () => {
  const text = '  foo\n  bar\nbaz';
  const r = toggleLineComment(text, 0, text.length);
  assert.equal(r.value, '  // foo\n  // bar\n// baz');
  // Selection remaps to cover the whole (now-commented) block.
  assert.equal(r.value.slice(r.selectionStart, r.selectionEnd), r.value);
  const back = toggleLineComment(r.value, r.selectionStart, r.selectionEnd);
  assert.equal(back.value, text);
});

test('toggleLineComment: a selection ending at column 0 of the next line excludes that line', () => {
  const text = 'a\nb\nc\nd';
  const r = toggleLineComment(text, 0, 6); // ends right before 'd', at col 0
  assert.equal(r.value, '// a\n// b\n// c\nd');
  // The remapped selection still doesn't reach into 'd'.
  assert.equal(r.value.slice(r.selectionStart, r.selectionEnd), '// a\n// b\n// c\n');
});

test('toggleLineComment: comments (not uncomments) when only some touched lines are already commented', () => {
  const mixed = '// a\nb';
  const r = toggleLineComment(mixed, 0, mixed.length);
  assert.equal(r.value, '// // a\n// b');
});

test('toggleLineComment: blank lines are left alone and ignored by the uncomment-eligibility check', () => {
  const text = '// a\n\n// b';
  const r = toggleLineComment(text, 0, text.length);
  assert.equal(r.value, 'a\n\nb');
});
