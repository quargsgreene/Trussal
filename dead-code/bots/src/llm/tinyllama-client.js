/**
 * The TinyLlama fallback for `botConfig({ mcp: ... })`.
 *
 * Exists so a show on an isolated network — or one whose API key is missing —
 * still spawns configured bots instead of silently dropping every prompt to the
 * palette. It is a 1.1B model: it will produce invalid Strudel often, which is
 * exactly why the composer validates every answer, retries once, and has a
 * palette underneath.
 *
 * Speaks Ollama's /api/generate shape, which is how TinyLlama is usually
 * hosted. Set TINYLLAMA_URL to the host (default localhost:11434) and
 * TINYLLAMA_MODEL to the tag.
 *
 * No structured-output mode and no tool use: neither is available at this size,
 * so the prompt asks for JSON and the composer's loose parser digs it out of
 * whatever prose comes back.
 */

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'tinyllama';
const TIMEOUT_MS = 60000;

export function createTinyLlamaClient({
  baseUrl = process.env.TINYLLAMA_URL || DEFAULT_URL,
  model = process.env.TINYLLAMA_MODEL || DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl || typeof fetchImpl !== 'function') return null;

  return {
    name: 'tinyllama',
    async generate({ system, user, schema }, { attempt = 0 } = {}) {
      const prompt = [
        system,
        '',
        user,
        '',
        'Reply with ONE JSON object and nothing else, matching exactly this shape:',
        JSON.stringify({ strudel: '<strudel code>', hydra: '<hydra code or empty string>' }),
        `The keys are: ${Object.keys(schema.properties).join(', ')}.`,
        attempt > 0 ? 'Your previous answer was not valid code. Return only the JSON object.' : '',
      ].join('\n');

      // A hung local model must not hold a spawn open indefinitely.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt, stream: false }),
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`tinyllama HTTP ${res.status}`);
        const body = await res.json();
        // Ollama returns { response }; a raw llama.cpp server returns { content }.
        return body.response ?? body.content ?? '';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
