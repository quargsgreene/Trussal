import test from 'node:test';
import assert from 'node:assert/strict';

import {
  botScriptFor,
  captureClusterSource,
  dropTextStatements,
  dropCssStatements,
  masterFromPerformerCode,
} from '../src/script-gen/cluster-source.js';
import { validateCode } from '../src/script-gen/validate.js';

const capture = (code) => captureClusterSource(code, { seed: 7 }).source;

// --- Deriving the master from a performer's editor ---------------------------

test('plain Strudel becomes a master with no hydra', () => {
  assert.deepEqual(masterFromPerformerCode('s("bd sd")'), { strudel: 's("bd sd")', hydra: '' });
});

test('a Hydra block splits at the blank line, as the browser splits it', () => {
  const master = masterFromPerformerCode('await initHydra()\nosc(10).out(o0)\n\ns("bd sd")');
  assert.equal(master.hydra, 'await initHydra()\nosc(10).out(o0)');
  assert.equal(master.strudel, 's("bd sd")');
});

test('the botConfig declaration is not part of what bots play', () => {
  const master = masterFromPerformerCode('botConfig({ harmony: "+7" })\ns("bd sd")');
  assert.equal(master.strudel, 's("bd sd")');
  assert.ok(!master.strudel.includes('botConfig'));
});

test('empty code yields no master', () => {
  assert.equal(masterFromPerformerCode('   '), null);
});

// --- Capture -----------------------------------------------------------------

test('capture records the config and marks it declared', () => {
  const res = captureClusterSource('botConfig({ harmony: "+7" })\ns("bd sd")', { seed: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.source.declared, true);
  assert.equal(res.source.config.harmony, '+7');
});

test('code without a declaration is captured as an exact-copy cluster', () => {
  const res = captureClusterSource('s("bd sd")', { seed: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.source.declared, false);
  assert.equal(res.source.config.harmony, null);
});

test('a broken config is reported but still spawns exact copies', () => {
  const res = captureClusterSource('botConfig({ harmony: "sideways" })\ns("bd sd")', { seed: 1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /harmony/);
  assert.equal(res.source.master.strudel, 's("bd sd")');
  assert.equal(res.source.config.harmony, null, 'the cluster falls back to copies');
});

test('a spawn with no code falls back to the supplied master', () => {
  const fallback = { strudel: 's("hh*4")', hydra: '' };
  const res = captureClusterSource('', { fallbackMaster: fallback, seed: 1 });
  assert.deepEqual(res.source.master, fallback);
});

// --- The default: exact copies ----------------------------------------------

test('a bare botConfig() makes every bot play what the human plays', () => {
  const source = capture('botConfig()\ns("bd sd").cutoff(800)');
  for (const index of [0, 1, 2]) {
    const script = botScriptFor(source, { index, count: 3, seed: 7, botId: index });
    assert.equal(script.strudel, 's("bd sd").cutoff(800)');
  }
});

test('no declaration at all also makes exact copies', () => {
  const source = capture('s("bd sd")');
  const script = botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 });
  assert.equal(script.strudel, 's("bd sd")');
});

test('an exact-copy bot announces exactly what was in the human editor, not an invented word() voice', () => {
  const source = capture('botConfig()\ns("bd sd").cutoff(800)');
  const script = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 });
  assert.equal(script.announceStrudel, 's("bd sd").cutoff(800)');
});

// --- Individual properties ---------------------------------------------------

test('paramFactor scales parameters but not mini notation', () => {
  const source = capture('botConfig({ paramFactor: 2 })\ns("bd*2 sd").cutoff(400)');
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.match(script.strudel, /cutoff\(800\)/);
  assert.match(script.strudel, /bd\*2/);
});

test('random:"params" varies per bot but rebuilds identically for one bot', () => {
  const source = capture('botConfig({ random: "params" })\ns("bd").cutoff(400)');
  const a = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 });
  const b = botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 });
  assert.notEqual(a.strudel, b.strudel, 'different bots must differ');
  assert.deepEqual(botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 }), a);
});

