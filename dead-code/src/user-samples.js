// ARCHIVED 2026-08-28 — moved out of src/user-samples.js as dead code.
//
// `# crush` on an uploaded image (img("folder")) was documented (see
// src/features/netcycles.md) but never wired to this render-time compressor,
// so nothing imported it. `compressedSize` — the pure size math it calls — is
// still exported from src/user-samples.js and covered by test/user-images.test.js.

import { compressedSize } from '../../src/user-samples.js';

// Render-time compression: draw the image through a smaller canvas and back,
// so what Hydra samples is blocky in the same way the crushed audio is stepped.
//
// Returns a NEW canvas every call and never touches `image` or the stored
// blob — that is the whole contract. An effect must be undoable by deleting
// the directive, which it cannot be if the material itself was rewritten.
export function compressImage(image, pixelBlock) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  const small = compressedSize(width, height, pixelBlock);
  if (small.width === width && small.height === height) {
    ctx.drawImage(image, 0, 0);
    return out;
  }
  const buffer = document.createElement('canvas');
  buffer.width = small.width;
  buffer.height = small.height;
  const bctx = buffer.getContext('2d');
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(image, 0, 0, small.width, small.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffer, 0, 0, small.width, small.height, 0, 0, width, height);
  return out;
}
