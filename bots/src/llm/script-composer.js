/**
 * `botConfig({ mcp: "<prompt>" })` — composing a cluster's code from a prompt.
 *
 * Two models, one contract. Claude answers by default; a locally hosted
 * TinyLlama answers when Claude is unreachable or unkeyed, so a show on an
 * isolated network still spawns configured bots. Whichever answers, the result
 * is validated before it can reach a container, and an unusable answer falls
 * back to the curated palette in generator.js rather than spawning a bot that
 * throws on its first cycle.
 *
 * Everything in this module is pure or injected: the two model clients and the
 * MCP tool bridge are constructor arguments, so the whole decision tree —
 * primary, fallback, retry, palette — is testable with no network, no API key
 * and no SDK installed.
 *
 * Generation happens once, at spawn. A rotation slot is a few seconds and a
 * model round-trip is not reliably shorter, so nothing here is ever on the path
 * of a turn boundary.
 */

import { validateCode } from '../script-gen/validate.js';
import { randomMasterScript } from '../script-gen/generator.js';

// The shape both models are asked for, and the one structured-output schema
// Claude is constrained to. Kept minimal deliberately: two strings, matching
// the {strudel, hydra} pair every other producer of a bot script already emits.
export const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    strudel: { type: 'string', description: 'A Strudel pattern expression. No comments, no markdown fences.' },
    hydra: { type: 'string', description: 'Hydra visual code beginning with `await initHydra()`, or an empty string for no visual.' },
  },
  required: ['strudel', 'hydra'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = [
  'You write code for Trussal, a networked algorave instrument.',
  'You produce two things: a Strudel audio pattern, and optional Hydra visual code.',
  '',
  'Rules that make the output usable:',
  '- Strudel: one expression. Chain with dots. Do not wrap in markdown fences.',
  '- Never use double quotes for free text; every double-quoted string in Strudel is parsed as mini-notation.',
  '- Hydra, when present, must begin with `await initHydra()` and end its chain with `.out(o0)`.',
  '- Avoid .room(), .shape(), .crush() and .distort(): these are AudioWorklet effects that fail in the headless browser the bot runs, and a bot that fails is replaced.',
  '- Keep it playable on a loop for minutes. This is live performance, not a demo.',
].join('\n');

/**
 * The instruction for one cluster. The performer's own code goes in as context
 * rather than as something to reproduce: they asked for a prompt-composed
 * cluster, so the model is being asked to play ALONGSIDE them.
 */
export function buildUserPrompt(prompt, master) {
  const lines = [`Write a part for this instruction: ${String(prompt ?? '').trim()}`];
  const strudel = String(master?.strudel ?? '').trim();
  const hydra = String(master?.hydra ?? '').trim();
  if (strudel || hydra) {
    lines.push('', 'The performer you are accompanying is currently playing:');
    if (strudel) lines.push('```', strudel, '```');
    if (hydra) lines.push('Their visual:', '```', hydra, '```');
    lines.push('', 'Complement it. Do not copy it.');
  }
  return lines.join('\n');
}

/**
 * Pull a {strudel, hydra} pair out of whatever a model returned — a parsed
 * object from structured output, or loose text from a model that has no such
 * mode (TinyLlama). Returns { ok, script } or { ok: false, error }.
 */
export function extractScript(answer) {
  const obj = typeof answer === 'string' ? parseLooseJson(answer) : answer;
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'no JSON object in the model output' };

  const strudel = typeof obj.strudel === 'string' ? stripFences(obj.strudel) : '';
  const hydra = typeof obj.hydra === 'string' ? stripFences(obj.hydra) : '';
  if (!strudel.trim()) return { ok: false, error: 'the model returned no strudel' };

  const strudelCheck = validateCode(strudel);
  if (!strudelCheck.ok) return { ok: false, error: `strudel: ${strudelCheck.error}` };
  if (hydra.trim()) {
    const hydraCheck = validateCode(hydra);
    if (!hydraCheck.ok) return { ok: false, error: `hydra: ${hydraCheck.error}` };
    if (!/^\s*await\s+initHydra\s*\(/.test(hydra)) {
      return { ok: false, error: 'hydra must begin with `await initHydra(`' };
    }
  }
  return { ok: true, script: { strudel, hydra } };
}

// Models wrap code in fences even when told not to. Strip them rather than
// failing validation on a formatting habit.
function stripFences(text) {
  return String(text)
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();
}

// The first balanced {...} in a blob of prose. TinyLlama in particular narrates
// around its answer, and a strict JSON.parse of the whole reply would fail on
// output that is otherwise perfectly usable.
export function parseLooseJson(text) {
  const src = String(text ?? '');
  const start = src.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Compose one cluster's master from a prompt.
 *
 * Order is fixed and each step is reported in the result's `source`, so an
 * operator can always tell which model actually answered:
 *   claude → tinyllama → palette
 *
 * Never throws. A cluster whose generation failed still spawns, playing the
 * palette, with the reason attached for the studio to surface — a spawn that
 * silently produced nothing is worse than one that produced something generic.
 */
export async function composeScript({ prompt, master, seed = 0 }, { claude = null, tinyllama = null, tools = null, attempts = 2 } = {}) {
  const request = {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(prompt, master),
    schema: SCRIPT_SCHEMA,
    tools,
  };

  const errors = [];
  for (const [source, client] of [['claude', claude], ['tinyllama', tinyllama]]) {
    if (!client) continue;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let answer;
      try {
        answer = await client.generate(request, { attempt });
      } catch (err) {
        errors.push(`${source}: ${err.message || err}`);
        break; // a transport failure will not fix itself on an immediate retry
      }
      const extracted = extractScript(answer);
      if (extracted.ok) return { ok: true, source, script: extracted.script };
      errors.push(`${source}: ${extracted.error}`);
    }
  }

  return {
    ok: false,
    source: 'palette',
    script: randomMasterScript(seed),
    error: errors.length ? errors.join('; ') : 'no model was configured',
  };
}
