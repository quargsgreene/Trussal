import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANGUAGES,
  getLanguage,
  toRoomPattern,
  lineCommentFor,
  bridgeFrames,
  bridgeStopFrame,
  sonicPiStopCode,
  encodeOscMessage,
  BRIDGE_LANGUAGES,
} from '../src/editor-languages-core.js';
import { readDirective } from '../src/program-directive.js';
import { splitHydraCode } from '../src/hydra-code.js';
import { toggleLineComment } from '../src/editor-router-core.js';

test('editor-languages-core: every language in the dropdown is listed once, JPattern first', () => {
  const ids = LANGUAGES.map(l => l.id);
  assert.equal(ids[0], 'jpattern');
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['strudel', 'hydra', 'sonicpi', 'tidal', 'punctual', 'sclang', 'renardo', 'textmode', 'zwirn', 'sardine']) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(getLanguage('nope').id, 'jpattern');
});

test('editor-languages-core: every bridge language has framing, and only those', () => {
  const bridged = LANGUAGES.filter(l => l.runs === 'bridge').map(l => l.id).sort();
  assert.deepEqual(Object.keys(BRIDGE_LANGUAGES).sort(), bridged);
});

test('editor-languages-core: pure Strudel travels as a personal editor program', () => {
  const room = toRoomPattern('strudel', getLanguage('strudel').starter);
  assert.equal(readDirective(room).kind, 'personal');
  assert.match(room, /\$: s\("bd\*2, ~ hh\*2"\)/);
  // Already-tagged buffers are not double-tagged.
  assert.equal(toRoomPattern('strudel', room).match(/personal editor/g).length, 1);
});

test('editor-languages-core: pure Hydra becomes a Hydra-only block, blank lines and all', () => {
  const room = toRoomPattern('hydra', 'osc(10).out(o1)\n\nsrc(o1).kaleid().out()\n');
  assert.equal(readDirective(room).kind, 'personal');
  const split = splitHydraCode(room);
  assert.ok(split, 'is Hydra');
  assert.equal(split.strudel, '', 'nothing is left over for Strudel');
  assert.match(split.preamble, /src\(o1\)\.kaleid\(\)\.out\(\)/);
  // A performer who wrote initHydra themselves gets one, not two.
  assert.equal(toRoomPattern('hydra', 'await initHydra()\nosc().out()').match(/initHydra/g).length, 1);
});

test('editor-languages-core: languages that do not run in the room have no room pattern', () => {
  for (const id of ['tidal', 'punctual', 'textmode']) assert.equal(toRoomPattern(id, 'x'), null);
  assert.equal(toRoomPattern('jpattern', "'personal editor'\nx"), "'personal editor'\nx");
});

test('editor-languages-core: Tidal and zwirn evaluate one :{ :} block', () => {
  assert.equal(bridgeFrames('tidal', 'd1 $ s "bd"\n\nd2 $ s "hh"\n'), ':{\nd1 $ s "bd"\n\nd2 $ s "hh"\n:}\n');
  assert.equal(bridgeFrames('zwirn', '1 $: s "kick"'), ':{\n1 $: s "kick"\n:}\n');
  assert.equal(bridgeStopFrame('tidal'), 'hush\n');
});

test('editor-languages-core: sclang evaluates up to a form feed', () => {
  assert.equal(bridgeFrames('sclang', 's.boot;\r\n'), 's.boot;\n\x0c');
  assert.match(bridgeStopFrame('sclang'), /CmdPeriod\.run;\n\x0c$/);
});

test('editor-languages-core: Renardo runs once, not once per paragraph', () => {
  assert.equal(bridgeFrames('renardo', 'p1 >> pluck()\n\nd1 >> play("x-")'), 'p1 >> pluck()\nd1 >> play("x-")\n\n');
});

test('editor-languages-core: Sardine gets a blank line where an indented block ends', () => {
  const code = '@swim\ndef baba(p=0.5, i=0):\n    D("bd")\n\n    again(baba, p=0.5, i=i+1)\nPa >> d("cp")';
  assert.equal(
    bridgeFrames('sardine', code),
    '@swim\ndef baba(p=0.5, i=0):\n    D("bd")\n    again(baba, p=0.5, i=i+1)\n\nPa >> d("cp")\n\n',
  );
});

test('editor-languages-core: Sonic Pi Stop names the loops the last buffer started', () => {
  const code = 'live_loop :beat do\n  sample :bd_haus\n  sleep 0.5\nend\nlive_loop :bass do\n  play 40\n  sleep 1\nend\n';
  assert.equal(sonicPiStopCode(code), 'live_loop :beat do\n  stop\nend\nlive_loop :bass do\n  stop\nend');
  assert.equal(bridgeStopFrame('sonicpi', code), sonicPiStopCode(code));
  assert.equal(sonicPiStopCode('play 60'), null);
});

test('editor-languages-core: OSC messages are 4-byte aligned with a string type tag', () => {
  const msg = encodeOscMessage('/trussal/run', ['play 60']);
  assert.equal(msg.length % 4, 0);
  const text = new TextDecoder().decode(msg);
  assert.ok(text.startsWith('/trussal/run\0'));
  assert.ok(text.includes(',s\0\0'));
  assert.ok(text.includes('play 60\0'));
});

test('editor-languages-core: Ctrl+/ uses each language\'s own comment', () => {
  assert.equal(lineCommentFor('tidal'), '--');
  assert.equal(lineCommentFor('sonicpi'), '#');
  assert.equal(lineCommentFor('jpattern'), '//');
  assert.equal(toggleLineComment('d1 $ s "bd"', 0, 0, '--').value, '-- d1 $ s "bd"');
  assert.equal(toggleLineComment('# play 60', 0, 0, '#').value, 'play 60');
  assert.equal(toggleLineComment('a', 0, 0).value, '// a');
});
