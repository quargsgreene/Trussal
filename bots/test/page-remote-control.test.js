import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageRemoteControl } from '../src/bot/page-scripts.js';
import { INIT_HYDRA_PATTERN } from '../../src/hydra-code.js';
import { INIT_TEXT_CYCLES_PATTERN, WORD_CALL_RE } from '../../src/text-cycles-core.js';
import { INIT_CSS_PATTERN, CSS_CALL_RE } from '../../src/css-cycles-core.js';

const DEFAULT_CAPABILITY_PATTERNS = {
  word: { source: WORD_CALL_RE.source, flags: WORD_CALL_RE.flags },
  css: { source: CSS_CALL_RE.source, flags: CSS_CALL_RE.flags },
  initTextCycles: INIT_TEXT_CYCLES_PATTERN,
  initCss: INIT_CSS_PATTERN,
};

/**
 * Runs the page-side operator-control listener outside a browser: a fake
 * `document` that records listeners so tests can dispatch by hand, and a fake
 * strudel-editor that records the code it was asked to evaluate.
 *
 * What these pin is the recombination rule. A bot's editor is editable in every
 * medium its human's is, so an edit carrying its own `await initHydra(` /
 * `await initTextCycles(` preamble must land verbatim — the old handler always
 * prepended the bot's stored Hydra, which produced two preambles and a REPL
 * that threw instead of playing. They also pin the capability strip: the
 * bot's own REPL is bare vanilla Strudel with no word()/css(), so a pushed
 * edit carrying either must be stripped before this REPL evaluates it, the
 * same way cluster-source.js strips a bot's GENERATED script.
 */
function installControl({
  hydra = '',
  patterns = [INIT_HYDRA_PATTERN, INIT_TEXT_CYCLES_PATTERN],
  capabilityPatterns = DEFAULT_CAPABILITY_PATTERNS,
  evaluateThrows = false,
  sampleBanks = {},
} = {}) {
  const listeners = new Map();
  const evaluated = [];
  const errors = [];
  const registrationCalls = [];

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
    __trussalSamples: sampleBanks,
    loadWorklets: async () => { registrationCalls.push('loadWorklets'); },
    registerSynthSounds: async () => { registrationCalls.push('registerSynthSounds'); },
    registerZZFXSounds: async () => { registrationCalls.push('registerZZFXSounds'); },
    registerSoundfonts: async () => { registrationCalls.push('registerSoundfonts'); },
    registerSampleSource: (bank) => { registrationCalls.push(`registerSampleSource:${bank}`); },
  };
  global.console = console;

  pageRemoteControl(patterns, capabilityPatterns);

  return {
    evaluated,
    errors,
    registrationCalls,
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

test('a pushed edit re-registers worklets/synths/samples before evaluating, same as boot', async () => {
  // pageStrudelBoot's own comment documents the failure this guards: a synth
  // or sample this REPL hasn't loaded fails PER-TRIGGER with no thrown error
  // (scheduler still starts, fanRms just stays 0) — confirmed live via
  // s("sine")→s("supersaw") going silent until loadWorklets() ran. The
  // spawn-time registration only covers what the ORIGINAL script named; an
  // edit naming something else needs the same registration repeated.
  const ctl = installControl({ hydra: '', sampleBanks: { mykit: ['a.wav', 'b.wav'] } });
  await ctl.push('s("supersaw")');

  assert.ok(ctl.registrationCalls.includes('loadWorklets'));
  assert.ok(ctl.registrationCalls.includes('registerSynthSounds'));
  assert.ok(ctl.registrationCalls.includes('registerZZFXSounds'));
  assert.ok(ctl.registrationCalls.includes('registerSoundfonts'));
  assert.ok(ctl.registrationCalls.includes('registerSampleSource:mykit'));
  // Registration must land before evaluate(), not after — otherwise the
  // first post-edit cycle still races the worklet load.
  assert.equal(ctl.evaluated.length, 1, 'registration must not block the eval itself');
});

test('an edit with its own Hydra preamble lands verbatim, not doubled', async () => {
  const ctl = installControl({ hydra: 'await initHydra()\nosc(10).out(o0)' });
  const pushed = 'await initHydra()\nnoise(3).out(o0)\n\ns("bd sd")';
  await ctl.push(pushed);

  assert.equal(ctl.evaluated[0], pushed);
  const preambles = ctl.evaluated[0].match(/initHydra/g) || [];
  assert.equal(preambles.length, 1, 'exactly one preamble must survive');
});

test('a pure Text Cycles edit is stripped to silence, not evaluated verbatim', async () => {
  // Unlike the Hydra preamble case, this REPL is bare vanilla Strudel — it has
  // no word()/initTextCycles() registered at all, so evaluating this verbatim
  // throws. The text itself still reaches other viewers' parrot mechanism via
  // the ANNOUNCED peer.pattern (unaffected by this function, which only
  // controls what this bot's own REPL runs), so nothing is lost by stripping
  // it here — just made safe to evaluate.
  const ctl = installControl({ hydra: 'await initHydra()\nosc(10).out(o0)' });
  const pushed = 'await initTextCycles()\n\nword("hello world")';
  await ctl.push(pushed);

  assert.equal(ctl.evaluated[0], 'silence');
  assert.equal(ctl.storedHydra(), '', 'a self-describing edit still forgets the stored hydra');
});

test('a mixed edit keeps its audio and drops only the word() voice', async () => {
  const ctl = installControl({ hydra: '' });
  const pushed = 'word("hello")\n\ns("bd sd")';
  await ctl.push(pushed);

  assert.equal(ctl.evaluated[0], 's("bd sd")');
});

test('a mixed edit keeps its audio and drops only the css() voice', async () => {
  const ctl = installControl({ hydra: '' });
  const pushed = 'css(`body { color: red }`)\n\ns("bd sd")';
  await ctl.push(pushed);

  assert.equal(ctl.evaluated[0], 's("bd sd")');
});

test('word() as a stack() sibling loses only its own branch, not the audio next to it', async () => {
  // The shape a bot's own peer.pattern is routinely in: a performer combines
  // audio and words as stack() siblings rather than separate $: voices (see
  // cluster-source.js's stripBranchesMatching, which this mirrors). Without
  // salvaging the sibling, the whole stack() — audio included — used to drop
  // to 'silence' any time a bot's own tile was pushed back, even unedited.
  const ctl = installControl({ hydra: '' });
  const pushed = 'stack(\n  word("hello world"),\n  s("bd sd")\n)';
  await ctl.push(pushed);

  assert.match(ctl.evaluated[0], /s\("bd sd"\)/);
  assert.ok(!ctl.evaluated[0].includes('word('), 'the word() voice must not reach the bare REPL');
});

test('a text/css voice is stripped from the pushed audio before it is recombined with the stored hydra', async () => {
  const ctl = installControl({ hydra: 'await initHydra()\nosc(10).out(o0)' });
  // No blank line between the word() call and the audio pattern — stripping
  // pre-combine (see forBotRepl) is what keeps this from merging the hydra
  // preamble into the same dropped unit.
  await ctl.push('word("hi")\n\ns("bd sd")');

  assert.match(ctl.evaluated[0], /initHydra/);
  assert.match(ctl.evaluated[0], /s\("bd sd"\)/);
  assert.ok(!ctl.evaluated[0].includes('word('), 'the word() voice must not reach the bare REPL');
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
