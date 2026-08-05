/**
 * The Everything MCP server, bridged into the tool list Claude sees.
 *
 * Everything (@modelcontextprotocol/server-everything) is the protocol's own
 * reference server — echo, add, longRunningOperation, printEnv, getTinyImage.
 * It exposes no music or code capability, so in practice a model composing a
 * Strudel part rarely calls it. It is wired because the deployment asks for it,
 * and because having a real MCP surface attached is what makes adding a useful
 * server later a config change rather than a code change.
 *
 * Local stdio, not the API's server-side MCP connector: the connector fetches
 * the server itself and can only reach publicly-resolvable URLs, and this runs
 * on a LAN VM. Bridging locally also means the same tools are available to
 * whichever model answers.
 *
 * Optional by construction — if the SDK or the server package is absent,
 * `connectEverythingMcp` returns null and generation proceeds with no tools.
 */

const DEFAULT_COMMAND = 'npx';
const DEFAULT_ARGS = ['-y', '@modelcontextprotocol/server-everything'];

/**
 * Start Everything over stdio and return { definitions, call, close }, or null.
 * `definitions` is in Anthropic tool shape; `call` services one tool_use block
 * and returns the tool_result block to send back.
 */
export async function connectEverythingMcp({
  command = process.env.MCP_EVERYTHING_COMMAND || DEFAULT_COMMAND,
  args = process.env.MCP_EVERYTHING_ARGS ? process.env.MCP_EVERYTHING_ARGS.split(' ') : DEFAULT_ARGS,
  sdk = null,
} = {}) {
  let Client;
  let StdioClientTransport;
  try {
    if (sdk) {
      ({ Client, StdioClientTransport } = sdk);
    } else {
      ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
      ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
    }
  } catch (err) {
    console.warn('[fleet] MCP SDK unavailable — composing without tools:', err.message);
    return null;
  }

  try {
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: 'trussal-fleet', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const listed = await client.listTools();
    const definitions = (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? `MCP tool ${tool.name}`,
      input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    }));

    return {
      definitions,
      async call(block) {
        try {
          const result = await client.callTool({ name: block.name, arguments: block.input ?? {} });
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: textOf(result),
          };
        } catch (err) {
          // Returned as an error result rather than thrown: the model can
          // recover from a failed tool, but a thrown error ends the generation.
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: String(err.message || err),
            is_error: true,
          };
        }
      },
      async close() {
        try { await client.close(); } catch { /* already gone */ }
      },
    };
  } catch (err) {
    console.warn('[fleet] Everything MCP failed to start — composing without tools:', err.message);
    return null;
  }
}

// MCP returns content blocks; Anthropic tool_result wants text.
function textOf(result) {
  const blocks = result?.content ?? [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  return text || JSON.stringify(result ?? null);
}
