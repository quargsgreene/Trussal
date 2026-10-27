import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  parseLibrary,
  validateLibrary,
  mergeLibrary,
  snippetId,
  singleShotAsset,
  thumbnailAudioFor,
  emptyBoard,
  addLine,
  placeAt,
  removeAt,
  moveLine,
  sanitizeBoard,
  runBoard,
  compileFlow,
  NO_CODE_MAX_BYTES,
} from '../src/no-code-core.js';
import { readDirective } from '../src/program-directive.js';
import { normalizePeerCode } from '../src/hydra-code.js';
import { rewriteCssCalls } from '../src/css-cycles-core.js';
import { wrapAsVoice } from '../src/strudel-voice.js';

const EXAMPLES = new URL('../examples/no-code/', import.meta.url);

const lib = (snippets) => {
  const r = parseLibrary(JSON.stringify({ snippets }));
  assert.deepEqual(r.errors, []);
  return r.snippets;
};
const byName = (library, name) => library.find((s) => s.name === name);

const beat = { name: 'beat', type: 'pattern', language: 'strudel', operands: 0, source: 's("bd*4")' };
const hats = { name: 'hats', type: 'pattern', language: 'strudel', operands: 0, source: 's("hh*8")' };
const clouds = { name: 'clouds', type: 'pattern', language: 'hydra', operands: 0, source: 'noise(3).out()' };
const drums = {
  name: 'drums', type: 'assetPack',
  assets: { samples: { kit: [{ name: 'bd.wav', src: '/s/bd.wav' }, { name: 'sn.wav', src: '/s/sn.wav' }] } },
};
const play = { name: 'play', type: 'pattern', language: 'strudel', operands: 1, source: 's("{{0}}*2")' };
const either = {
  name: 'either', type: 'flow', language: 'javascript', operands: 2,
  source: 'return ctx.isMyTurn ? operands[0] : operands[1];',
};
const both = { name: 'both', type: 'flow', language: 'javascript', operands: 2, source: 'return [operands[0], operands[1]];' };

test('every shipped example library validates with no errors or warnings', () => {
  const names = readdirSync(EXAMPLES).filter((n) => n.endsWith('.json'));
  assert.ok(names.length >= 1);
  for (const name of names) {
    const { ok, errors, warnings } = parseLibrary(readFileSync(new URL(name, EXAMPLES), 'utf8'));
    assert.deepEqual(errors, [], name);
    assert.deepEqual(warnings, [], name);
    assert.equal(ok, true, name);
  }
});

test('the file must be JSON with a snippets array, and not over the size cap', () => {
  assert.match(parseLibrary('{').errors[0], /not valid JSON/);
  assert.deepEqual(validateLibrary([]).errors, ['the file must be a JSON object']);
  assert.deepEqual(validateLibrary({}).errors, ['$.snippets: expected an array']);
  assert.match(parseLibrary(' '.repeat(NO_CODE_MAX_BYTES + 1)).errors[0], /limit/);
});

test('patterns and flows must give their operand count; others may not', () => {
  const { errors, warnings } = validateLibrary({ snippets: [
    { name: 'p', type: 'pattern', language: 'strudel', source: 's("bd")' },
    { name: 'f', type: 'flow', language: 'javascript', operands: -1, source: '' },
    { ...drums, operands: 2 },
  ] });
  assert.match(errors[0], /snippets\[0\]\.operands/);
  assert.match(errors[1], /snippets\[1\]\.operands/);
  assert.deepEqual(warnings, ['$.snippets[2].operands: only patterns and flows take operands, ignored']);
});

test('types, languages, placeholders and thumbnail media are checked', () => {
  const { errors } = validateLibrary({ snippets: [
    { name: 'x', type: 'macro' },
    { name: 'y', type: 'pattern', language: 'cobol', operands: 0, source: '' },
    { name: 'z', type: 'pattern', language: 'strudel', operands: 1, source: '{{0}} {{1}}' },
    { name: 'w', type: 'flow', language: 'javascript', operands: 0, source: 'return (' },
    { ...beat, name: 'v', thumbnailImage: '/icons/v.png', thumbnailAudioHover: '/a.mp3' },
    { ...beat, name: 'u', thumbnailImage: 'data:image/svg+xml;base64,AA==', thumbnailAudio: 'data:audio/wav;base64,AA==' },
  ] });
  assert.match(errors[0], /\[0\]\.type/);
  assert.match(errors[1], /\[1\]\.language/);
  assert.match(errors[2], /\{\{1\}\} names an operand/);
  assert.match(errors[3], /\[3\]\.source/);
  assert.match(errors[4], /\[4\]\.thumbnailImage/);
  assert.match(errors[5], /\[4\]\.thumbnailAudioHover/);
  assert.equal(errors.length, 6);
});