test('random:"params" reaches scale degrees inside a quoted pattern, not just bare Hydra args', () => {
  const source = capture('botConfig({ random: "params" })\nn("0 2 4").scale("C:minor")');
  const a = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 }).strudel;
  const b = botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 }).strudel;
  assert.notEqual(a, 'n("0 2 4").scale("C:minor")', 'the quoted degrees must move too');
  assert.notEqual(b, 'n("0 2 4").scale("C:minor")');
  assert.notEqual(a, b, 'different bots must differ');
  assert.match(a, /^n\("0 -?\d+(\.\d+)? -?\d+(\.\d+)?"\)\.scale\("C:minor"\)$/);
});

test('random:"full" abandons the human code for the curated palette', () => {
  // A patch with a signature the palette cannot coincidentally contain — the
  // palette does include "bd sd", so testing for that would pass either way.
  const source = capture('botConfig({ random: "full" })\ns("cp:3 rim:7").cutoff(1234)');
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(!script.strudel.includes('cp:3'), 'the human patch is replaced');
  assert.ok(!script.strudel.includes('1234'), 'including its parameters');
  assert.equal(validateCode(script.strudel).ok, true, 'and the replacement is valid');
  assert.equal(validateCode(script.hydra).ok, true);
  // The curated palette's own word() and css() voices ride along too — the
  // whole point of "full" is that nothing about the human's editor survives,
  // words and styling included, so this is the one mode that still gets
  // invented voices even though the cluster is declared.
  assert.match(script.announceStrudel, /\bword\(/);
  assert.match(script.announceStrudel, /\bcss\(/);
  // Neither ever reaches the bot's own REPL — same rule as an announced human
  // voice, since that REPL has neither capability installed.
  assert.ok(!script.strudel.includes('word('));
  assert.ok(!script.strudel.includes('css('));
});

test('harmony spreads a cluster into a voicing, leaving bot 0 at pitch', () => {
  const source = capture('botConfig({ harmony: "+3" })\nnote("c3")');
  assert.equal(botScriptFor(source, { index: 0, count: 3, seed: 7, botId: 0 }).strudel, 'note("c3")');
  assert.match(botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 }).strudel, /\.add\(note\(3\)\)/);
  assert.match(botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 }).strudel, /\.add\(note\(6\)\)/);
});

test('diatonic harmony reads the human scale', () => {
  const source = capture('botConfig({ harmony: "diatonic" })\nn("0 2 4").scale("C:minor")');
  const script = botScriptFor(source, { index: 2, count: 3, seed: 7, botId: 2 });
  assert.match(script.strudel, /\.add\(n\(2\)\)/);
});

// --- announceStrudel reflects what the bot actually plays --------------------
//
// announceStrudel is peer-state's `pattern` for a bot — what the studio shows
// in its editor and what a late joiner sees. It used to be computed from the
// unshaped human original: paramFactor/random:"params"/harmony changed what
// the bot's own REPL played but never touched announceStrudel, so a bot's
// editor showed a plain copy of the human's code no matter what botConfig
// asked for — "the bot's editor should always display exactly what it's
// streaming" was violated by construction, not by any turn-taking or
// remote-edit path.

test('announceStrudel reflects paramFactor, not the unshaped human original', () => {
  const source = capture('botConfig({ paramFactor: 2 })\ns("bd").cutoff(400)');
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.match(script.announceStrudel, /cutoff\(800\)/);
});

test('announceStrudel reflects random:"params", identically to what plays', () => {
  const source = capture('botConfig({ random: "params" })\ns("bd").cutoff(400)');
  const script = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 });
  assert.notEqual(script.announceStrudel, 's("bd").cutoff(400)', 'must not be the unshaped original');
  // Nothing generated (random:"params" reshapes the human's own code, it
  // doesn't invent a voice) and no word()/css() to drop, so the announced text
  // must be exactly the audio the bot's own REPL evaluates — the editor
  // showing exactly what is streaming.
  assert.equal(script.announceStrudel, script.strudel);
});

