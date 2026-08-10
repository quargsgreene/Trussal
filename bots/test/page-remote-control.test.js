import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageRemoteControl } from '../src/bot/page-scripts.js';
import { INIT_HYDRA_PATTERN } from '../../src/hydra-code.js';
import { INIT_TEXT_CYCLES_PATTERN } from '../../src/text-cycles-core.js';

/**
 * Runs the page-side operator-control listener outside a browser: a fake
 * `document` that records listeners so tests can dispatch by hand, and a fake
 * strudel-editor that records the code it was asked to evaluate.
 *
 * What these pin is the recombination rule. A bot's editor is editable in every
 * medium its human's is, so an edit carrying its own `await initHydra(` /
 * `await initTextCycles(` preamble must land verbatim — the old handler always
 * prepended the bot's stored Hydra, which produced two preambles and a REPL
 * that threw instead of playing.
 */
function installControl({
  hydra = '',
  patterns = [INIT_HYDRA_PATTERN, INIT_TEXT_CYCLES_PATTERN],
  evaluateThrows = false,
} = {}) {
  const listeners = new Map();
  const evaluated = [];
  const errors = [];

  const editor = {
    editor: {
      setCode(code) { evaluated.push(code); },
      async evaluate() {
        if (evaluateThrows) throw new Error('bad pattern');
      },
    },
    setAttribute() {},
  };

  global.document = {
    addEventListener(type, fn) { listeners.set(type, fn); },
  };
  global.window = {
    __trussalStrudelEditor: editor,
    __trussalHydra: hydra,
    __trussalReportError: (err) => errors.push(err),
  };
  global.console = console;

  pageRemoteControl(patterns);

  return {
    evaluated,
    errors,
    async push(code) {
      await listeners.get('trussal-remote-pattern')({ detail: { code } });
    },
    storedHydra: () => global.window.__trussalHydra,
  };
}

test.afterEach(() => {
  delete global.document;
  delete global.window;
});

test('a Strudel-only edit still recombines with the bot\'s Hydra', async () => {
  const ctl = installControl({ hydra: 'await initHydra()\nosc(10).out(o0)' });
  await ctl.push('s("bd sd")');
  assert.equal(ctl.evaluated.length, 1);
  assert.match(ctl.evaluated[0], /initHydra/);
  assert.match(ctl.evaluated[0], /s\("bd sd"\)/);
});

test('an edit with its own Hydra preamble lands verbatim, not doubled', async () => {
  const ctl = installControl({ hydra: 'await initHydra()\nosc(10).out(o0)' });
  const pushed = 'await initHydra()\nnoise(3).out(o0)\n\ns("bd sd")';
  await ctl.push(pushed);

  assert.equal(ctl.evaluated[0], pushed);
  const preambles = ctl.evaluated[0].match(/initHydra/g) || [];
  assert.equal(preambles.length, 1, 'exactly one preamble must survive');
});

test('an edit declaring Text Cycles lands verbatim', async () => {
  const ctl = installControl({ hydra: 'await initHydra()\nosc(10).out(o0)' });
  const pushed = 'await initTextCycles()\n\nword("hello world")';
  await ctl.push(pushed);

  assert.equal(ctl.evaluated[0], pushed);
  assert.ok(!ctl.evaluated[0].includes('initHydra'), 'the bot Hydra must not be prepended');
});

test('a self-describing edit clears the stored Hydra so it cannot come back', async () => {
  const ctl = installControl({ hydra: 'await initHydra()\nosc(10).out(o0)' });
  await ctl.push('await initHydra()\nnoise(3).out(o0)');
  assert.equal(ctl.storedHydra(), '');

  await ctl.push('s("hh*4")');
  assert.equal(ctl.evaluated[1], 's("hh*4")', 'the replaced visual must not resurrect');
});

test('a bot with no Hydra evaluates the edit as-is', async () => {
  const ctl = installControl({ hydra: '' });
  await ctl.push('s("bd sd")');
  assert.equal(ctl.evaluated[0], 's("bd sd")');
});

test('a non-string payload is ignored', async () => {
  const ctl = installControl({ hydra: '' });
  await ctl.push(undefined);
  assert.equal(ctl.evaluated.length, 0);
});

test('a malformed pattern is reported and does not disable editing', async () => {
  const ctl = installControl({
    hydra: 'await initHydra()\nosc(10).out(o0)',
    patterns: [{ source: '([unclosed', flags: '' }],
  });
  await ctl.push('s("bd sd")');

  assert.equal(ctl.errors.length, 1, 'the bad pattern must surface, not pass silently');
  assert.equal(ctl.evaluated.length, 1, 'the edit must still be applied');
});

test('a failing operator edit does not feed the fleet-health replace channel', async () => {
  const ctl = installControl({ hydra: '', evaluateThrows: true });
  await ctl.push('s("bd sd")'); // throws inside evaluate(), must not escape the handler

  assert.equal(ctl.evaluated.length, 1, 'setCode still ran with the pasted code');
  assert.equal(ctl.errors.length, 0,
    'an eval failure on a live operator edit must not be reported via ' +
    '__trussalReportError — that array is healthTick\'s "replace this bot" ' +
    'signal, and routing edit failures there gets the bot killed and ' +
    'respawned with its original script within one health tick, which reads ' +
    'as the pasted code reverting');
});