test('room fragments are checked with the prebake rules', () => {
  const { errors } = validateLibrary({ snippets: [
    { name: 'r', type: 'room', source: { humans: { a: {} } } },
    { name: 's', type: 'room', source: '{"metaprogram": 3}' },
  ] });
  assert.match(errors[0], /^\$\.snippets\[0\]\.source\.humans\.a/);
  assert.equal(errors[1], '$.snippets[1].source.metaprogram: expected a string');
});

test('singleShot needs exactly one audio, video or text asset', () => {
  const one = (files, extra = {}) => ({ name: 'n', type: 'assetPack', singleShot: true, assets: { files }, ...extra });
  const { errors } = validateLibrary({ snippets: [
    one({ video: [{ name: 'a.mp4', src: '/a.mp4' }, { name: 'b.mp4', src: '/b.mp4' }] }),
    one({ images: [{ name: 'a.gif', src: '/a.gif' }] }),
    { ...beat, singleShot: true },
  ] });
  assert.match(errors[0], /exactly one asset \(this one has 2\)/);
  assert.match(errors[1], /is image; only audio, video and text stream/);
  assert.equal(errors.length, 2);

  const [video, sound, text] = lib([
    one({ video: [{ name: 'a.mp4', src: '/a.mp4' }] }, { name: 'v' }),
    { name: 's', type: 'assetPack', singleShot: true, assets: { samples: { k: [{ name: 'x.wav', src: '/x.wav' }] } } },
    one({ text: [{ name: 'poem.txt', src: '/poem.txt' }] }, { name: 't' }),
  ]);
  assert.equal(singleShotAsset(video).medium, 'video');
  assert.equal(singleShotAsset(sound).medium, 'audio');
  assert.equal(singleShotAsset(text).medium, 'text');
});

test('hover and click each have their own audio, falling back to thumbnailAudio', () => {
  const s = { thumbnailAudio: '/both.wav', thumbnailAudioHover: '/hover.wav' };
  assert.equal(thumbnailAudioFor(s, 'hover'), '/hover.wav');
  assert.equal(thumbnailAudioFor(s, 'click'), '/both.wav');
  assert.equal(thumbnailAudioFor({}, 'click'), null);
});

test('a re-uploaded snippet replaces the one with its name and type, in place', () => {
  const first = lib([beat, hats]);
  const merged = mergeLibrary(first, [{ ...beat, source: 's("bd*2")' }, clouds]);
  assert.deepEqual(merged.map((s) => s.id), ['pattern:beat', 'pattern:hats', 'pattern:clouds']);
  assert.equal(merged[0].source, 's("bd*2")');
  assert.equal(snippetId({ type: 'flow', name: ' x ' }), 'flow:x');
});

test('board edits: add, fill operand slots, nest, remove, move', () => {
  const l = lib([beat, hats, play, drums, either]);
  let b = addLine(emptyBoard(), byName(l, 'either'));
  assert.deepEqual(b.lines[0], { ref: 'flow:either', operands: [null, null] });
  b = placeAt(b, [0, 0], byName(l, 'play'));
  b = placeAt(b, [0, 0, 0], byName(l, 'drums'));
  b = placeAt(b, [0, 1], byName(l, 'hats'));
  assert.equal(b.lines[0].operands[0].operands[0].ref, 'assetPack:drums');
  assert.equal(b.rev, 4);
  b = addLine(b, byName(l, 'beat'), 0);
  assert.equal(b.lines[0].ref, 'pattern:beat');
  b = moveLine(b, 0, 1);
  assert.equal(b.lines[1].ref, 'pattern:beat');
  b = removeAt(b, [0, 1]);
  assert.equal(b.lines[0].operands[1], null);
  b = removeAt(b, [1]);
  assert.equal(b.lines.length, 1);
  // A slot that does not exist leaves the board as it was.
  assert.equal(placeAt(b, [0, 5], byName(l, 'beat')), b);
});

test('sanitizeBoard drops what it cannot address', () => {
  const b = sanitizeBoard({ rev: 3, lines: [{ ref: 'a', operands: [{ ref: 'b', x: 1 }, 7] }, 'junk', null] });
  assert.deepEqual(b, { rev: 3, lines: [{ ref: 'a', operands: [{ ref: 'b', operands: [] }, null] }] });
});

