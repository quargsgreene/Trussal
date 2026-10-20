// Module hooks registered by css-text-loader.mjs (see there for why). Mirrors
// esbuild's '.css': 'text' loader: a .css module's default export is the
// file's text, so the importing module injects exactly what the bundle would.
import { readFile } from 'node:fs/promises';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    const text = await readFile(new URL(url), 'utf8');
    return {
      format: 'module',
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
