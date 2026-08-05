import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRIPT_SCHEMA,
  buildUserPrompt,
  composeScript,
  extractScript,
  parseLooseJson,
} from '../src/llm/script-composer.js';
import { validateCode } from '../src/script-gen/validate.js';

const GOOD = { strudel: 's("bd sd").cutoff(800)', hydra: 'await initHydra()\nosc(10).out(o0)' };

// A model stand-in: answers from a queue, so tests drive the primary/fallback/
// retry ladder exactly.
function fakeModel(name, answers) {
  const queue = [...answers];
  const calls = [];
  return {
    client: {
      name,
      async generate(request, opts) {
        calls.push({ request, opts });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    calls,
  };
}

// --- Extraction --------------------------------------------------------------

test('accepts a valid structured answer', () => {
  const res = extractScript(GOOD);
  assert.equal(res.ok, true);
  assert.deepEqual(res.script, GOOD);
});

test('strips markdown fences models add anyway', () => {
  const res = extractScript({ strudel: '```javascript\ns("bd sd")\n```', hydra: '' });
  assert.equal(res.ok, true);
  assert.equal(res.script.strudel, 's("bd sd")');
});

test('rejects code that does not parse', () => {
  const res = extractScript({ strudel: 's("bd sd"', hydra: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /strudel/);
});

test('rejects hydra that skips the preamble the room requires', () => {
  const res = extractScript({ strudel: 's("bd")', hydra: 'osc(10).out(o0)' });
  assert.equal(res.ok, false);
  assert.match(res.error, /initHydra/);
});

test('an empty hydra is legal — not every part has a visual', () => {
  assert.equal(extractScript({ strudel: 's("bd")', hydra: '' }).ok, true);
});

test('rejects an answer with no strudel', () => {
  assert.equal(extractScript({ strudel: '   ', hydra: '' }).ok, false);
  assert.equal(extractScript(null).ok, false);
});

test('digs JSON out of a model that narrates around it', () => {
  const text = 'Sure! Here is a part:\n{"strudel": "s(\\"bd sd\\")", "hydra": ""}\nHope that helps.';
  const res = extractScript(text);
  assert.equal(res.ok, true);
  assert.equal(res.script.strudel, 's("bd sd")');
});

test('parseLooseJson ignores braces inside strings', () => {
  assert.deepEqual(parseLooseJson('{"a": "}{" }'), { a: '}{' });
  assert.equal(parseLooseJson('no json here'), null);
});

// --- Prompt ------------------------------------------------------------------

test('the prompt carries the performer\'s code as context to complement', () => {
  const prompt = buildUserPrompt('spooky drones', { strudel: 's("bd sd")', hydra: '' });
  assert.match(prompt, /spooky drones/);
  assert.match(prompt, /s\("bd sd"\)/);
  assert.match(prompt, /Complement it\. Do not copy it\./);
});

test('the prompt stands alone when the performer has no code', () => {
  const prompt = buildUserPrompt('spooky drones', { strudel: '', hydra: '' });
  assert.match(prompt, /spooky drones/);
  assert.ok(!prompt.includes('currently playing'));
});

test('the schema pins both fields and forbids extras', () => {
  assert.deepEqual(SCRIPT_SCHEMA.required, ['strudel', 'hydra']);
  assert.equal(SCRIPT_SCHEMA.additionalProperties, false);
});

// --- The ladder --------------------------------------------------------------

test('claude answers and nothing else is consulted', async () => {
  const claude = fakeModel('claude', [GOOD]);
  const tinyllama = fakeModel('tinyllama', [GOOD]);
  const res = await composeScript({ prompt: 'x', master: {} }, { claude: claude.client, tinyllama: tinyllama.client });

  assert.equal(res.ok, true);
  assert.equal(res.source, 'claude');
  assert.equal(tinyllama.calls.length, 0, 'the fallback must stay unused');
});

test('an invalid first answer is retried before giving up on that model', async () => {
  const claude = fakeModel('claude', [{ strudel: 's("bd"', hydra: '' }, GOOD]);
  const res = await composeScript({ prompt: 'x', master: {} }, { claude: claude.client });

  assert.equal(res.ok, true);
  assert.equal(claude.calls.length, 2);
  assert.equal(claude.calls[1].opts.attempt, 1, 'the retry is told it is a retry');
});

test('an unreachable Claude falls through to TinyLlama', async () => {
  const claude = fakeModel('claude', [new Error('ENOTFOUND api.anthropic.com')]);
  const tinyllama = fakeModel('tinyllama', [GOOD]);
  const res = await composeScript({ prompt: 'x', master: {} }, { claude: claude.client, tinyllama: tinyllama.client });

  assert.equal(res.ok, true);
  assert.equal(res.source, 'tinyllama');
  assert.equal(claude.calls.length, 1, 'a transport failure is not retried in place');
});

test('a refusal falls through to TinyLlama', async () => {
  const claude = fakeModel('claude', [new Error('refused (cyber)')]);
  const tinyllama = fakeModel('tinyllama', [GOOD]);
  const res = await composeScript({ prompt: 'x', master: {} }, { claude: claude.client, tinyllama: tinyllama.client });
  assert.equal(res.source, 'tinyllama');
});

test('both models failing falls back to the palette, with a reason', async () => {
  const claude = fakeModel('claude', [{ strudel: 'nope(', hydra: '' }, { strudel: 'nope(', hydra: '' }]);
  const tinyllama = fakeModel('tinyllama', ['not json', 'still not json']);
  const res = await composeScript({ prompt: 'x', master: {}, seed: 3 }, { claude: claude.client, tinyllama: tinyllama.client });

  assert.equal(res.ok, false);
  assert.equal(res.source, 'palette');
  assert.match(res.error, /claude/);
  assert.match(res.error, /tinyllama/);
  assert.equal(validateCode(res.script.strudel).ok, true, 'the palette fallback is always valid');
  assert.equal(validateCode(res.script.hydra).ok, true);
});

test('no model configured still yields a usable script', async () => {
  const res = await composeScript({ prompt: 'x', master: {}, seed: 1 }, {});
  assert.equal(res.ok, false);
  assert.equal(res.source, 'palette');
  assert.match(res.error, /no model was configured/);
  assert.equal(validateCode(res.script.strudel).ok, true);
});

test('composeScript never throws, whatever the client does', async () => {
  const exploding = { name: 'claude', async generate() { throw new TypeError('boom'); } };
  const res = await composeScript({ prompt: 'x', master: {}, seed: 1 }, { claude: exploding });
  assert.equal(res.source, 'palette');
  assert.match(res.error, /boom/);
});

test('tools are passed through to the model request', async () => {
  const claude = fakeModel('claude', [GOOD]);
  const tools = { definitions: [{ name: 'echo' }], call: async () => ({}) };
  await composeScript({ prompt: 'x', master: {} }, { claude: claude.client, tools });
  assert.equal(claude.calls[0].request.tools, tools);
});
