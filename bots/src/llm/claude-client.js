/**
 * The Claude side of `botConfig({ mcp: ... })`.
 *
 * Loaded lazily and returns null when it cannot run, so the fleet keeps working
 * on a box with no API key and no @anthropic-ai/sdk installed — the composer
 * simply moves on to TinyLlama and then the palette.
 *
 * Model choice: claude-opus-5 with adaptive thinking. Generation happens once
 * per bot at spawn, never inside a rotation slot, so depth is worth more here
 * than latency.
 */

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;

// Refusals arrive as a successful response with stop_reason 'refusal', not as
// an error, and server-side fallbacks re-run a refused request on another model
// inside the same call rather than handing us back the refusal.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Build a client, or null if this box cannot talk to the API.
 * `deps.sdk` is injectable so tests never need the real package.
 */
export async function createClaudeClient({ apiKey = process.env.ANTHROPIC_API_KEY, sdk = null } = {}) {
  if (!apiKey) return null;

  let Anthropic = sdk;
  if (!Anthropic) {
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch (err) {
      console.warn('[fleet] @anthropic-ai/sdk not installed — mcp prompts fall back to TinyLlama:', err.message);
      return null;
    }
  }

  const client = new Anthropic({ apiKey });

  return {
    name: 'claude',
    async generate({ system, user, schema, tools }, { attempt = 0 } = {}) {
      const params = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        thinking: { type: 'adaptive' },
        output_config: { format: { type: 'json_schema', schema } },
        // A refused request is re-run on Anthropic's recommended fallback inside
        // this same call, so a benign prompt that trips a classifier still
        // returns a usable answer instead of dropping the cluster to the palette.
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        messages: [{
          role: 'user',
          content: attempt === 0
            ? user
            : `${user}\n\nYour previous answer was not valid code. Return only the JSON object, with code that parses.`,
        }],
      };
      if (tools && tools.definitions.length) params.tools = tools.definitions;

      let response = await client.beta.messages.create(params);

      // Tool loop. Everything MCP is a protocol reference server, so in practice
      // Claude rarely calls anything — but if it does, the call has to be
      // serviced or the turn never completes.
      const history = [params.messages[0]];
      let guard = 0;
      while (response.stop_reason === 'tool_use' && tools && guard++ < 5) {
        history.push({ role: 'assistant', content: response.content });
        const results = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          results.push(await tools.call(block));
        }
        history.push({ role: 'user', content: results });
        response = await client.beta.messages.create({ ...params, messages: history });
      }

      if (response.stop_reason === 'refusal') {
        throw new Error(`refused (${response.stop_details?.category ?? 'unspecified'})`);
      }
      return readStructured(response);
    },
  };
}

// Structured output arrives parsed when the SDK supports it; fall back to the
// first text block so a shape change downgrades to loose parsing rather than
// breaking generation outright.
function readStructured(response) {
  if (response.parsed_output) return response.parsed_output;
  for (const block of response.content ?? []) {
    if (block.type === 'text') return block.text;
  }
  return null;
}
