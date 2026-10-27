import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPages, PAGE_FILES } from '../build-pages.mjs';

// The standalone /documentation and /about pages are generated from the same
// content builders the welcome-page corner links out to (see build-pages.mjs).
// These tests pin the parts a breakage would silently ruin: the pages exist,
// every JPattern card keeps a matching jump link, and the pages stay script-free
// (a script tag would suggest bundle code was smuggled into the static shell).

function writePages(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trussal-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(buildPages(dir), PAGE_FILES);
  return dir;
}

test('buildPages writes both pages, script-free', (t) => {
  const dir = writePages(t);

  const docs = readFileSync(join(dir, 'documentation.html'), 'utf8');
  const about = readFileSync(join(dir, 'about.html'), 'utf8');

  assert.match(docs, /<title>JPattern Docs — Trussal<\/title>/);
  assert.match(about, /<title>About — Trussal<\/title>/);
  for (const html of [docs, about]) {
    assert.match(html, /class="trussal-da-panel"/);
    assert.ok(!/<script/i.test(html), 'standalone pages must not load any script');
  }
});

test('documentation: every function card has a resolving jump link, ids unique', (t) => {
  const dir = writePages(t);
  const html = readFileSync(join(dir, 'documentation.html'), 'utf8');

  const cardIds = [...html.matchAll(/<div class="da-fn" id="(trussal-da-fn-[^"]+)">/g)].map((m) => m[1]);
  const tocTargets = [...html.matchAll(/<a href="#(trussal-da-fn-[^"]+)">/g)].map((m) => m[1]);

  assert.ok(cardIds.length >= 20, `expected the full reference, got ${cardIds.length} cards`);
  assert.equal(new Set(cardIds).size, cardIds.length, 'card ids must be unique (they are page-wide anchors)');
  assert.deepEqual([...tocTargets].sort(), [...cardIds].sort(), 'each card must be reachable from the table of contents');
});

test('about: keeps the figure and the closing ✕ back to the lobby', (t) => {
  const dir = writePages(t);
  const html = readFileSync(join(dir, 'about.html'), 'utf8');

  assert.match(html, /src="https:\/\/trussal-docs\.quargsgreene\.workers\.dev\/about-trussal-in-action\.png"/);
  assert.match(html, /class="da-close" href="\/"/);
});
