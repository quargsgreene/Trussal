/**
 * Random master-script generation.
 *
 * Design: instead of free-form code synthesis (which would constantly emit
 * invalid Strudel), we compose from a curated palette of known-good fragments
 * — drum patterns, melodic lines, fx, and Hydra sources/modulators. The
 * combinatorics give plenty of variety while every output is valid by
 * construction; the test suite still runs each output through validateCode
 * as a regression net.
 *
 * Determinism: seeded mulberry32 so the conductor can re-issue the identical
 * master script to a replacement bot mid-session.
 */



// Headless-safe only. superdough builds reverb (.room) and the "damage"
// effects (.shape/.crush/.distort) as AudioWorkletNodes, and headless
// Chromium's worklet path fails to start: the scheduler never runs, the bot
// reports an eval error, and the conductor replaces it — so the bot's video
// tile drops out (see shouldReplace in ../orchestrator/health.js and the same
// note in ../shared/audio-math.js). Keep only native-node effects here.
const FX = [
  '.vowel("<a e i o>")',
  '.cutoff(sine.range(300, 2000).slow(4))',
];



function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

function createRandomDrumPattern() {
  const repeats = Math.floor(Math.random() * 10) + 1;
  const drumOptions = ['bd', 'sd', 'hh', 'cp', 'rim'];
  let pattern = '';
  for( let i = 0; i < repeats; i++) {
    pattern += `${drumOptions[Math.floor(Math.random() * drumOptions.length)]}*${Math.floor(Math.random() * 4) + 1} ${Math.random() < 0.5 ? '~' : ''} `;
  }
  return pattern;
}

export function randomMasterScript(seed = Date.now()) {
  const rand = mulberry32(seed);


  const HYDRA_SOURCES = [
  `osc(${500 * Math.random() + 1}, ${10 * Math.random() + 1}, ${Math.random() + 0.001})`,
  `noise(${100 * Math.random() + 1}, ${Math.random() + 0.001})`,
  `voronoi(${109 * Math.random() + 1}, 0.4)`,
  `shape(4, 0.4, 0.01)`,
];

const HYDRA_MODS = [
  `.rotate(${Math.random() * 2 - 1}, 0.05)`,
  `.kaleid(4)`,
  `.modulate(noise(2), 0.2)`,
  `.colorama(0.05)`,
];

const DRUMS = [
  `s("${createRandomDrumPattern()}")`,
  `s("bd*2 [~ sd] hh*${Math.random() * 10 + 1} sd")`,
  `s("[bd ~]*${Math.random() * 10 + 1} sd:2 [hh hh] sd")`,
  `s("${createRandomDrumPattern()}")`,
];

const MELODIES = [
  `note("c3 eb3 g3 bb3").s("sawtooth")`,
  `n("0 3 5 7").scale("C:minor").s("triangle")`,
  `note("<c2 f2 g2 bb1>").s("square").slow(2)`,
  `n("0 2 4 [6 7]").scale("D:dorian").s("sine")`,
];
  const strudel = [
    'stack(',
    `  ${pick(rand, DRUMS)},`,
    `  ${pick(rand, MELODIES)}${pick(rand, FX)}`,
    ')',
  ].join('\n');
  const hydra = [
    'await initHydra()',
    `${pick(rand, HYDRA_SOURCES)}${pick(rand, HYDRA_MODS)}${pick(rand, HYDRA_MODS)}.out(o0)`,
  ].join('\n');
  return { strudel, hydra };
}
