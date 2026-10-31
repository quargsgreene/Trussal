import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMultimedia,
  silentRenderer,
  injectMultiPeer,
  mediaOf,
  ownsMedium,
  TurnLedger,
  MULTI_CALL_RE,
  HYDRA_VALUE_KEY,
} from '../src/multimedia-core.js';
import { rewriteTextCalls } from '../src/text-cycles-core.js';
import { rewriteCssCalls } from '../src/css-cycles-core.js';
import { mosaicCellSource, sequencesHydra } from '../src/hydra-code.js';

// The fork's source rather than node_modules' @strudel/core: that dist imports
// a browser-only synth package at load time.
const ns = await import('../strudel-fork/packages/core/index.mjs');

// A room whose cycle and turn the test moves by hand.
function room({ allows, renderHydra } = {}) {
  const state = { cycle: 0, onTurn: true, rendered: [] };
  const mm = createMultimedia(ns, {
    now: () => state.cycle,
    isOnTurn: () => state.onTurn,
    allows,
    renderHydra: renderHydra || ((req) => state.rendered.push(req)),
  });
  return { state, mm };
}

// Onsets in [begin, end) as "cycle:value", sorted by time.
function onsets(pat, begin, end) {
  return pat.queryArc(begin, end)
    .filter((hap) => hap.hasOnset())
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf())
    .map((hap) => `${hap.whole.begin.valueOf()}:${typeof hap.value === 'object' ? JSON.stringify(hap.value) : hap.value}`);
}

// A stand-in for a Hydra GlslSource: the duck-typed shape multimedia-core
// recognises, recording what is blended into it.
function fakeHydraSource(name, synth = fakeSynth()) {
  return {
    type: 'GlslSource',
    transforms: [{ name }],
    synth,
    out() {},
    blend(other, amount) {
      return { ...fakeHydraSource(`${name}+${other.transforms[0].name}@${amount}`, synth), parts: [this, other] };
    },
  };
}
function fakeSynth() {
  const synth = { generators: {} };
  synth.generators.solid = () => fakeHydraSource('solid', synth);
  return synth;
}

// --- media --------------------------------------------------------------------

test('multimedia: a hap value is audio unless it carries a silent medium key', () => {
  assert.deepEqual(mediaOf({ s: 'bd', note: 40 }), []);
  assert.deepEqual(mediaOf('c3'), []);
  assert.deepEqual(mediaOf({ word: 'tc0' }), ['text']);
  assert.deepEqual(mediaOf({ css: 'cc0', _cc_color: 'cc1' }), ['css']);
  assert.deepEqual(mediaOf({ image: 'fc0' }), ['file']);
  assert.deepEqual(mediaOf({ [HYDRA_VALUE_KEY]: true }), ['hydra']);
  assert.deepEqual(mediaOf({ word: 'tc0', css: 'cc0' }), ['text', 'css']);
  assert.equal(ownsMedium({ assign: 'bk0' }, 'breakout'), true);
  assert.equal(ownsMedium({ s: 'bd' }, 'text'), false);
});

// --- renderers ----------------------------------------------------------------

test('multimedia: a renderer still claims every hap of an ordinary voice', () => {
  const calls = [];
  const render = silentRenderer((hap) => calls.push(hap.value), 'text');
  const haps = render(ns.stack(ns.s('bd'), ns.pure({ word: 'tc0' }))).queryArc(0, 1);
  assert.equal(haps.length, 2);
  assert.ok(haps.every((hap) => hap.context.dominantTrigger), 'untagged haps are all silenced, as before');
});

test('multimedia: inside a multi pattern a renderer claims only its own medium', () => {
  const { mm } = room();
  const calls = [];
  const text = silentRenderer((hap) => calls.push(hap.value.word), 'text');
  const css = silentRenderer(() => calls.push('css'), 'css');
  const pat = css(text(mm.multiStack('p', ns.s('bd'), ns.pure({ word: 'tc0' }), ns.pure({ css: 'cc0' }))));
  const byKind = Object.fromEntries(pat.queryArc(0, 1).map((hap) => [Object.keys(hap.value)[0], hap]));
  assert.equal(byKind.s.context.dominantTrigger, undefined, 'the drums still reach webaudio');
  assert.equal(byKind.word.context.dominantTrigger, true);
  assert.equal(byKind.css.context.dominantTrigger, true);
  byKind.word.context.onTrigger(byKind.word, 0, 1, 0);
  byKind.css.context.onTrigger(byKind.css, 0, 1, 0);
  assert.deepEqual(calls, ['tc0', 'css'], 'each hap reaches only its own renderer');
});

// --- turn clock ---------------------------------------------------------------

