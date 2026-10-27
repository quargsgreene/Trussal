// ipa-synth.mjs — writes the IPA sound files (src/ipa-synth-core.js renders
// them) into the folder ipa-voice.js fetches from. Called by build.mjs and the
// Vite dev server; also runnable alone:
//
//   node scripts/ipa-synth.mjs [outDir]      (default dist/assets/ipa)

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { soundFile, SAMPLE_RATE as SR } from '../src/ipa-core.js';
import { renderSound, soundList } from '../src/ipa-synth-core.js';

// 16-bit PCM mono WAV.
export function encodeWav(samples, rate = SR) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Bump when the synthesis changes, so a stale folder is re-rendered.
const VERSION = '5';

export function writeIpaSounds(outDir) {
  const stamp = join(outDir, 'VERSION');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === VERSION) return 0;
  mkdirSync(outDir, { recursive: true });
  const list = soundList();
  for (const [sym, v] of list) writeFileSync(join(outDir, soundFile(sym, v)), encodeWav(renderSound(sym, v)));
  writeFileSync(stamp, VERSION);
  return list.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'dist/assets/ipa'));
  const n = writeIpaSounds(out);
  console.log(n ? `[ipa-synth] wrote ${n} files -> ${out}` : `[ipa-synth] up to date: ${out}`);
}