test('lines run in order and a later write to the same slot overrides', async () => {
  const l = lib([beat, hats, clouds]);
  let b = emptyBoard();
  for (const n of ['beat', 'clouds', 'hats']) b = addLine(b, byName(l, n));
  const { plan, errors } = await runBoard(b, l);
  assert.deepEqual(errors, []);
  assert.equal(readDirective(plan.program).kind, 'personal');
  assert.match(plan.program, /hh\*8/);
  assert.doesNotMatch(plan.program, /bd\*4/);
  assert.match(plan.program, /await initHydra\(\)\nnoise\(3\)\.out\(\)/);
});

test('a pattern substitutes its operands and carries their asset loads', async () => {
  const l = lib([play, drums]);
  let b = addLine(emptyBoard(), byName(l, 'play'));
  b = placeAt(b, [0, 0], byName(l, 'drums'));
  const { plan, errors } = await runBoard(b, l);
  assert.deepEqual(errors, []);
  assert.match(plan.program, /s\("kit\*2"\)/);
  assert.deepEqual(plan.samples.map((s) => s.name), ['bd.wav', 'sn.wav']);
});

test('pattern operands are consumed, not run', async () => {
  const wrap = { name: 'wrap', type: 'pattern', language: 'strudel', operands: 1, source: '{{0}}.fast(2)' };
  const l = lib([wrap, beat]);
  let b = addLine(emptyBoard(), byName(l, 'wrap'));
  b = placeAt(b, [0, 0], byName(l, 'beat'));
  const { plan } = await runBoard(b, l);
  assert.match(plan.program, /s\("bd\*4"\)\.fast\(2\)/);
  assert.equal(plan.program.match(/bd\*4/g).length, 1);
});

test('a flow picks what runs from its operands and ctx', async () => {
  const l = lib([either, both, beat, clouds]);
  let b = addLine(emptyBoard(), byName(l, 'either'));
  b = placeAt(b, [0, 0], byName(l, 'beat'));
  b = placeAt(b, [0, 1], byName(l, 'clouds'));
  assert.match((await runBoard(b, l, { isMyTurn: true })).plan.program, /bd\*4/);
  const off = (await runBoard(b, l, { isMyTurn: false })).plan.program;
  assert.match(off, /noise/);
  assert.doesNotMatch(off, /bd\*4/);

  let c = addLine(emptyBoard(), byName(l, 'both'));
  c = placeAt(c, [0, 0], byName(l, 'beat'));
  c = placeAt(c, [0, 1], byName(l, 'clouds'));
  const p = (await runBoard(c, l)).plan.program;
  assert.match(p, /bd\*4/);
  assert.match(p, /noise/);
});

test('a flow can return an ad-hoc snippet built from operand values', async () => {
  const stack = {
    name: 'stack', type: 'flow', language: 'javascript', operands: 2,
    source: 'return { language: "strudel", source: `stack(${operands[0].value}, ${operands[1].value})` };',
  };
  const l = lib([stack, beat, hats]);
  let b = addLine(emptyBoard(), byName(l, 'stack'));
  b = placeAt(b, [0, 0], byName(l, 'beat'));
  b = placeAt(b, [0, 1], byName(l, 'hats'));
  assert.match((await runBoard(b, l)).plan.program, /stack\(s\("bd\*4"\), s\("hh\*8"\)\)/);
});

test('a failing line is reported and skipped; the rest still run', async () => {
  const boom = { name: 'boom', type: 'flow', language: 'javascript', operands: 0, source: 'throw new Error("nope")' };
  const l = lib([boom, play, beat]);
  let b = emptyBoard();
  b = addLine(b, byName(l, 'boom'));
  b = addLine(b, byName(l, 'play'));
  b = addLine(b, byName(l, 'beat'));
  b = { ...b, lines: [...b.lines, { ref: 'pattern:gone', operands: [] }] };
  const { plan, errors } = await runBoard(b, l);
  assert.deepEqual(errors.map((e) => e.line), [0, 1, 3]);
  assert.match(errors[0].message, /nope/);
  assert.match(errors[1].message, /missing operand 1 of 1/);
  assert.match(errors[2].message, /not in the library/);
  assert.match(plan.program, /bd\*4/);
});

