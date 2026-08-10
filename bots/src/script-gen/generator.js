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

function createRandomDrumPattern(rand) {
  const repeats = Math.floor(rand() * 10) + 1;
  const drumOptions = ['bd', 'sd', 'hh', 'cp', 'rim'];
  let pattern = '';
  for( let i = 0; i < repeats; i++) {
    pattern += `${drumOptions[Math.floor(rand() * drumOptions.length)]}*${Math.floor(rand() * 4) + 1} ${rand() < 0.5 ? '~' : ''} `;
  }
  return pattern;
}

function createRandomMelody(rand) {
  let patternLength = Math.floor(23 * rand()) + 1;
  let pattern = '';

  for(let i = 0; i < patternLength; i++){
    let currentFreq = Math.min(20000, Math.floor(20000 * rand()) + 20);
    pattern += currentFreq + ' ';
  }

  return pattern;
}

function createRandomText(rand) {
  let patternLength = Math.floor(100 * rand()) + 1;
  let chars = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
  let numChars = chars.length;
  let pattern = '';

  for(let i = 0; i < patternLength; i++){
    let currentCharIndex = Math.floor(numChars * rand());
    let currentChar = chars[currentCharIndex];
    pattern += currentChar;
  }

  return pattern;
}


export function randomMasterScript(seed = Date.now()) {
  const rand = mulberry32(seed);


  const HYDRA_SOURCES = [
  `osc(${500 * rand() + 1}, ${10 * rand() + 1}, ${rand() + 0.001})`,
  `noise(${100 * rand() + 1}, ${rand() + 0.001})`,
  `voronoi(${109 * rand() + 1}, 0.4)`,
  `shape(4, 0.4, 0.01)`,
];

const HYDRA_MODS = [
  `.rotate(${rand() * 2 - 1}, 0.05)`,
  `.kaleid(4)`,
  `.modulate(noise(2), 0.2)`,
  `.colorama(0.05)`,
];

const DRUMS = [
  `s("${createRandomDrumPattern(rand)}")`,
  `s("bd*2 [~ sd] hh*${rand() * 10 + 1} sd")`,
  `s("[bd ~]*${rand() * 10 + 1} sd:2 [hh hh] sd")`,
  `s("${createRandomDrumPattern(rand)}")`,
];

const FX = [
  '.vib(20)',
  '.cutoff(sine.range(300, 2000).slow(4))',
];

const MELODIES = [
  `freq("${createRandomMelody(rand)}").s("sawtooth")`,
  `n("0 3 5 7").scale("C:minor").s("triangle")`,
  `freq("<${createRandomMelody(rand)}>").s("square").slow(2)`,
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

const text = textPatternFrom(rand);
  return { strudel, hydra, text };
}

// The word()-voice template, shared by randomMasterScript (which already has
// a live `rand`) and randomTextPattern (a standalone seed for a bot that has
// no other reason to call randomMasterScript at all — see cluster-source.js's
// botScriptFor, which gives every bot its own text voice by default).
function textPatternFrom(rand) {
  return [
    'await initTextCycles()',
    `
    $: typeface('Times New Roman').word("<${createRandomText(rand)}>")
        .weight("400 200 100 800")
        .slant("<italic none>")
        .size("<12px 24px 10px 1px>*2")
        .color("<#346234 #bfe968>")
        .underline("underline")
        .spacing("<3px 6px 9px 12px>")
        .hover("color:#ffffff")
        .hyperlink("<google.com reddit.com ca.gov devry.edu>")
`,
  ].join('\n');
}

/** A standalone, seeded word() voice — see textPatternFrom. */
export function randomTextPattern(seed = Date.now()) {
  return textPatternFrom(mulberry32(seed));
}
