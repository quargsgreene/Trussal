// build-lib-jitsi.mjs — optional build step: stage the lib-jitsi-meet bundle
// under dist/libs/ so a standalone deployment is self-contained.
//
// The loader (src/lib-jitsi-loader.js) resolves
// `libs/lib-jitsi-meet.min.js` relative to custom-config.js. A page served from
// dist/ therefore finds dist/libs/lib-jitsi-meet.min.js with no configuration.
//
// The bundle is multi-megabyte and versioned with the Jitsi image, so it is NOT
// committed or downloaded here. Supply it one of these ways, in order:
//   1. --lib-jitsi=<path to file or directory> on the build command line;
//   2. LIB_JITSI_MEET_PATH (also works from .env, which build.mjs loads);
//   3. a default path in the checkout:
//        vendor/lib-jitsi-meet.min.js
//        docker-jitsi-meet/jitsi-web/libs/lib-jitsi-meet.min.js
//
// Nothing here is fatal: with no bundle supplied the build succeeds and simply
// leaves dist/libs/ out, exactly as before this step existed.
//
// The container deploy mirrors the same bundle into jitsi-web/libs/ (so the web
// image's `COPY libs` can bake it); when nothing is supplied the dir is empty
// and the image's own lib-jitsi-meet.min.js is what the loader fetches.

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const BUNDLE_NAME = 'lib-jitsi-meet.min.js';

export const DEFAULT_SOURCES = [
  'vendor/lib-jitsi-meet.min.js',
  'docker-jitsi-meet/jitsi-web/libs/lib-jitsi-meet.min.js',
];

/** Pull a path out of `--lib-jitsi=<path>` or `--lib-jitsi <path>`. */
export function parseLibJitsiArg(argv = []) {
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lib-jitsi') return args[i + 1] || '';
    if (arg.startsWith('--lib-jitsi=')) return arg.slice('--lib-jitsi='.length);
  }
  return '';
}

// A candidate may be the bundle itself or a directory that contains it.
function findBundle(candidate, { cwd, exists, stat }) {
  const full = resolve(cwd, candidate);
  try {
    if (!exists(full)) return null;
    const info = stat(full);
    if (info.isDirectory()) {
      const inDir = join(full, BUNDLE_NAME);
      return exists(inDir) ? inDir : null;
    }
    return full;
  } catch (e) {
    return null;
  }
}

/**
 * Where the bundle should come from. Explicit sources (argv/env) are tried
 * before the checkout defaults. Returns `{ path, explicit }`; `path` is null
 * when nothing was found, and `explicit` records whether the operator named a
 * source (so a missing explicit path can be called out loudly).
 */
export function resolveLibJitsiSource({
  argv = [],
  env = {},
  cwd = process.cwd(),
  exists = existsSync,
  stat = statSync,
} = {}) {
  const explicit = [];
  const fromArg = parseLibJitsiArg(argv);
  if (fromArg) explicit.push(fromArg);
  if (env.LIB_JITSI_MEET_PATH) explicit.push(env.LIB_JITSI_MEET_PATH);

  for (const candidate of explicit) {
    const found = findBundle(candidate, { cwd, exists, stat });
    if (found) return { path: found, explicit: true };
  }
  for (const candidate of DEFAULT_SOURCES) {
    const found = findBundle(candidate, { cwd, exists, stat });
    if (found) return { path: found, explicit: explicit.length > 0 };
  }
  return { path: null, explicit: explicit.length > 0 };
}

/**
 * Copy the bundle into <distDir>/libs/lib-jitsi-meet.min.js.
 * Returns `{ source, dest, explicit }` (source/dest null when nothing found).
 */
export function stageLibJitsiBundle({
  argv = [],
  env = {},
  cwd = process.cwd(),
  distDir = 'dist',
  exists = existsSync,
  stat = statSync,
  mkdir = mkdirSync,
  copy = copyFileSync,
} = {}) {
  const { path: source, explicit } = resolveLibJitsiSource({ argv, env, cwd, exists, stat });
  if (!source) return { source: null, dest: null, explicit };
  const destDir = resolve(cwd, distDir, 'libs');
  mkdir(destDir, { recursive: true });
  const dest = join(destDir, BUNDLE_NAME);
  copy(source, dest);
  return { source, dest, explicit };
}