test('announceStrudel reflects harmony', () => {
  const source = capture('botConfig({ harmony: "+3" })\nnote("c3")');
  const script = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 });
  assert.match(script.announceStrudel, /\.add\(note\(3\)\)/);
  assert.ok(script.announceStrudel.startsWith(script.strudel));
});

test('composed properties (paramFactor + harmony) all reach announceStrudel together', () => {
  const source = capture('botConfig({ paramFactor: 2, harmony: "+5" })\nnote("c3").cutoff(400)');
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.match(script.announceStrudel, /cutoff\(800\)/, 'paramFactor reached the announce');
  assert.match(script.announceStrudel, /\.add\(note\(5\)\)/, 'harmony reached the announce');
  assert.ok(script.announceStrudel.startsWith(script.strudel));
});

test('colorScheme chains onto the master pipeline, before its own .out(o0)', () => {
  const source = capture('botConfig({ colorScheme: "triadic" })\nawait initHydra()\nosc(10).out(o0)\n\ns("bd")');
  const script = botScriptFor(source, { index: 1, count: 3, seed: 7, botId: 1 });
  assert.match(script.hydra, /^await initHydra\(\)/);
  assert.match(script.hydra, /osc\(10\)\.hue\(0\.333\)\.out\(o0\)$/);
  assert.ok(!script.hydra.includes('src(o0)'), 'no separate src(o0) statement');
});

test('colorScheme on a bot with no hydra adds nothing', () => {
  const source = capture('botConfig({ colorScheme: "triadic" })\ns("bd")');
  assert.equal(botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 }).hydra, '');
});

// --- word()/css() in a bot's announce --------------------------------------
//
// script.strudel is what the bot's OWN REPL evaluates — that REPL is a
// separate, minimal Strudel instance with neither Text nor CSS Cycles
// installed, so word()/css() must ALWAYS be stripped from it. script.
// announceStrudel is the separate string peer-state broadcasts, picked up and
// painted by every OTHER performer's own browser (buildBotSilentBlock in
// strudel.js). An undeclared (exact-copy) cluster keeps the author's
// word()/css() voices there; any `botConfig(...)` declaration strips them, so
// a cluster of N bots does not repeat one author's words N times over in
// every viewer's chat panel.

test('a declared cluster drops the author\'s words from eval AND announce, and invents none', () => {
  const code = 'botConfig({ harmony: "+2" })\nawait initTextCycles()\n\n$: word("hello")\n$: s("bd sd")';
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(!script.strudel.includes('word('), 'a cluster must not repeat its author\'s words');
  assert.match(script.strudel, /s\("bd sd"\)/, 'the audio voice survives');
  assert.ok(!script.announceStrudel.includes('word('), 'a declared cluster does not carry the author\'s words, and none are invented in their place');
});

test('a declared cluster drops css() from eval AND announce', () => {
  const code = 'botConfig({ harmony: "+2" })\nawait initCss()\n\n$: css(`.x{color:red}`)\n$: s("bd sd")';
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(!script.strudel.includes('css('), 'the bot\'s own REPL has no css() — it would crash');
  assert.match(script.strudel, /s\("bd sd"\)/, 'the audio voice survives');
  assert.ok(!script.announceStrudel.includes('css('), 'a declared cluster does not carry the author\'s styling');
});

test('no botConfig() at all announces the performer\'s own words and styling — a true exact copy', () => {
  const code = 'await initTextCycles()\nawait initCss()\n\n$: word("hello")\n$: css(`.x{color:red}`)\n$: s("bd sd")';
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(!script.strudel.includes('word(') && !script.strudel.includes('css('), 'still never in eval — that REPL has neither capability');
  assert.match(script.announceStrudel, /word\("hello"\)/, 'undeclared means an exact copy includes the performer\'s words');
  assert.match(script.announceStrudel, /css\(`\.x\{color:red\}`\)/, 'and their styling too');
});

