// # breakout / # assign directive parsing (breakout-core.js owns the JSON
// literal shape and the fold-into-state logic; this file is purely about the
// grammar — tokenizing, dispatch, and error messages).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMetaprogram } from './helpers/metaprogram.js';

test('# breakout parses a room with participants', () => {
  const res = parseMetaprogram(
    '$ participants <0 1>\n' +
    `# breakout '{"name":"Room A","participants":["0","1"]}'\n`
  );
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.deepEqual(res.ast.breakouts, [{ name: 'Room A', participants: ['0', '1'] }]);
});

test('# breakout is repeatable — several lines declare several rooms', () => {
  const res = parseMetaprogram(
    '$ participants <0 1 2>\n' +
    `# breakout '{"name":"Room A"}'\n` +
    `# breakout '{"name":"Room B","participants":["2"]}'\n`
  );
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.equal(res.ast.breakouts.length, 2);
  assert.equal(res.ast.breakouts[0].name, 'Room A');
  assert.equal(res.ast.breakouts[1].name, 'Room B');
});

test('# breakout requires a single-quoted string, not a bare or double-quoted one', () => {
  const bare = parseMetaprogram('$ participants <0>\n# breakout Room A\n');
  assert.equal(bare.valid, false);
  assert.ok(bare.errors.some(e => /single-quoted JSON/.test(e.message)));

  const dq = parseMetaprogram('$ participants <0>\n# breakout "not json"\n');
  assert.equal(dq.valid, false);
});

test('# breakout surfaces a bad JSON literal as a parse error, with position', () => {
  const res = parseMetaprogram(`$ participants <0>\n# breakout 'not json'\n`);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => /not valid JSON/.test(e.message)));
  // Line 3: the helper prepends its own 'metaprogram editor' line first.
  assert.equal(res.errors[0].line, 3);
});

test('# breakout rejects the reserved "main" room name', () => {
  const res = parseMetaprogram(`$ participants <0>\n# breakout '{"name":"main"}'\n`);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => /reserved/.test(e.message)));
});

test('# breakout takes exactly one argument', () => {
  const res = parseMetaprogram(`$ participants <0>\n# breakout '{"name":"A"}' 'extra'\n`);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => /exactly one argument/.test(e.message)));
});

test('# assign moves a participant into a room, quoted strings both required', () => {
  const res = parseMetaprogram('$ participants <0 1>\n# assign "0" "Room A"\n');
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.deepEqual(res.ast.assignments, [{ token: '0', room: 'Room A' }]);
});

test('# assign is repeatable and order-sensitive', () => {
  const res = parseMetaprogram(
    '$ participants <0>\n# assign "0" "Room A"\n# assign "0" "main"\n'
  );
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.deepEqual(res.ast.assignments, [{ token: '0', room: 'Room A' }, { token: '0', room: 'main' }]);
});

test('# assign rejects a missing second argument', () => {
  const res = parseMetaprogram('$ participants <0>\n# assign "0"\n');
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => /assign needs a quoted room name/.test(e.message)));
});

test('the single-quote delimiter survives a JSON blob with several internal double quotes', () => {
  // The whole point of the single-quote delimiter: a double-quoted token
  // would terminate at the very first '"' inside the JSON (right after the
  // opening brace); every test above already relies on this working, but
  // this one has enough internal quotes (5 pairs) to make the point plainly.
  const res = parseMetaprogram(
    '$ participants <0 1 2>\n' +
    `# breakout '{"name":"Room A","participants":["0","1","2"]}'\n`
  );
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.deepEqual(res.ast.breakouts[0], { name: 'Room A', participants: ['0', '1', '2'] });
});
