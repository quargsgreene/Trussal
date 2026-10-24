/**
 * PCM wire format between the aggregator's page and its Node side: base64 of
 * little-endian Float32 samples (interleaved stereo, like everything else in
 * the pipeline). The page half lives inline in page-scripts.js
 * (pageDrainParticipantAudio encodes, pageEnqueueMaster decodes) because page
 * functions cannot import; these are the Node halves.
 *
 * Float32 keeps the samples bit-exact, so nothing downstream — gain staging,
 * the validity gate, the tests' expected values — sees a different number
 * than the JSON arrays this replaced carried.
 */

/** Float32Array (or array of numbers) -> base64. */
export function encodePcm(samples) {
  const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

/** base64 -> Float32Array. Anything that is not a string decodes to no samples. */
export function decodePcm(pcm) {
  const bytes = Buffer.from(typeof pcm === 'string' ? pcm : '', 'base64');
  const out = new Float32Array(Math.floor(bytes.length / Float32Array.BYTES_PER_ELEMENT));
  // Copied rather than viewed: Buffer.from may return a slice of Node's shared
  // pool at an offset that is not 4-byte aligned, which a Float32Array view
  // cannot start at.
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.byteLength));
  return out;
}