test('an explicit but empty botConfig() is still a declaration — words and styling are dropped from the announce', () => {
  const code = 'botConfig()\nawait initTextCycles()\n\n$: word("hello")\n$: s("bd sd")';
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(!script.announceStrudel.includes('word('), 'declaring botConfig() at all opts out of the undeclared mirror');
});

test('dropTextStatements leaves a wordless pattern untouched', () => {
  assert.equal(dropTextStatements('s("bd sd")'), 's("bd sd")');
});

// A performer combining audio and words in ONE stack(), vanilla Strudel's own
// idiom for layering — not the two-`$:`-voices convention above — must not
// lose its audio: dropping the whole statement here left bots with an empty
// program (no code, no sound) any time a human wrote it this way.
test('word() inside a stack() loses only its own branch, not its siblings', () => {
  const code = [
    'botConfig()',
    'await initTextCycles()',
    '',
    'stack(',
    '  s("bd sd").room(.3),',
    '  word("come dance").color("#ffffff")',
    ')',
  ].join('\n');
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });
  assert.ok(script.strudel.trim() !== '', 'the cluster must still have something to play');
  assert.match(script.strudel, /s\("bd sd"\)\.room\(\.3\)/, 'the audio branch survives');
  assert.ok(!script.strudel.includes('word('), 'the word() branch is gone');
  assert.equal(validateCode(script.strudel).ok, true);
});

test('a stack() of nothing but words still drops the whole statement', () => {
  const code = [
    'stack(',
    '  word("hello"),',
    '  w("world")',
    ')',
  ].join('\n');
  assert.equal(dropTextStatements(code), '');
});

test('word() chained directly onto a pattern (no stack) still drops whole', () => {
  // Per the docs, a dominant text trigger already silences this hap, so
  // nothing salvageable is left once word() is gone.
  assert.equal(dropTextStatements('s("bd").word("x")'), '');
});

// --- CSS: dropCssStatements, the css() sibling of dropTextStatements ---------
//
// A bot's own audio-producing REPL is a separate, vanilla @strudel/repl
// fetched fresh from unpkg (see page-scripts.js pageStrudelBoot) — it never
// gets Trussal's installCssCycles the way the main Jitsi page does, so `css(`
// and `await initCss()` are undefined there and dropCssStatements always
// strips it from what that REPL evaluates. An undeclared (exact-copy) cluster
// still gets css() to the room by keeping it in announceStrudel instead — the
// separate string peer-state broadcasts, which every OTHER viewer's own page
// paints (buildBotSilentBlock in strudel.js).

test('dropCssStatements leaves css-free code untouched', () => {
  assert.equal(dropCssStatements('s("bd sd")'), 's("bd sd")');
});

test('dropCssStatements drops a css() voice entirely, including its declaration', () => {
  const code = 'await initCss()\n$: css(`.foo{color:red}`).fast(3)\n\nn("<0 1>").s("piano")';
  const out = dropCssStatements(code);
  assert.ok(!out.includes('css('), 'the css() call is gone');
  // initCss() alone does nothing useful without a css() to drive — it is a
  // capability declaration for a capability this REPL cannot run, and the
  // fewer half-declarations left behind, the fewer surprises later.
  assert.ok(!/await\s+initCss/.test(out));
  assert.match(out, /n\("<0 1>"\)\.s\("piano"\)/, 'the audio pattern survives');
  assert.equal(validateCode(out).ok, true);
});

test('css() inside a stack() loses only its own branch, not its siblings', () => {
  const code = [
    'await initCss()',
    '',
    'stack(',
    '  s("bd sd").room(.3),',
    '  css(`.foo{color:red}`).fast(3)',
    ')',
  ].join('\n');
  const out = dropCssStatements(code);
  assert.match(out, /s\("bd sd"\)\.room\(\.3\)/, 'the audio branch survives');
  assert.ok(!out.includes('css('), 'the css() branch is gone');
  assert.equal(validateCode(out).ok, true);
});

