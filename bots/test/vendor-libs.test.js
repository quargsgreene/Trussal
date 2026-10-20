// The vendored libraries the output stage evaluates page-side. They are
// checked in rather than fetched, so this file guards the three things that
// would silently break a shape directive in production: the files going
// missing, the wrong FORMAT landing there (a browser cannot <script> an ES
// module, nor dynamic-import a UMD build), and the Docker image shipping
// without them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const THREE_URL = new URL('../vendor/three.module.min.js', import.meta.url);
const P5_URL = new URL('../vendor/p5.min.js', import.meta.url);
const DOCKERFILE_URL = new URL('../docker/Dockerfile.bot', import.meta.url);

test('vendor: three.module.min.js exists and is a real ES module build', async () => {
  const src = readFileSync(THREE_URL, 'utf8');
  assert.ok(src.length > 100_000, `three vendor is only ${src.length} bytes`);
  assert.match(src, /export\s*\{/, 'has an ES module export clause');

  // The format check a regex cannot fake: Node's own ESM loader evaluates it.
  const mod = await import(THREE_URL.href);
  assert.equal(typeof mod.WebGLRenderer, 'function', 'WebGLRenderer exports');
  assert.equal(typeof mod.Scene, 'function', 'Scene exports');
  assert.ok('SRGBColorSpace' in mod, 'the color-space constant the texture uses');
  assert.ok('CanvasTexture' in mod, 'the texture type the stage uses');
});

test('vendor: p5.min.js exists and is the browser UMD build, not an ES module', () => {
  const src = readFileSync(P5_URL, 'utf8');
  assert.ok(src.length > 400_000, `p5 vendor is only ${src.length} bytes`);
  assert.match(src, /p5/, 'names the library it defines');
  // The stage installs it with a <script> tag's textContent — an ESM build
  // would throw there instead of exposing window.p5.
  assert.doesNotMatch(src, /^\s*export\s/m, 'is not an ES module');
  assert.doesNotMatch(src, /^\s*import\s/m, 'is not an ES module');
});

test('vendor: the bot image ships bots/vendor', () => {
  const dockerfile = readFileSync(DOCKERFILE_URL, 'utf8');
  assert.match(dockerfile, /COPY\s+bots\/vendor\s+\.\/vendor/,
    'Dockerfile.bot copies the vendored libraries into the image');
});