test('multimedia: with no turn changes the turn clock is the room clock', () => {
  const ledger = new TurnLedger();
  ledger.observe(3.5, true);
  assert.equal(ledger.points.length, 0);
  assert.equal(ledger.turnTime(10.25), 10.25);
});

test('multimedia: a turn clock stands still off-turn and re-enters on a whole-cycle offset', () => {
  const ledger = new TurnLedger();
  ledger.observe(2.5, false);
  assert.equal(ledger.turnTime(5), 2.5, 'frozen where the turn ended');
  ledger.observe(6.25, true);
  // ceil(6.25 - 2.5) = 4 cycles behind the room: the beat phase is kept and
  // the quarter cycle after 2.25 is heard again rather than skipped.
  assert.equal(ledger.turnTime(6.25), 2.25);
  assert.equal(ledger.turnTime(8), 4);
});

test('multimedia: a scheduler that restarts from zero clears the turn history', () => {
  const ledger = new TurnLedger();
  ledger.observe(40, false);
  ledger.observe(0.5, true);
  assert.equal(ledger.points.length, 0);
  assert.equal(ledger.turnTime(0.5), 0.5);
});

test('multimedia: multiArrange picks up where it left off on the next turn', () => {
  const { state, mm } = room();
  const pat = mm.multiArrange('p', [2, ns.pure('a')], [2, ns.pure('b')], [2, ns.pure('c')]);
  state.cycle = 0;
  assert.deepEqual(onsets(pat, 0, 3), ['0:a', '1:a', '2:b']);
  state.cycle = 3;
  state.onTurn = false;
  assert.deepEqual(onsets(pat, 3, 9), [], 'silent while someone else has the turn');
  state.cycle = 9;
  state.onTurn = true;
  // Plain arrange() would be at cycle 9 → "b" (9 mod 6 = 3). This resumes at
  // turn time 3, the second cycle of "b", then moves on to "c".
  assert.deepEqual(onsets(pat, 9, 12), ['9:b', '10:c', '11:c']);
});

test('multimedia: resume:false follows the room clock exactly like arrange()', () => {
  const { state, mm } = room();
  const sections = [[2, ns.pure('a')], [1, ns.pure('b')]];
  const pat = mm.multiArrange('p', ...sections, { resume: false });
  state.onTurn = false;
  state.cycle = 5;
  assert.deepEqual(onsets(pat, 0, 6), onsets(ns.arrange(...sections), 0, 6));
});

test('multimedia: a nested multiArrange is not moved by the same turns twice', () => {
  const { state, mm } = room();
  const inner = mm.multiArrange('p', [1, ns.pure('x')], [1, ns.pure('y')]);
  const outer = mm.multiArrange('p', [4, inner], [2, ns.pure('z')]);
  state.cycle = 0;
  assert.deepEqual(onsets(outer, 0, 4), ['0:x', '1:y', '2:x', '3:y']);
  state.cycle = 4;
  state.onTurn = false;
  assert.deepEqual(onsets(outer, 4, 8), []);
  state.cycle = 8;
  state.onTurn = true;
  assert.deepEqual(onsets(outer, 8, 10), ['8:z', '9:z']);
});

test('multimedia: each performer keeps a turn clock of their own', () => {
  const turns = { a: true, b: true };
  const env = { cycle: 0 };
  const mm = createMultimedia(ns, { now: () => env.cycle, isOnTurn: (peer) => turns[peer] });
  const a = mm.multiArrange('a', [1, ns.pure('a0')], [1, ns.pure('a1')]);
  const b = mm.multiArrange('b', [1, ns.pure('b0')], [1, ns.pure('b1')]);
  env.cycle = 0;
  turns.b = false;
  onsets(a, 0, 1);
  onsets(b, 0, 1);
  env.cycle = 1;
  turns.b = true;
  assert.deepEqual(onsets(a, 1, 2), ['1:a1']);
  assert.deepEqual(onsets(b, 1, 2), ['1:b0'], 'b was off-turn for cycle 0, so it is still on its first section');
});

// --- members --------------------------------------------------------------------

test('multimedia: a section stacks its members, and a trailing object is options', () => {
  const { mm } = room();
  const pat = mm.multiArrange('p', [1, ns.pure('a'), ns.pure('b')], { resume: false });
  assert.deepEqual(onsets(pat, 0, 1), ['0:a', '0:b']);
});

test('multimedia: a Hydra chain becomes a silent section that renders on its trigger', () => {
  const { state, mm } = room();
  const osc = fakeHydraSource('osc');
  const pat = mm.multiArrange('p', [1, ns.s('bd')], [1, osc], { output: 'o2', resume: false });
  const [hap] = pat.queryArc(1, 2);
  assert.deepEqual(mediaOf(hap.value), ['hydra']);
  assert.equal(hap.context.dominantTrigger, true, 'a Hydra section never reaches webaudio');
  assert.equal(hap.context.multimedia, true);
  hap.context.onTrigger(hap, 0.5, 1, 0.6);
  assert.equal(state.rendered.length, 1);
  assert.equal(state.rendered[0].source, osc);
  assert.equal(state.rendered[0].output, 'o2');
  assert.equal(state.rendered[0].peer, 'p');
});

