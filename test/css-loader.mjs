// Node ESM hooks so `import css from './x.css'` resolves to that file's text —
// mirroring build.mjs's `.css: 'text'` loader. The bundle's modules each own
// their stylesheet and inject it as a <style> at run time (studio.js,
// prejoin.js, welcome-page.js, …); a module under node:test that imports its own
// stylesheet would otherwise fail with ERR_UNKNOWN_FILE_EXTENSION, because bare
// `node --test` has no CSS loader. See test/register-css.mjs (registered via the
// `test` npm script).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.css')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(source)};`,
    };
  }
  return nextLoad(url, context);
}