test('room fragments merge per key and per participant, later lines winning', async () => {
  const r1 = { name: 'r1', type: 'room', source: { metaprogram: 'a', humans: { 0: { displayName: 'Ann' }, 1: { displayName: 'Bo' } } } };
  const r2 = { name: 'r2', type: 'room', source: '{"humans": {"1": {"displayName": "Cy"}}}' };
  const l = lib([r1, r2]);
  let b = addLine(emptyBoard(), byName(l, 'r1'));
  b = addLine(b, byName(l, 'r2'));
  const { plan } = await runBoard(b, l);
  assert.deepEqual(plan.prebake, { metaprogram: 'a', humans: { 0: { displayName: 'Ann' }, 1: { displayName: 'Cy' } } });
  assert.equal(plan.program, null);
});

test('a metaprogram pattern lands in the plan with its directive', async () => {
  const mp = { name: 'mp', type: 'pattern', language: 'metaprogram', operands: 0, source: '[0 1]' };
  const l = lib([mp]);
  const { plan } = await runBoard(addLine(emptyBoard(), l[0]), l);
  assert.equal(readDirective(plan.metaprogram).kind, 'metaprogram');
  assert.equal(plan.program, null);
});

test('ctx.random is the same for the same board revision', async () => {
  const dice = { name: 'dice', type: 'flow', language: 'javascript', operands: 0, source: 'return `s("${ctx.random()}")`;' };
  const l = lib([dice]);
  const b = addLine(emptyBoard(), l[0]);
  assert.equal((await runBoard(b, l)).plan.program, (await runBoard(b, l)).plan.program);
});

test('a flow can await ctx.fetchJson, and a board run without it says so', async () => {
  const live = {
    name: 'live', type: 'flow', language: 'javascript', operands: 0,
    source: 'const d = await ctx.fetchJson("https://example.test/beat"); return `s("${d.beat}")`;',
  };
  const l = lib([live]);
  const b = addLine(emptyBoard(), l[0]);
  const asked = [];
  const fetchJson = async (url) => { asked.push(url); return { beat: 'bd*3' }; };
  assert.match((await runBoard(b, l, { fetchJson })).plan.program, /s\("bd\*3"\)/);
  assert.deepEqual(asked, ['https://example.test/beat']);
  const { errors } = await runBoard(b, l);
  assert.match(errors[0].message, /without network access/);
});

test('the weather examples theme the Studio from whatever the APIs answer', async () => {
  const l = parseLibrary(readFileSync(new URL('weather-library.json', EXAMPLES), 'utf8')).snippets;
  const fetchJson = async (url) => {
    if (url.includes('mars.nasa.gov')) {
      return { soles: [{ sol: '4995', terrestrial_date: '2026-08-25', ls: '341', min_temp: '-71', max_temp: '-5', atmo_opacity: 'Sunny', sunrise: '06:46', sunset: '18:51' }] };
    }
    if (url.includes('hourly=')) {
      return { hourly: { weather_code: [0, 3, 61, 95, 71, 45, 2, 1], is_day: [1, 1, 1, 0, 0, 0, 1, 1], temperature_2m: [5, 5, 4, 3, -2, -3, 1, 2] } };
    }
    return { current: { weather_code: 95, is_day: 1, temperature_2m: 31, wind_speed_10m: 60 } };
  };
  const run = async (flow, place) => {
    let b = addLine(emptyBoard(), byName(l, flow));
    if (place) b = placeAt(b, [0, 0], byName(l, place));
    const { plan, errors } = await runBoard(b, l, { fetchJson });
    assert.deepEqual(errors, [], flow);
    // What the room evaluates: the program after its preamble, css() rewritten
    // and wrapped voice by voice with the JPattern gate (strudel.js
    // buildPeerBlock). It must still parse, or the whole room program fails.
    const code = normalizePeerCode(plan.program);
    const body = code.slice(code.search(/\n\n/)).trim();
    const voice = wrapAsVoice(rewriteCssCalls(body, { peer: 'p', counter: { n: 0 } }).code, '.gain(_jpGate("p"))');
    assert.doesNotThrow(() => compileFlow(voice), flow);
    return plan.program;
  };

  const storm = await run('Weather theme', 'Tokyo');
  assert.match(storm, /css\(`\.ts-window/);
  assert.match(storm, /\.fast\(4\)/);
  assert.match(await run('Forecast theme', 'London'), /backgroundColor\("<#[0-9a-f]{6}( #[0-9a-f]{6}){7}>"\)/);
  assert.match(await run('Mars weather theme'), /backgroundColor\("#[0-9a-f]{6}"\)/);

  const bare = await runBoard(addLine(emptyBoard(), byName(l, 'Weather theme')), l, { fetchJson });
  assert.match(bare.errors[0].message, /missing operand 1/);
});