test('multimedia: stacked Hydra chains are mixed evenly onto a fresh source', () => {
  const { state, mm } = room();
  const synth = fakeSynth();
  const a = fakeHydraSource('a', synth);
  const b = fakeHydraSource('b', synth);
  const c = fakeHydraSource('c', synth);
  const [hap] = mm.multiStack('p', a, b, c).queryArc(0, 1);
  hap.context.onTrigger(hap, 0, 1, 0);
  assert.equal(state.rendered[0].source.transforms[0].name, 'solid+a@1+b@0.5+c@0.3333333333333333');
  assert.deepEqual(a.transforms, [{ name: 'a' }], "the performer's own chain is not mutated");
});

test('multimedia: a Hydra chain written with .out() is reported, not silently dropped', () => {
  const { mm } = room();
  assert.throws(() => mm.multiArrange('p', [2, undefined]), /without \.out\(\)/);
  assert.throws(() => mm.multiArrange('p', [0, ns.pure('a')]), /positive number of cycles/);
  assert.throws(() => mm.multiArrange('p', ns.pure('a')), /\[cycles, pattern/);
});

test('multimedia: the page policy drops the media a peer may not play here', () => {
  const { mm } = room({ allows: (peer, medium) => medium === 'text' });
  const pat = mm.multiStack('remote', ns.s('bd'), ns.pure({ word: 'tc0' }), fakeHydraSource('osc'));
  assert.deepEqual(pat.queryArc(0, 1).map((hap) => mediaOf(hap.value)), [['text']]);
});

// --- source rewriting -----------------------------------------------------------

test('multimedia: every call is rewritten to carry its author', () => {
  const code = '$: multiArrange([4, multiStack(s("bd"), osc(1))])\n$: x.multiStack(1)';
  assert.equal(injectMultiPeer(code, 'ab12'),
    "$: _mmArrange('ab12', [4, _mmStack('ab12', s(\"bd\"), osc(1))])\n$: x.multiStack(1)");
  assert.equal(injectMultiPeer('multiStack()', "o'k"), "_mmStack('o\\'k', )");
  assert.ok(MULTI_CALL_RE.test('  multiArrange ('));
  assert.ok(!MULTI_CALL_RE.test('pat.multiArrange('));
});

test('multimedia: the text and css rewrites reach inside a multi statement and leave it valid', () => {
  const src = [
    '$: multiArrange(',
    '  [2, s("bd*2"), word("<hello there>")],',
    '  [2, n("0 2"), css(`.ts-chip {}`).borderColor("<#f0a #0fa>")]',
    ')',
  ].join('\n');
  // In buildPeerBlock's order: css, then text, then the author.
  const css = rewriteCssCalls(src, { peer: 'p' });
  const text = rewriteTextCalls(css.code, { peer: 'p' });
  const code = injectMultiPeer(text.code, 'p');
  assert.equal(css.errors.length, 0);
  assert.deepEqual(css.sheets.map((s) => s.props.map((p) => p.prop)), [['border-color']]);
  assert.deepEqual(Object.values(text.atoms).map((a) => a.text), ['hello', 'there']);
  // One renderer each, on the whole statement — which is safe now that they
  // only claim their own medium (see the renderer test above).
  assert.match(code, /^\$: _mmArrange\('p', \n/);
  assert.match(code, /\)\n\._ccRender\(\)\n\._tcRender\(\)$/);
  assert.equal(code.match(/Render\(\)/g).length, 2);
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(code), 'the rewritten statement still parses');
});

// --- mosaic ---------------------------------------------------------------------

test('multimedia: Hydra sequenced from the Strudel half is blitted, not re-executed', () => {
  const sequenced = "'personal editor'\n$: multiArrange([4, s(\"bd\"), osc(10)], [4, noise(3)])";
  assert.equal(sequencesHydra(sequenced), true);
  assert.equal(mosaicCellSource(sequenced), 'blit');
  // An audio-only arrangement next to a preamble that draws on its own still
  // re-executes — the aggregator can reproduce that preamble by itself.
  const preamble = "'personal editor'\nawait initHydra()\nosc(10).out()\n\n$: multiStack(s(\"bd\"), word(\"hi\"))";
  assert.equal(sequencesHydra(preamble), false);
  assert.equal(mosaicCellSource(preamble), 'reexecute');
});
