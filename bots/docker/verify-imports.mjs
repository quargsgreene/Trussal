// Build-time import guard.
//
// The bot's module graph reaches outside bots/ (src/audio-net,
// latency-instrument, public/lib — mirrored into the image at their
// repo-relative paths under /repo). A cross-tree import that resolves in a
// dev checkout but was never copied into the image ships bots that spawn and
// instantly crash with ERR_MODULE_NOT_FOUND before ever joining Jitsi. Like
// verify-launch.mjs, this runs as a Dockerfile RUN step and FAILS THE BUILD
// instead.
//
// Every src/**/*.js module is import()ed directly, EXCEPT entry points
// (basename index.js), which run main() / start servers on import: for those,
// their static import specifiers are extracted and imported individually,
// which covers the same graph without executing the entry.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? 'src');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.js')) yield p;
  }
}

// Static `import ... from 'x'` / `export ... from 'x'` / bare `import 'x'`
// specifiers — enough for this codebase's plain ESM style.
function specifiersOf(file) {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(
    /^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm,
  )].map((m) => m[1] ?? m[2]);
}

const failures = [];
async function tryImport(target, origin) {
  try {
    await import(target);
  } catch (e) {
    failures.push(`${origin}: ${String(e && e.message ? e.message : e).split('\n')[0]}`);
  }
}

for (const file of walk(root)) {
  if (basename(file) === 'index.js') {
    for (const spec of specifiersOf(file)) {
      const target = spec.startsWith('.')
        ? pathToFileURL(resolve(dirname(file), spec)).href
        : spec;
      await tryImport(target, `${file} -> ${spec}`);
    }
  } else {
    await tryImport(pathToFileURL(file).href, file);
  }
}

if (failures.length) {
  console.error(
    `\n[verify-imports] FAILED — ${failures.length} unresolvable/broken import(s):\n  `
    + failures.join('\n  ')
    + '\n\nA module in the bot image cannot load. If it imports a repo file from'
    + '\noutside bots/, that tree must be COPYed into the image at its'
    + '\nrepo-relative path (see docker/Dockerfile.bot).\n',
  );
  process.exit(1);
}
console.log('[verify-imports] OK — all src modules import cleanly');
