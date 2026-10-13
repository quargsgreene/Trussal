import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_KINDS,
  FILE_CALL_RE,
  kindOfFilename,
  mimeOfFilename,
  validateUpload,
  rewriteFileCalls,
  hasFileCycles,
  MAX_FILE_BYTES,
} from '../src/file-cycles-core.js';

test('kindOfFilename classifies every supported extension', () => {
  assert.equal(kindOfFilename('cat.png'), 'image');
  assert.equal(kindOfFilename('cat.PNG'), 'image');
  assert.equal(kindOfFilename('logo.svg'), 'image');
  assert.equal(kindOfFilename('me.mp4'), 'video');
  assert.equal(kindOfFilename('me.mov'), 'video');
  assert.equal(kindOfFilename('notes.txt'), 'textFile');
  assert.equal(kindOfFilename('paper.pdf'), 'pdfFile');
  assert.equal(kindOfFilename('song.mp3'), 'soundFile');
  assert.equal(kindOfFilename('song.ogg'), 'soundFile');
  assert.equal(kindOfFilename('archive.zip'), null);
  assert.equal(kindOfFilename(''), null);
});

test('validateUpload rejects unsupported extensions and oversized files', () => {
  assert.equal(validateUpload('cat.png', 1000).ok, true);
  assert.equal(validateUpload('archive.zip', 1000).ok, false);
  assert.equal(validateUpload('cat.png', MAX_FILE_BYTES + 1).ok, false);
  assert.equal(validateUpload('cat.png', MAX_FILE_BYTES).ok, true);
});

test('FILE_CALL_RE matches every registered function name', () => {
  for (const kind of Object.keys(FILE_KINDS)) {
    assert.equal(FILE_CALL_RE.test(`${kind}("x")`), true, kind);
    assert.equal(FILE_CALL_RE.test(`.${kind}("x")`), true, kind);
  }
  assert.equal(FILE_CALL_RE.test('s("bd sd")'), false);
});

test('rewriteFileCalls mint-encodes a double-quoted mini sequence of filenames', () => {
  const code = '$: image("cat.png dog.jpeg")';
  const { code: out, atoms } = rewriteFileCalls(code, { peer: 'jit-1' });
  assert.match(out, /\$: image\("fc0 fc1"\)/);
  assert.equal(atoms.fc0.text, 'cat.png');
  assert.equal(atoms.fc1.text, 'dog.jpeg');
});