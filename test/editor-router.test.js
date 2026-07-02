import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyEditor,
  applyRegexMutation,
  toggleNetCyclesSnippet,
  NC_BTN_MARKER
} from '../src/editor-router-core.js';

test('editor classification: NetCycles card wins over the shared ts-code class', () => {
  assert.equal(classifyEditor(['ts-code', 'nc-code']), 'netcycles');
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
  assert.equal(applyRegexMutation(program, 'cycles wcl', 'cycles wcj'),
    '$ participants <0 1 0 2>\n# cycles wcj\n');
  // Invalid pattern → unchanged, no throw mid-performance.
  assert.equal(applyRegexMutation(program, '([', 'x'), program);
  // Empty replacement deletes.
  assert.equal(applyRegexMutation('a # noise b', ' # noise', ''), 'a b');
});

test('NetCyclesButton snippet toggling: add → comment → reactivate', () => {
  const base = '$ participants <0 1>\n# cycles wcl';
  const snippet = '# room 2 3';
  const added = toggleNetCyclesSnippet(base, snippet);
  assert.equal(added, `${base}\n${snippet}${NC_BTN_MARKER}`);
  const commented = toggleNetCyclesSnippet(added, snippet);
  assert.ok(commented.includes(`\n// ${snippet}${NC_BTN_MARKER}`));
  const reactivated = toggleNetCyclesSnippet(commented, snippet);
  assert.equal(reactivated, added);
  // Empty doc: snippet lands on its own line.
  assert.equal(toggleNetCyclesSnippet('', snippet), `\n${snippet}${NC_BTN_MARKER}`);
});
