// build-lib-jitsi.mjs decides whether to stage a supplied lib-jitsi-meet bundle
// under dist/libs/ (for standalone deployments). These tests cover argv/env
// parsing and source resolution with an injected filesystem, so nothing is
// copied for real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  BUNDLE_NAME,
  parseLibJitsiArg,
  resolveLibJitsiSource,
  stageLibJitsiBundle,
} from '../build-lib-jitsi.mjs';

const CWD = '/repo';

// Minimal fake fs: `files` is a set of absolute paths; `dirs` a set of dirs.
function fakeFs({ files = [], dirs = [] } = {}) {
  const fileSet = new Set(files.map((p) => resolve(CWD, p)));
  const dirSet = new Set(dirs.map((p) => resolve(CWD, p)));
  return {
    exists(p) { return fileSet.has(resolve(CWD, p)) || dirSet.has(resolve(CWD, p)); },
    stat(p) {
      const abs = resolve(CWD, p);
      if (dirSet.has(abs)) return { isDirectory: () => true, isFile: () => false };
      if (fileSet.has(abs)) return { isDirectory: () => false, isFile: () => true };
      throw new Error('ENOENT');
    },
  };
}

test('build-lib-jitsi: parseLibJitsiArg handles both forms', () => {
  assert.equal(parseLibJitsiArg(['--watch', '--lib-jitsi=/tmp/ljm.js']), '/tmp/ljm.js');
  assert.equal(parseLibJitsiArg(['--lib-jitsi', '/tmp/dir', '--deploy']), '/tmp/dir');
  assert.equal(parseLibJitsiArg(['--watch']), '');
  assert.equal(parseLibJitsiArg([]), '');
});

test('build-lib-jitsi: an explicit file wins over env and defaults', () => {
  const fs = fakeFs({
    files: ['/explicit/ljm.min.js', 'vendor/lib-jitsi-meet.min.js'],
  });
  const result = resolveLibJitsiSource({
    argv: ['--lib-jitsi=/explicit/ljm.min.js'],
    env: { LIB_JITSI_MEET_PATH: '/env/ljm.min.js' },
    cwd: CWD, ...fs,
  });
  assert.deepEqual(result, { path: '/explicit/ljm.min.js', explicit: true });
});

test('build-lib-jitsi: env path is used when no argv override', () => {
  const fs = fakeFs({ dirs: ['/env'], files: ['/env/lib-jitsi-meet.min.js'] });
  const result = resolveLibJitsiSource({
    argv: [], env: { LIB_JITSI_MEET_PATH: '/env' }, cwd: CWD, ...fs,
  });
  assert.deepEqual(result, { path: '/env/' + BUNDLE_NAME, explicit: true });
});

test('build-lib-jitsi: a directory source resolves the bundle inside it', () => {
  const fs = fakeFs({ dirs: ['/drop'], files: ['/drop/' + BUNDLE_NAME] });
  const result = resolveLibJitsiSource({ argv: ['--lib-jitsi', '/drop'], cwd: CWD, ...fs });
  assert.equal(result.path, '/drop/' + BUNDLE_NAME);
});

test('build-lib-jitsi: a directory without the bundle is not a match', () => {
  const fs = fakeFs({ dirs: ['/drop'] });
  const result = resolveLibJitsiSource({ argv: ['--lib-jitsi=/drop'], cwd: CWD, ...fs });
  assert.deepEqual(result, { path: null, explicit: true });
});

test('build-lib-jitsi: falls back to the checkout vendor path', () => {
  const fs = fakeFs({ files: ['vendor/lib-jitsi-meet.min.js'] });
  const result = resolveLibJitsiSource({ argv: [], env: {}, cwd: CWD, ...fs });
  assert.deepEqual(result, { path: resolve(CWD, 'vendor/lib-jitsi-meet.min.js'), explicit: false });
});

test('build-lib-jitsi: falls back to the container deploy path', () => {
  const fs = fakeFs({ files: ['docker-jitsi-meet/jitsi-web/libs/lib-jitsi-meet.min.js'] });
  const result = resolveLibJitsiSource({ argv: [], env: {}, cwd: CWD, ...fs });
  assert.deepEqual(result, {
    path: resolve(CWD, 'docker-jitsi-meet/jitsi-web/libs/lib-jitsi-meet.min.js'),
    explicit: false,
  });
});

test('build-lib-jitsi: no source anywhere is a non-fatal empty result', () => {
  const result = resolveLibJitsiSource({ argv: ['--watch'], env: {}, cwd: CWD, ...fakeFs() });
  assert.deepEqual(result, { path: null, explicit: false });
});

test('build-lib-jitsi: an explicit source that does not exist is reported', () => {
  const result = resolveLibJitsiSource({
    argv: ['--lib-jitsi=/nope/ljm.js'], env: {}, cwd: CWD, ...fakeFs(),
  });
  assert.deepEqual(result, { path: null, explicit: true });
});

test('build-lib-jitsi: stage copies into dist/libs with the canonical name', () => {
  const fs = fakeFs({ files: ['/drop/some-other-name.js'] });
  const mkdirs = [];
  const copies = [];
  const result = stageLibJitsiBundle({
    argv: ['--lib-jitsi=/drop/some-other-name.js'],
    env: {}, cwd: CWD, distDir: 'dist',
    ...fs,
    mkdir: (p, opts) => { mkdirs.push([p, opts]); },
    copy: (src, dest) => { copies.push([src, dest]); },
  });
  assert.equal(result.source, '/drop/some-other-name.js');
  assert.equal(result.dest, join(resolve(CWD, 'dist', 'libs'), BUNDLE_NAME));
  assert.deepEqual(mkdirs, [[resolve(CWD, 'dist', 'libs'), { recursive: true }]]);
  assert.deepEqual(copies, [[result.source, result.dest]]);
});

test('build-lib-jitsi: stage with no source copies nothing', () => {
  let called = false;
  const result = stageLibJitsiBundle({
    argv: [], env: {}, cwd: CWD,
    ...fakeFs(),
    mkdir: () => { called = true; },
    copy: () => { called = true; },
  });
  assert.deepEqual(result, { source: null, dest: null, explicit: false });
  assert.equal(called, false);
});