// The exact shape captured live: Hydra split off by masterFromPerformerCode,
// text and css each declared inline with their own $: voice, and a trailing
// UNLABELED audio pattern — the combination that was crash-looping every bot
// in the room with "pattern did not start after evaluation" until both the
// wrapAsVoice fix and dropCssStatements landed.
test('botScriptFor never hands the bot REPL a css() voice, end to end', () => {
  const code = [
    'await initHydra()',
    'osc(100)',
    '.out()',
    '',
    'await initTextCycles()',
    '$: typeface(\'Times New Roman\').word("<I like squirrels>")',
    '     .weight("400 200")',
    '',
    'await initCss()',
    '$: css(`.foo { color: red }`)',
    '     .fast(4)',
    '',
    'n("<0 1 2 3 4>*8").s("gm_lead_6_voice")',
  ].join('\n');
  const source = capture(code);
  const script = botScriptFor(source, { index: 0, count: 1, seed: 7, botId: 1 });
  assert.ok(!script.strudel.includes('css('), 'no css() reaches the bot REPL');
  assert.ok(!/await\s+initCss/.test(script.strudel));
  assert.ok(!script.strudel.includes('word('), 'the bot REPL never gets word() either');
  assert.match(script.strudel, /n\("<0 1 2 3 4>\*8"\)\.s\("gm_lead_6_voice"\)/, 'the audio pattern survives');
  assert.equal(validateCode(script.strudel).ok, true);
  assert.equal(validateCode(script.hydra).ok, true);
});

// --- Composition -------------------------------------------------------------

test('properties compose, and the result is still valid code', () => {
  const code = [
    'botConfig({ paramFactor: 2, harmony: "+5", colorScheme: "complementary" })',
    'await initHydra()',
    'osc(10, 0.1).out(o0)',
    '',
    'note("c3 e3").cutoff(400)',
  ].join('\n');
  const source = capture(code);
  const script = botScriptFor(source, { index: 1, count: 2, seed: 7, botId: 1 });

  assert.match(script.strudel, /cutoff\(800\)/, 'paramFactor applied');
  assert.match(script.strudel, /\.add\(note\(5\)\)/, 'harmony applied');
  assert.match(script.hydra, /osc\(20, 0\.2\)/, 'paramFactor reaches hydra');
  assert.match(script.hydra, /hue\(0\.5\)/, 'colour applied');
  assert.equal(validateCode(script.strudel).ok, true);
  assert.equal(validateCode(script.hydra).ok, true);
});

test('every generated script parses, across the property matrix', () => {
  const configs = [
    'botConfig()',
    'botConfig({ random: "params" })',
    'botConfig({ random: "full" })',
    'botConfig({ paramFactor: 0.5 })',
    'botConfig({ harmony: "diatonic" })',
    'botConfig({ harmony: "-13" })',
    'botConfig({ harmony: "random" })',
    'botConfig({ colorScheme: "square" })',
    'botConfig({ colorScheme: "monochromatic" })',
  ];
  const body = 'await initHydra()\nosc(10, 0.1).out(o0)\n\nn("0 2 4").scale("C:minor").cutoff(600)';

  for (const decl of configs) {
    const source = capture(`${decl}\n${body}`);
    for (let index = 0; index < 3; index++) {
      const script = botScriptFor(source, { index, count: 3, seed: 7, botId: index });
      assert.equal(validateCode(script.strudel).ok, true, `${decl} bot ${index} strudel`);
      assert.equal(validateCode(script.hydra).ok, true, `${decl} bot ${index} hydra`);
      assert.equal(validateCode(script.announceStrudel).ok, true, `${decl} bot ${index} announceStrudel`);
    }
  }
});
