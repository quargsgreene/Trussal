import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMetaprogram,
  resolveEffectParams,
  buildDefaultProgram,
  mosaicEnabled
} from './helpers/metaprogram.js';
// The unwrapped parser, for the directive-requirement tests themselves.
import { parseMetaprogram as parseMetaprogramRaw } from '../src/audio-net/MetaprogrammerParser.js';

// --- The 'metaprogram editor' directive is required, with no fallback ------

test("a buffer with no 'metaprogram editor' directive is invalid", () => {
  const res = parseMetaprogramRaw('$ participants <0>\n# cycles wcl 20\n');
  assert.ok(res.errors.some(e => /directive/.test(e.message) && /'metaprogram editor'/.test(e.message)));
  assert.equal(res.valid, false);
  assert.equal(res.errors[0].line, 1);
});

test("the wrong directive is named, not guessed past", () => {
  const res = parseMetaprogramRaw("'personal editor'\n$ participants <0>\n");
  assert.ok(res.errors.some(e => /not a metaprogram/.test(e.message)));
});

test("a correct 'metaprogram editor' directive parses, single or double quoted", () => {
  assert.equal(parseMetaprogramRaw("'metaprogram editor'\n$ participants <0>\n").valid, true);
  assert.equal(parseMetaprogramRaw('"metaprogram editor"\n$ participants <0>\n').valid, true);
});

test("the legacy 'metaprogram' directive alias still parses", () => {
  assert.equal(parseMetaprogramRaw("'metaprogram'\n$ participants <0>\n").valid, true);
  assert.equal(parseMetaprogramRaw('"metaprogram"\n$ participants <0>\n').valid, true);
});

test("'$' no longer needs the 'participants' label — the directive carries the signal", () => {
  const bare = parseMetaprogramRaw("'metaprogram editor'\n$ <0 1 2>\n");
  assert.equal(bare.valid, true);
  assert.deepEqual(bare.ast.participants.stacks[0].elements.map(e => e.token), ['0', '1', '2']);
  // and the explicit label still works
  assert.equal(parseMetaprogramRaw("'metaprogram editor'\n$ participants <0 1 2>\n").valid, true);
});

function ok(text) {
  const res = parseMetaprogram(text);
  assert.deepEqual(res.errors, [], `expected no errors for:\n${text}`);
  return res.ast;
}

function bad(text, pattern) {
  const res = parseMetaprogram(text);
  assert.ok(res.errors.length > 0, `expected errors for:\n${text}`);
  if (pattern) {
    assert.ok(
      res.errors.some(e => pattern.test(e.message)),
      `expected an error matching ${pattern}, got:\n${res.errors.map(e => e.message).join('\n')}`
    );
  }
  return res.errors;
}

// --- mini surface notation (Strudel-style $: … .method(…)) ----------------

test('mini: the spec example parses to the same AST as its mondo equivalent', () => {
  const mini = ok('$: participants("<0 1>").cycles("wcl", 10).room("wcl", 30)');
  const mondo = ok('$ participants <0 1>\n# cycles "wcl" 10\n# room "wcl" 30\n');
  assert.deepEqual(mini.participants.stacks[0].elements.map(e => e.token),
    mondo.participants.stacks[0].elements.map(e => e.token));
  assert.deepEqual(mini.cycles, mondo.cycles);
  assert.deepEqual(mini.chain.map(c => c.fn), mondo.chain.map(c => c.fn));
  assert.deepEqual(resolveEffectParams(mini.chain[0]), resolveEffectParams(mondo.chain[0]));
});

test('mini: a method chain split across lines is the same as one line', () => {
  const a = ok('$: participants("<0 1>")\n.cycles("wcpl", 3)\n.crush("wcl", 2)');
  assert.equal(a.participants.mode, 'alternate');
  assert.deepEqual(a.cycles, { metric: 'wcpl', factor: 3, fixed: null });
  assert.deepEqual(a.chain.map(c => c.fn), ['crush']);
});

test('mini: [ … ] subdivides, exactly as the bare mondo form does', () => {
  assert.equal(ok('$: participants("[0 1 2]")').participants.mode, 'subdivide');
});

test("mixing mini and mondo in one buffer is a parse error", () => {
  bad('$: participants("<0>")\n# cycles "wcl" 10', /entirely in one notation/);
});

// --- metric keywords are accepted quoted (mini forces it) or bare --------

test('metric keywords parse quoted or bare, to the same AST', () => {
  assert.deepEqual(ok('$ participants <0>\n# cycles "wcl" 10\n').cycles,
    ok('$ participants <0>\n# cycles wcl 10\n').cycles);
  assert.deepEqual(ok('$ participants <0>\n# room "wcpl" 2\n').chain[0],
    ok('$ participants <0>\n# room wcpl 2\n').chain[0]);
});

test('a quoted metric pattern still reads as metrics, not media', () => {
  const a = ok('$ participants <0>\n# crush <"wcl" "wcpl"> <2 4>\n');
  assert.equal(a.chain[0].fn, 'crush');
  // the metric arg is a value sequence of metric keywords, not a media set
  assert.equal(a.chain[0].metric.type, 'valueSeq');
  assert.deepEqual(a.chain[0].metric.terms, ['wcl', 'wcpl']);
});

// --- Spec examples, verbatim -----------------------------------------------

// --- Mondo s-expression sequences (mini and mondo both accepted) ----------

test('mondo: (cat …) is the same sequence as <…>', () => {
  const a = ok('$ (cat 0 1a 2zzz)\n# cycles wcl 3\n');
  assert.equal(a.participants.mode, 'alternate');
  assert.deepEqual(a.participants.stacks[0].elements.map(e => e.token), ['0', '1a', '2zzz']);
});

test('mondo: a headless list and (seq …) subdivide, as [ … ] does', () => {
  assert.equal(ok('$ (0 1 2)\n').participants.mode, 'subdivide');
  assert.equal(ok('$ (seq 0 1 ~ 3)\n').participants.mode, 'subdivide');
  assert.equal(ok('$ (seq 0 1 ~ 3)\n').participants.stacks[0].elements[2].type, 'rest');
});

test('mondo: (fast N X) and (slow N X) are X*N / X/N', () => {
  assert.deepEqual(ok('$ (fast 2 (seq 0 1))\n').participants.modifiers, [{ op: '*', value: 2 }]);
  assert.deepEqual(ok('$ (slow 3 (cat 0 1))\n').participants.modifiers, [{ op: '/', value: 3 }]);
});

test('mondo: (stack …) offsets each element by a cycle, as the comma does', () => {
  const a = ok('$ (stack 0 1 2)\n');
  assert.deepEqual(a.participants.stacks.map(s => s.cycleOffset), [0, 1, 2]);
});

test('mondo: elements keep the glued postfix operators and nest with <…>/[…]', () => {
  const a = ok('$ (cat 0@2 1!3 <2 3>)\n');
  const els = a.participants.stacks[0].elements;
  assert.deepEqual(els[0].modifiers, [{ op: '@', value: 2 }]);
  assert.deepEqual(els[1].modifiers, [{ op: '!', value: 3 }]);
  assert.equal(els[2].type, 'sequence');
});

test('mondo: an unknown head or an empty group is a parse error', () => {
  bad('$ (spin 0 1)\n', /unknown Mondo head/);
  bad('$ (cat)\n', /empty Mondo sequence/);
  bad('$ (cat 0 1\n', /unclosed Mondo sequence/);
});

test('spec: scheduling example with mixed indices, repeat, and comment', () => {
  const ast = ok(`$ participants <0 1 3 5 2a 1zzzv 9 1>*2
# cycles wcl 3 // This is a comment.

`);
  assert.equal(ast.participants.mode, 'alternate');
  assert.equal(ast.participants.stacks.length, 1);
  const tokens = ast.participants.stacks[0].elements.map(e => e.token);
  assert.deepEqual(tokens, ['0', '1', '3', '5', '2a', '1zzzv', '9', '1']);
  assert.deepEqual(ast.participants.modifiers, [{ op: '*', value: 2 }]);
  assert.deepEqual(ast.cycles, { metric: 'wcl', factor: 3, fixed: null });
  // No `# tempo` written and none injected — the AST reports honestly that no
  // tempo directive is in force. beatSeconds(null) still quantizes onto
  // 120 bpm, so the cycle length is unchanged.
  assert.equal(ast.tempo, null);
});

test('spec: default four-human program with explicit defaults', () => {
  const ast = ok(`$ participants <0 1 2 3>
# cycles wcl 20 // Default if not specified
# tempo 120 bpm // Tempo takes two arguments, quantity and unit
`);
  assert.deepEqual(ast.cycles, { metric: 'wcl', factor: 20, fixed: null });
  assert.deepEqual(ast.tempo, { value: 120, unit: 'bpm' });
});

test('spec: program after bot clusters join', () => {
  const ast = ok(`$ participants < 0 1 2 3 1a 1b 1c 1d 2a 2b 2c 0a>
# cycles wcl
# tempo 120 bpm
`);
  const tokens = ast.participants.stacks[0].elements.map(e => e.token);
  assert.deepEqual(tokens, ['0', '1', '2', '3', '1a', '1b', '1c', '1d', '2a', '2b', '2c', '0a']);
});

test('spec: chained cyclic timing modes are invalid', () => {
  bad(`$ participants [0 2 ~ 3 1]
# cycles wcl
# cycles wcpl
`, /cannot be chained/);
});

test('spec: good chainable example (rests, degrade, tempo fraction, effects)', () => {
  const ast = ok(`$ participants [0 1 _ 4? 10 2a - 2za ~]
# cycles wcpl 3
# tempo 90/4 cpm
# room wcl 2.5
# noise
`);
  assert.equal(ast.participants.mode, 'subdivide');
  const els = ast.participants.stacks[0].elements;
  assert.equal(els.filter(e => e.type === 'rest').length, 3); // _ - ~
  const four = els.find(e => e.token === '4');
  assert.deepEqual(four.modifiers, [{ op: '?', value: null }]);
  assert.equal(ast.cycles.metric, 'wcpl');
  assert.equal(ast.cycles.factor, 3);
  assert.equal(ast.tempo.value, 22.5); // 90/4
  assert.equal(ast.tempo.unit, 'cpm');
  assert.deepEqual(ast.chain.map(c => c.fn), ['room', 'noise']);
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2.5, fixedMetric: null });
});

test('spec: bad example — a Strudel call as an effect argument is rejected', () => {
  bad(`$ participants [0 1 _@2 4@3 10!2 2a? 2 - 4zza]
# cycles wcpl 3
# tempo 90/4 cpm
# room wcl (pink # range 0 1)
`, /cannot be executed in the JPattern editor/);
  // The sequence itself is legal (@/!/? apply "as usual"): removing the bad
  // room line makes the program valid.
  const ast = ok(`$ participants [0 1 _@2 4@3 10!2 2a? 2 - 4zza]
# cycles wcpl 3
# tempo 90/4 cpm
`);
  const els = ast.participants.stacks[0].elements;
  assert.deepEqual(els.find(e => e.token === '4' && e.modifiers.length).modifiers, [{ op: '@', value: 3 }]);
  assert.deepEqual(els.find(e => e.token === '10').modifiers, [{ op: '!', value: 2 }]);
});

test('spec: effect examples — room wcl 2 0.4, echo + ply, crush + chop, noise, grid true', () => {
  let ast = ok('$ participants [0 2 1 4 3]\n# room wcl 2 0.4\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedMetric: 0.4 });

  ast = ok('$ participants [0 2 1 4 3]\n# echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200\n# ply 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    slots: [
      { param: 'length', metric: 'wcl', scale: 2, bound: 1500 },
      { param: 'feedback', metric: 'wcpl', scale: 0.3, bound: 20 },
      { param: 'gain', metric: 'wcl', scale: 3, bound: 1200 }
    ]
  });
  assert.deepEqual(ast.chain[1], { fn: 'ply', args: [2], line: 4, col: 3 });

  ast = ok('$ participants [0 2 1 4 3]\n# crush wcl 1.0003\n# chop 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 1.0003, fixedMetric: null });

  ast = ok('$ participants [0 2 1 4 3]\n# noise\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    spectrum: { metric: 'wcl', factor: 0, fixed: null },
    volume: { metric: 'wcl', factor: 0, fixed: null }
  });

  ast = ok('$ participants <0 9 1 4 2>*2\n# grid true\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { landmarks: true });
});

// --- # mosaic ----------------------------------------------------------------

test('mosaic: the aggregator tiles unless the program says otherwise', () => {
  assert.equal(mosaicEnabled(ok('$ participants <0>\n')), true);
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic\n')), true);
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic true\n')), true);
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic false\n')), false);
});

test('mosaic: the default program leaves the directive unwritten', () => {
  const text = buildDefaultProgram();
  assert.ok(!text.includes('mosaic'), 'default program should not inject a directive nobody typed');
  assert.equal(mosaicEnabled(ok(text)), true);
});

test('mosaic: a re-typed directive wins over the earlier one', () => {
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic false\n# mosaic true\n')), true);
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic true\n# mosaic false\n')), false);
});

test('mosaic: it is its own directive, leaving # grid alone', () => {
  const ast = ok('$ participants <0>\n# grid false\n# mosaic false\n');
  assert.deepEqual(ast.chain.map(c => c.fn), ['grid', 'mosaic']);
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { landmarks: false });
  assert.deepEqual(resolveEffectParams(ast.chain[1]), { enabled: false });
});

test('mosaic: takes a boolean, not a bare word or a pattern', () => {
  bad('$ participants <0>\n# mosaic maybe\n', /unexpected argument 'maybe'/);
  bad('$ participants <0>\n# mosaic <1 2>\n', /unexpected argument '<'/);
  bad('$ participants <0>\n# mosaic true false\n', /takes 0–1 argument/);
  // A number is tolerated and read as truthy — the shared boolArg path lets
  // positive reals through, exactly as `# grid 2` does. Not worth an
  // asymmetry between the language's two boolean directives.
  assert.equal(mosaicEnabled(ok('$ participants <0>\n# mosaic 2\n')), true);
});

test('mosaic: an unparseable program falls back to the default rather than dark', () => {
  assert.equal(mosaicEnabled(null), true);
  assert.equal(mosaicEnabled({}), true);
});

// --- Index grammar in sequences ---------------------------------------------

test('bad bot indices inside sequences are parse errors with position', () => {
  const errors = bad('$ participants <0 0bcd 1>\n', /invalid participant index '0bcd'/);
  const err = errors.find(e => /0bcd/.test(e.message));
  assert.equal(err.line, 2); // line 1 is the 'metaprogram' directive
  assert.equal(err.col, 19);
  bad('$ participants <9fae>\n', /invalid participant index/);
  // 'zz' as 28th-style suffix is fine as a *string* (52nd bot), '0zz' parses.
  ok('$ participants <0zz>\n');
});

// --- Operators and structure -------------------------------------------------

test('stack operator: elements after a comma get one-cycle offsets', () => {
  const ast = ok('$ participants <0 1, 2 3, 4>\n');
  assert.equal(ast.participants.stacks.length, 3);
  assert.deepEqual(ast.participants.stacks.map(s => s.cycleOffset), [0, 1, 2]);
  assert.deepEqual(ast.participants.stacks[1].elements.map(e => e.token), ['2', '3']);
});

test('jux and superimpose chain entries parse as stack producers', () => {
  const ast = ok('$ participants <0 1>\n# jux\n# superimpose <2 3>\n');
  assert.equal(ast.chain[0].fn, 'jux');
  assert.equal(ast.chain[1].fn, 'superimpose');
  assert.equal(ast.chain[1].args[0].type, 'sequence');
});

test('.. ranges expand between plain integer indices', () => {
  const ast = ok('$ participants <0 .. 3 5>\n');
  assert.deepEqual(ast.participants.stacks[0].elements.map(e => e.token), ['0', '1', '2', '3', '5']);
  bad('$ participants <0 .. 2a>\n', /ranges need plain integer/);
  bad('$ participants <3 .. 1>\n', /upper bound below lower/);
});

test('choice (|), nested groups, %, :, and / parse', () => {
  const ast = ok('$ participants <0 [1 2]*2 | 3>\n');
  const el = ast.participants.stacks[0].elements[0];
  assert.equal(el.type, 'choice');
  assert.equal(el.options.length, 2);
  assert.equal(el.options[0][1].type, 'sequence'); // nested [1 2]
  assert.deepEqual(el.options[0][1].modifiers, [{ op: '*', value: 2 }]);
  ok('$ participants <0%2 1:3 2/2>\n');
});

test('? takes an optional probability in [0,1]', () => {
  const ast = ok('$ participants <0?0.3 1>\n');
  assert.deepEqual(ast.participants.stacks[0].elements[0].modifiers, [{ op: '?', value: 0.3 }]);
  bad('$ participants <0?1.5>\n', /probability must be in \[0, 1\]/);
});

// The cycle highlighter outlines a slot from its token's (line, col) to this
// extent, so `4@3` / `10!2` / `2a?` sit inside one box rather than leaving the
// operator that shapes the turn outside it.
test('elements carry the source extent of their postfix operators', () => {
  const text = '$ participants [0 1 _@2 4@3 10!2 2a? 2 - 4zza]\n';
  const els = ok(text).participants.stacks[0].elements;
  const extent = (token) => {
    const el = els.find(e => e.token === token && e.modifiers.length);
    return text.slice(el.col - 1, el.endCol - 1);
  };
  assert.equal(extent('_'), '_@2');
  assert.equal(extent('4'), '4@3');
  assert.equal(extent('10'), '10!2');
  assert.equal(extent('2a'), '2a?');
  // Both ends are 1-based and on the same line: a modifier run never crosses one.
  // (line 1 is the 'metaprogram' directive; the sequence is on line 2.)
  assert.equal(els.find(e => e.token === '10').endLine, 2);
  // An unmodified token spans exactly itself.
  assert.equal(text.slice(els[0].col - 1, els[0].endCol - 1), '0');
  assert.equal(text.slice(els[8].col - 1, els[8].endCol - 1), '4zza');
});

test('an operator has to be glued to what it modifies', () => {
  // Whitespace separates one turn from the next, so a gap either side of an
  // operator is a syntax error rather than a loose spelling of the same turn.
  bad('$ participants <0 @3>\n', /'@' has to be attached to what it modifies/);
  bad('$ participants <0@ 3>\n', /'@' has to be attached to its number/);
  bad('$ participants <0 !2>\n', /'!' has to be attached to what it modifies/);
  bad('$ participants <0 ?0.5>\n', /'\?' has to be attached to what it modifies/);
  bad('$ participants <[0 1] *2>\n', /'\*' has to be attached to what it modifies/);
  bad('$ participants <0 1> *2\n', /'\*' has to be attached to what it modifies/);
  bad('$ participants <0 /2 1>\n', /'\/' has to be attached to what it modifies/);
  bad('$ participants <~ @2 1>\n', /'@' has to be attached to what it modifies/);
  // One error for one stray space — the swallowed operand must not come back
  // as a second complaint from the sequence loop.
  assert.equal(bad('$ participants <0 @3>\n').length, 1);

  // The glued spellings all still parse, and `..` — which joins two elements
  // rather than modifying one — is exempt, spaces and all.
  ok('$ participants <0@3 1!2 2a? 3?0.5 4*2 5/2 6%2 7:3>\n');
  ok('$ participants <[0 1]*2 <2 3>/2>*2\n');
  ok('$ participants <0 .. 3>\n');
  ok('$ participants <0..3>\n');
  // Unchanged: a detached count is the next element, not this one's operand.
  const els = ok('$ participants <0! 2>\n').participants.stacks[0].elements;
  assert.deepEqual(els.map(e => e.token), ['0', '2']);
  assert.deepEqual(els[0].modifiers, [{ op: '!', value: 2 }]);
});

test('the extent keeps a number\'s spelling, which its parsed value loses', () => {
  const text = '$ participants <0?0.50 1!02>\n';
  const els = ok(text).participants.stacks[0].elements;
  assert.deepEqual(els[0].modifiers, [{ op: '?', value: 0.5 }]);
  assert.equal(text.slice(els[0].col - 1, els[0].endCol - 1), '0?0.50');
  assert.equal(text.slice(els[1].col - 1, els[1].endCol - 1), '1!02');
});

test('structural errors: unclosed and mismatched brackets, missing participants', () => {
  bad('$ participants <0 1\n', /unclosed sequence/);
  bad('$ participants <0 1]\n', /mismatched/);
  bad('# cycles wcl\n', /missing '\$'/);
  bad('', /missing '\$'/);
  bad('$ participants <>\n', /empty sequence/);
});

// --- Directive validation -----------------------------------------------------

test('whitelisted pattern functions parse; anything else is rejected', () => {
  ok('$ participants <0>\n# shuffle 4\n# degrade\n# degradeBy 0.5\n# undegrade\n# undegradeBy 0.1\n# hush\n');
  bad('$ participants <0>\n# lpf 200\n', /not a JPattern function/);
  bad('$ participants <0>\n# osc 10\n', /not a JPattern function/);   // Hydra
  bad('$ participants <0>\n# range 0 1\n', /not a JPattern function/);
});

test('room requires a metric keyword; scale and pinned amount are optional', () => {
  // Bare `# room wcl` → live wcl at scale 1.
  let ast = ok('$ participants <0>\n# room wcl\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 1, fixedMetric: null });
  // `# room wcl 2` → decay 2 × live wcl.
  ast = ok('$ participants <0>\n# room wcl 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedMetric: null });
  // Any worst-case metric may drive the decay, as it may drive crush.
  for (const metric of ['wcl', 'wcpl']) {
    ast = ok(`$ participants <0>\n# room ${metric} 2\n`);
    assert.equal(resolveEffectParams(ast.chain[0]).metric, metric);
  }
  // The retired bare-number form is still a parse error.
  bad('$ participants <0>\n# room\n', /needs a metric keyword \(wcl\|wcpl\)/);
  bad('$ participants <0>\n# room 2\n', /needs a metric keyword/);
  bad('$ participants <0>\n# room 2 0.4\n', /needs a metric keyword/);
  bad('$ participants <0>\n# room wcx 2\n', /needs a metric keyword/);
});

test('crush takes a metric keyword, a scale factor, and an optional pinned amount', () => {
  // Bare `# crush wcl` → live wcl at scale 1 (the 8-bit resting depth).
  let ast = ok('$ participants <0>\n# crush wcl\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 1, fixedMetric: null });
  ast = ok('$ participants <0>\n# crush wcl 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedMetric: null });
  ast = ok('$ participants <0>\n# crush wcl 2 0.4\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedMetric: 0.4 });
  // crush reads any worst-case metric.
  for (const metric of ['wcl', 'wcpl']) {
    ast = ok(`$ participants <0>\n# crush ${metric} 2\n`);
    assert.equal(resolveEffectParams(ast.chain[0]).metric, metric);
  }
  // The retired bare-number form is a parse error, as it is for room.
  bad('$ participants <0>\n# crush 1\n', /needs a metric keyword \(wcl\|wcpl\)/);
  bad('$ participants <0>\n# crush wcx 1\n', /needs a metric keyword/);
  bad('$ participants <0>\n# crush wcl 1 2 3\n', /takes 0–2/);
});

test('crush arguments may be mini-notation patterns, including the metric', () => {
  let ast = ok('$ participants <0>\n# crush wcl <2 4>\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    metric: 'wcl',
    scale: { type: 'valueSeq', mode: 'alternate', terms: [2, 4], line: 3, col: 13 },
    fixedMetric: null
  });

  // Patterned metric, and both at once.
  ast = ok('$ participants <0>\n# crush <wcl wcpl> 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).metric.terms, ['wcl', 'wcpl']);
  ast = ok('$ participants <0>\n# crush <wcl wcpl> <2 4>\n');
  assert.equal(resolveEffectParams(ast.chain[0]).metric.mode, 'alternate');
  assert.equal(resolveEffectParams(ast.chain[0]).scale.mode, 'alternate');

  // [] subdivides; the two nest.
  ast = ok('$ participants <0>\n# crush wcl [2 <4 8>]\n');
  const scale = resolveEffectParams(ast.chain[0]).scale;
  assert.equal(scale.mode, 'subdivide');
  assert.deepEqual(scale.terms[1].terms, [4, 8]);

  // A pinned amount patterns too.
  ast = ok('$ participants <0>\n# crush wcl 2 <0.1 0.4>\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).fixedMetric.terms, [0.1, 0.4]);

  // Rests are leaves like any other — `~`, `_` and `-` all parse to null, and
  // one in a metric pattern does not make it a pattern of numbers.
  ast = ok('$ participants <0>\n# crush wcl <2 ~ 4 _ ->\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).scale.terms, [2, null, 4, null, null]);
  ast = ok('$ participants <0>\n# crush <wcl ~ wcpl> 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).metric.terms, ['wcl', null, 'wcpl']);

  // `*n` / `/n` set the rate the argument is read at, and compose.
  assert.equal(resolveEffectParams(ok('$ participants <0>\n# crush wcl <2 4>*2\n').chain[0]).scale.speed, 2);
  assert.equal(resolveEffectParams(ok('$ participants <0>\n# crush wcl <2 4>/2\n').chain[0]).scale.speed, 0.5);
  assert.equal(resolveEffectParams(ok('$ participants <0>\n# crush wcl <2 4>*4/2\n').chain[0]).scale.speed, 2);
  // A nested group carries its own.
  const nested = resolveEffectParams(ok('$ participants <0>\n# crush wcl <2 [4 8]*2>\n').chain[0]);
  assert.equal(nested.scale.terms[1].speed, 2);
  bad('$ participants <0>\n# crush wcl <2 4>*\n', /pattern rate '\*' needs a positive number/);
  bad('$ participants <0>\n# crush wcl <2 4>*0\n', /pattern rate '\*' needs a positive number/);

  // Malformed patterns are errors, with the leaf kind named.
  bad('$ participants <0>\n# crush wcl <2 4\n', /unclosed pattern argument/);
  bad('$ participants <0>\n# crush wcl <>\n', /empty pattern argument/);
  bad('$ participants <0>\n# crush wcl <2 x>\n', /expects positive numbers/);
  bad('$ participants <0>\n# crush wcl <0 4>\n', /positive real/);
  bad('$ participants <0>\n# crush <wcl 2> 4\n', /expects metric names/);
  bad('$ participants <0>\n# crush <wcl foo> 4\n', /not a metric 'crush' can read/);
  // A modifier that is neither a rate nor an element modifier, and its operand
  // must not survive as an extra element of the pattern.
  const errs = bad('$ participants <0>\n# crush wcl <2%3 4>\n', /'%' is not one of them/);
  assert.equal(errs.filter(e => /expects positive numbers/.test(e.message)).length, 0);
  // `@` and `?` weigh and drop an ELEMENT, so the whole argument is the wrong
  // place for them — and at the top level there is no parent to weigh against.
  bad('$ participants <0>\n# crush wcl <2 4>@3\n', /modifies one ELEMENT/);
  // Strudel expressions stay out of the editor, patterns or not.
  bad('$ participants <0>\n# crush wcl (pink # range 0 1)\n', /cannot be executed in the JPattern editor/);
  // Effects without patternArgs keep rejecting sequences outright.
  bad('$ participants <0>\n# grid <1 2>\n', /unexpected argument '<'/);
});

test('echo takes three metric/scale pairs, or none, plus up to three bounds', () => {
  // Bare form: wcl drives all three at the default scales.
  let ast = ok('$ participants <0>\n# echo\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).slots, [
    { param: 'length', metric: 'wcl', scale: 0.5, bound: null },
    { param: 'feedback', metric: 'wcl', scale: 0.5, bound: null },
    { param: 'gain', metric: 'wcl', scale: 1, bound: null }
  ]);

  // Six arguments, no bounds: each metric keeps its own default bound.
  ast = ok('$ participants <0>\n# echo wcpl 2 wcpl 0.3 wcl 3\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).slots.map(s => [s.metric, s.scale, s.bound]),
    [['wcpl', 2, null], ['wcpl', 0.3, null], ['wcl', 3, null]]);

  // Bounds fill their slots left to right, so a partial list is legal.
  ast = ok('$ participants <0>\n# echo wcl 2 wcpl 0.3 wcl 3 1500\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).slots.map(s => s.bound), [1500, null, null]);
  ast = ok('$ participants <0>\n# echo wcl 2 wcpl 0.3 wcl 3 1500 20\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).slots.map(s => s.bound), [1500, 20, null]);

  // All the pairs or none — a half-written chain is a mistake, not a default.
  bad('$ participants <0>\n# echo wcl 2\n', /needs a metric keyword .* before its feedback/);
  bad('$ participants <0>\n# echo wcl 2 wcpl 0.3\n', /needs a metric keyword .* before its gain/);
  bad('$ participants <0>\n# echo 2 0.3 3\n', /needs a metric keyword .* before its length/);
  bad('$ participants <0>\n# echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200 900\n', /unexpected argument '900'/);
  bad('$ participants <0>\n# echo wcl 0 wcpl 0.3 wcl 3\n', /length scale factor must be a positive real/);
  bad('$ participants <0>\n# echo wcl 2 wcpl\n', /needs a feedback scale factor/);
  bad('$ participants <0>\n# echo wcl 2 wcpl 0.3 wcl 3 (pink)\n', /cannot take Strudel-call arguments/);

  // A rejected Strudel call is skipped whole. Its innards are not this
  // language's tokens — `#` inside it is a statement sigil — so leaving it for
  // recover() would turn one honest error into two and lose the next line.
  const res = parseMetaprogram('$ participants <0>\n# echo wcl 2 wcpl 0.3 wcl 3 (pink # range 0 1)\n# crush wcl 1\n');
  assert.equal(res.errors.length, 1, `one error, not a cascade: ${res.errors.map(e => e.message).join(' | ')}`);
  assert.deepEqual(res.ast.chain.map(c => c.fn), ['crush'], 'parsing resumes at the next directive');

  // An echo length is naturally said in rational cycles, so it may be written
  // as a fraction — the same spelling `# tempo 90/4` already uses.
  ast = ok('$ participants <0>\n# echo wcl 1/2 wcpl 0.3 wcl 3 1500/2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).slots.map(s => [s.scale, s.bound]),
    [[0.5, 750], [0.3, null], [3, null]]);
  bad('$ participants <0>\n# echo wcl 1/0 wcpl 0.3 wcl 3\n', /fraction denominator must be a positive real/);
});

// Pattern nodes carry their source position for editor squiggles; these tests
// are about the values, so compare the shape without it.
function shapeOf(node) {
  return {
    mode: node.mode,
    terms: node.terms.map(t => (t && t.type === 'valueSeq') ? shapeOf(t) : t)
  };
}

test('echo scales and bounds may be patterns; malformed ones are parse errors', () => {
  let ast = ok('$ participants <0>\n# echo wcl <2 3 0.5> wcpl 0.3 wcl [1 4] 1500 20 <1200 600>\n');
  let slots = resolveEffectParams(ast.chain[0]).slots;
  assert.deepEqual(shapeOf(slots[0].scale), { mode: 'alternate', terms: [2, 3, 0.5] });
  assert.deepEqual(shapeOf(slots[2].scale), { mode: 'subdivide', terms: [1, 4] });
  assert.deepEqual(shapeOf(slots[2].bound), { mode: 'alternate', terms: [1200, 600] });

  // Nesting works the way it does in a participants sequence.
  ast = ok('$ participants <0>\n# echo wcl <2 [3 4]> wcl 0.5 wcl 1\n');
  slots = resolveEffectParams(ast.chain[0]).slots;
  assert.deepEqual(shapeOf(slots[0].scale.terms[1]), { mode: 'subdivide', terms: [3, 4] });

  // A directive is one line: an unclosed pattern stops at the line break
  // instead of swallowing the statements below it.
  bad('$ participants <0>\n# echo wcl <2 3\n# crush wcl 1\n', /unclosed pattern argument/);
  bad('$ participants <0>\n# echo wcl <> wcl 0.5 wcl 1\n', /empty pattern argument/);
  bad('$ participants <0>\n# echo wcl <2 3] wcl 0.5 wcl 1\n', /mismatched '\]'/);
  bad('$ participants <0>\n# echo wcl <2 x> wcl 0.5 wcl 1\n', /expects positive numbers/);
  bad('$ participants <0>\n# echo wcl <2 0> wcl 0.5 wcl 1\n', /must be a positive real/);
});

test('pattern elements take @ weights and ? chances, as participant turns do', () => {
  const scaleOf = (line) => resolveEffectParams(ok(`$ participants <0>\n${line}\n`).chain[0]).scale;

  // `@n` records a weight parallel to the terms; unweighted elements fill in
  // at 1 so the array always lines up with them.
  let scale = scaleOf('# crush wcl <1@2 2 3@0.5>');
  assert.deepEqual(scale.terms, [1, 2, 3]);
  assert.deepEqual(scale.weights, [2, 1, 0.5]);
  // `?` records a chance the same way, bare meaning one in two.
  scale = scaleOf('# crush wcl <1? 2?0.25 3>');
  assert.deepEqual(scale.chances, [0.5, 0.25, null]);
  // Both on one element, in either order, and on a nested group or a rest.
  assert.deepEqual(scaleOf('# crush wcl <1@2? 2>').weights, [2, 1]);
  assert.deepEqual(scaleOf('# crush wcl <1?@2 2>').weights, [2, 1]);
  assert.deepEqual(scaleOf('# crush wcl <[1 2]*2@3 4>').weights, [3, 1]);
  assert.deepEqual(scaleOf('# crush wcl <~@2 4>').weights, [2, 1]);
  // An untouched pattern grows neither field.
  scale = scaleOf('# crush wcl <1 2>');
  assert.equal(scale.weights, undefined);
  assert.equal(scale.chances, undefined);

  // The count must be glued to its operator. For `?` a gap means the bare
  // form followed by the next element; `@` has no bare form, so a gap is an
  // error rather than a weight that quietly swallows that element.
  assert.deepEqual(scaleOf('# crush wcl <1? 2>').terms, [1, 2]);
  bad('$ participants <0>\n# crush wcl <1@ 2>\n', /'@' needs a positive weight written against it/);
  bad('$ participants <0>\n# crush wcl <1@0 2>\n', /'@' needs a positive weight/);
  bad('$ participants <0>\n# crush wcl <1?2 2>\n', /'\?' probability must be in \[0, 1\]/);
  bad('$ participants <0>\n# crush wcl <1@2@3 2>\n', /already has an '@' weight/);
  bad('$ participants <0>\n# crush wcl <1?0.2?0.3 2>\n', /already has a '\?' chance/);
});

test('!n replicates a pattern element into that many independent ones', () => {
  const scaleOf = (line) => resolveEffectParams(ok(`$ participants <0>\n${line}\n`).chain[0]).scale;

  // Expanded at parse time, so downstream sees a plain list of terms.
  assert.deepEqual(scaleOf('# crush wcl <1!3 2>').terms, [1, 1, 1, 2]);
  assert.deepEqual(scaleOf('# crush wcl <1! 2>').terms, [1, 1, 2], 'bare ! is once more');
  assert.equal(scaleOf('# crush wcl <[1 2]!2 4>').terms.length, 3, 'a group replicates too');

  // A replica keeps the element's weight and chance — and, being a separate
  // element, draws its own `?` where `@` would decide once for one wide span.
  const replicated = scaleOf('# crush wcl <1?0.5!3 2>');
  assert.deepEqual(replicated.terms, [1, 1, 1, 2]);
  assert.deepEqual(replicated.chances, [0.5, 0.5, 0.5, null]);
  assert.deepEqual(scaleOf('# crush wcl <1@2!2 3>').weights, [2, 2, 1]);

  // The count is glued, capped, and written once.
  assert.deepEqual(scaleOf('# crush wcl <1! 2>').terms, [1, 1, 2]);
  bad('$ participants <0>\n# crush wcl <1!0 2>\n', /'!' needs a repeat count of 1 or more/);
  bad('$ participants <0>\n# crush wcl <1!99999 2>\n', /repeats at most 1024 times/);
  bad('$ participants <0>\n# crush wcl <1!2!3 2>\n', /already has a '!' repeat count/);
  bad('$ participants <0>\n# crush wcl <1 2>!3\n', /'!' modifies one ELEMENT/);
});

test('an element carries its own *n rate; on a number / stays a fraction', () => {
  const scaleOf = (line) => resolveEffectParams(ok(`$ participants <0>\n${line}\n`).chain[0]).scale;

  // `<[1 2]*2 3>` reads the group twice inside its own span — the value
  // analogue of `1*2` giving two half-length turns back to back.
  assert.deepEqual(scaleOf('# crush wcl <1*2 3>').rates, [2, 1]);
  assert.deepEqual(scaleOf('# crush wcl <1*4/2 3>').rates, [2, 1], 'rates compose');
  // Written on a nested group the group takes it itself, so the parent records
  // nothing — the two spellings mean the same thing and must not double up.
  const grouped = scaleOf('# crush wcl <[1 2]*2 3>');
  assert.equal(grouped.rates, undefined);
  assert.equal(grouped.terms[0].speed, 2);

  // `/` after a NUMBER is the fraction spelling `# echo wcl 1/2` already uses,
  // and that reading wins: `<3/4 1>` is the value 0.75, not element 3 at a
  // quarter rate. Nothing is lost — an element rate on a constant is inert
  // either way — but the two readings share a spelling, so pin it.
  assert.deepEqual(scaleOf('# crush wcl <3/4 1>').terms, [0.75, 1]);
  assert.equal(scaleOf('# crush wcl <3/4 1>').rates, undefined);

  bad('$ participants <0>\n# crush wcl <~* 2>\n', /'\*' needs a positive rate written against it/);
  bad('$ participants <0>\n# crush wcl <~*0 2>\n', /'\*' needs a positive rate/);
});

test('room arguments may be patterns too, rests and a rate included', () => {
  // The spec line: metric and scale both turn over, twice per cycle.
  const ast = ok('$ participants <0>\n# room <wcl wcpl> <1 2 ~ 2 3>*2\n');
  const { metric, scale, fixedMetric } = resolveEffectParams(ast.chain[0]);
  assert.deepEqual(shapeOf(metric), { mode: 'alternate', terms: ['wcl', 'wcpl'] });
  assert.deepEqual(shapeOf(scale), { mode: 'alternate', terms: [1, 2, null, 2, 3] });
  assert.equal(scale.speed, 2);
  assert.equal(fixedMetric, null);
  assert.equal(metric.speed, undefined, 'an unrated pattern carries no speed field');

  // The pinned amount patterns as well, and `[…]` subdivides — room is
  // re-read on the browser's 50 ms tick and the aggregator's, not only at
  // cycle boundaries.
  const pinned = resolveEffectParams(ok('$ participants <0>\n# room wcl 2 [0.1 0.4]\n').chain[0]);
  assert.deepEqual(shapeOf(pinned.fixedMetric), { mode: 'subdivide', terms: [0.1, 0.4] });
});

test('noise: two metric/factor pairs, then two amounts pinning those metrics', () => {
  // The spec line: spectrum from wcl × 20, volume from wcpl × 10.
  let ast = ok('$ participants <0>\n# noise wcl 20 wcpl 10\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    spectrum: { metric: 'wcl', factor: 20, fixed: null },
    volume: { metric: 'wcpl', factor: 10, fixed: null }
  });
  // 5th and 6th arguments pin the metrics in written order.
  ast = ok('$ participants <0>\n# noise wcl 20 wcpl 10 0.4 0.06\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    spectrum: { metric: 'wcl', factor: 20, fixed: 0.4 },
    volume: { metric: 'wcpl', factor: 10, fixed: 0.06 }
  });
  // Metric keywords are optional and default to wcl; a keyword alone implies
  // factor 1, the way `# room wcl` does.
  assert.deepEqual(resolveEffectParams(ok('$ participants <0>\n# noise 20 10\n').chain[0]), {
    spectrum: { metric: 'wcl', factor: 20, fixed: null },
    volume: { metric: 'wcl', factor: 10, fixed: null }
  });
  assert.deepEqual(resolveEffectParams(ok('$ participants <0>\n# noise wcpl\n').chain[0]).spectrum,
    { metric: 'wcpl', factor: 1, fixed: null });
  // A keyword binds to the factor that follows it, so it may sit second.
  assert.deepEqual(resolveEffectParams(ok('$ participants <0>\n# noise 20 wcpl 2\n').chain[0]).volume,
    { metric: 'wcpl', factor: 2, fixed: null });

  bad('$ participants <0>\n# noise wcl 1 2 3 4 5\n', /at most 4 numeric arguments/);
  bad('$ participants <0>\n# noise wcl wcpl 2\n', /already has a metric for its spectrum/);
  bad('$ participants <0>\n# noise wcl 1 wcpl 2 0.4 0.5 wcl\n', /metric keywords go before/);
  bad('$ participants <0>\n# noise rtt 2\n', /unexpected argument 'rtt'/);
  bad('$ participants <0>\n# noise wcl 0\n', /positive real numbers/);
  bad('$ participants <0>\n# noise wcl (pink)\n', /patterns as '<…>'/);
});

test('noise: any slot may be a <…> pattern, sampled one element per cycle', () => {
  const ast = ok('$ participants <0>\n# noise <wcl wcpl> <20 10> wcl <5 <1 2>>\n');
  const at = (cycle) => resolveEffectParams(ast.chain[0], { cycle });
  assert.deepEqual(at(0).spectrum, { metric: 'wcl', factor: 20, fixed: null });
  assert.deepEqual(at(1).spectrum, { metric: 'wcpl', factor: 10, fixed: null });
  assert.deepEqual(at(2).spectrum, { metric: 'wcl', factor: 20, fixed: null }, 'wraps');
  // Nested: the inner group advances once per visit of its parent.
  assert.deepEqual([0, 1, 2, 3].map((c) => at(c).volume.factor), [5, 1, 5, 2]);

  // Rests read as "no value here", so the slot falls back to the default it
  // would have had unwritten — for the spectrum factor that is 1, since a
  // metric pattern IS written (the same rule that makes `# noise wcpl` scale 1).
  const rested = ok('$ participants <0>\n# noise <wcl ~> <20 ~>\n');
  assert.deepEqual(resolveEffectParams(rested.chain[0], { cycle: 0 }).spectrum,
    { metric: 'wcl', factor: 20, fixed: null });
  assert.deepEqual(resolveEffectParams(rested.chain[0], { cycle: 1 }).spectrum,
    { metric: 'wcl', factor: 1, fixed: null });

  // Subdivision has no meaning for a per-cycle argument, nor does a rate that
  // steps within one; and a pattern may not mix the two kinds of leaf.
  bad('$ participants <0>\n# noise wcl [20 10]\n', /use '<…>' alternation/);
  bad('$ participants <0>\n# noise wcl <20 10>*2\n', /a rate above 1/);
  ok('$ participants <0>\n# noise wcl <20 10>/2\n'); // slower than a cycle is fine
  bad('$ participants <0>\n# noise <wcl 20>\n', /cannot mix metric keywords with numbers/);
  bad('$ participants <0>\n# noise wcl <20\n', /unclosed pattern argument/);
  // A missing '>' must stop at the next statement, not eat the rest of the
  // program: swallowing it produced a pile of unrelated squiggles and a bogus
  // "missing '$ participants'" for a program that plainly has one.
  const errors = bad('# noise wcl <20\n$ participants [0]\n# crush wcl 1\n', /unclosed pattern argument/);
  assert.equal(errors.length, 1, `one error, got: ${errors.map(e => e.message).join(' | ')}`);
  bad('$ participants <0>\n# noise wcl <>\n', /empty pattern argument/);
});

test('argument arity and positivity are validated', () => {
  bad('$ participants <0>\n# ply\n', /takes 1/);
  bad('$ participants <0>\n# room wcl 1 2 3\n', /takes 0–2/);
  // noise's own arity lives with its grammar (see the noise tests above):
  // `# noise 3` is now a spectrum factor, not an arity error.
  ok('$ participants <0>\n# noise 3\n');
  bad('$ participants <0>\n# crush wcl 0\n', /positive real/);
  bad('$ participants <0>\n# degradeBy 1.5\n', /probability must be in \[0, 1\]/);
  bad('$ participants <0>\n# grid maybe\n', /unexpected argument 'maybe'/);
  ok('$ participants <0>\n# grid false\n');
});

test('duplicate statements are rejected', () => {
  bad('$ participants <0>\n$ participants <1>\n', /duplicate '\$'/);
  bad('$ participants <0>\n# tempo 100 bpm\n# tempo 90 cps\n', /duplicate # tempo/);
});

test('cycles metric must be a timing metric; scale and amount must be positive', () => {
  bad('$ participants <0>\n# cycles rtt\n', /timing metric/);
  bad('$ participants <0>\n# cycles wcl 0\n', /scale factor must be a positive real/);
  bad('$ participants <0>\n# cycles wcl 10 0\n', /fixed amount must be a positive real/);
  ok('$ participants <0>\n# cycles wcpl\n');
});

test('cycles args are positional: scale alone stays dynamic, amount pins the metric', () => {
  // Dynamic: cycle target = live WCL × 1000.
  let ast = ok('$ participants <0>\n# cycles wcl 1000\n');
  assert.deepEqual(ast.cycles, { metric: 'wcl', factor: 1000, fixed: null });
  // Pinned: WCL fixed at 0.3 s × 10 = 3 s, regardless of network conditions.
  ast = ok('$ participants <0>\n# cycles wcl 10 0.3\n');
  assert.deepEqual(ast.cycles, { metric: 'wcl', factor: 10, fixed: 0.3 });
  // Bare metric: scale defaults to 1.
  ast = ok('$ participants <0>\n# cycles wcpl\n');
  assert.deepEqual(ast.cycles, { metric: 'wcpl', factor: 1, fixed: null });
  // The retired `*` spelling points at the positional form.
  bad('$ participants <0>\n# cycles wcl*3\n', /positional now/);
  // At most two arguments; anything else on the line is junk.
  bad('$ participants <0>\n# cycles wcl 10 0.3 5\n', /unexpected argument '5'/);
  bad('$ participants <0>\n# cycles wcl 2a\n', /unexpected argument '2a'/);
});

test('errors carry 1-based line/col for editor squiggles', () => {
  const errors = bad('$ participants <0 1>\n# cycles wcl\n# cycles wcpl\n');
  const dup = errors.find(e => /chained/.test(e.message));
  assert.equal(dup.line, 4); // line 1 is the 'metaprogram' directive
  assert.equal(dup.col, 3);
});

// --- Defaults / helpers --------------------------------------------------------

test('buildDefaultProgram emits the always-on default and round-trips the parser', () => {
  // Participant 0 — the first to join — streams continuously; nobody else is
  // listed, so later joiners stay silent until an edit adds them.
  const text = buildDefaultProgram();
  assert.equal(text, "'metaprogram editor'\n$ participants <0>\n# cycles \"wcl\" 20\n");
  const ast = ok(text);
  assert.deepEqual(ast.participants.stacks[0].elements.map(e => e.token), ['0']);
  // No tempo directive in the default program, and none injected behind it.
  assert.equal(ast.tempo, null);
  // The implicit default (no # cycles line) mirrors the same directive.
  const implied = ok('$ participants <0>\n');
  assert.deepEqual(implied.cycles, { metric: 'wcl', factor: 20, fixed: null, defaulted: true });
});

test('`*`-prefixed statements are inert button declarations, not program', () => {
  // A declared voice does not join the ring, and a declared effect does not
  // join the chain — the button is what puts them there.
  const ast = ok(`$ participants <0>
*$ participants <2a 2b>
# cycles wcl 20
*# crush wcl 2 // a declaration may carry a comment
`);
  assert.deepEqual(ast.participants.stacks[0].elements.map(e => e.token), ['0']);
  assert.deepEqual(ast.chain, []);
  // Whitespace around the '*' and the sigil is allowed, as it is on statements.
  ok('$ participants <0>\n  *  $ participants <1>\n');
  // Declarations do not stand in for the required scheduling sequence.
  bad('*$ participants <0>\n', /missing '\$'/);
  // A declaration never swallows the statements below it.
  bad('$ participants <0>\n*# crush wcl 2\n# lpf 200\n', /not a JPattern function/);
  // A bare '*' is still junk: it declares nothing.
  bad('$ participants <0>\n* crush wcl 2\n', /expected '\$' or '#'/);
  // A declaration ending the text, with no newline after it.
  ok('$ participants <0>\n*# crush wcl 2');
  ok('$ participants <0>\n*$');
});

test('a declaration stays inert after an error on any line above it', () => {
  // Error recovery scans forward to the next sigil, and a declaration's own
  // sigil must not stop it — otherwise one typo while live coding runs a voice
  // nobody pressed, and blames the user's real statement for being a duplicate.
  let res = parseMetaprogram('# lpf 200\n*$ participants <9>\n$ participants <0>\n');
  assert.deepEqual(res.ast.participants.stacks[0].elements.map(e => e.token), ['0']);
  assert.equal(res.errors.filter(e => /duplicate/.test(e.message)).length, 0);

  res = parseMetaprogram('$ participants <0>\n# lpf 200\n*# crush wcl 2\n');
  assert.deepEqual(res.ast.chain, []);

  // A trailing `*` modifier is still a modifier: the newline between it and
  // the next statement's sigil is what tells the two cases apart.
  const ast = ok('$ participants <0 1>*2\n# cycles wcl 20\n');
  assert.deepEqual(ast.participants.modifiers, [{ op: '*', value: 2 }]);
  assert.equal(ast.cycles.factor, 20);
});

test('comments and blank lines anywhere are ignored', () => {
  ok('// leading comment\n\n$ participants <0 1> // trailing\n\n// between\n# cycles wcpl\n');
});

// --- Data-pack references --------------------------------------------------

const PARTS = '$ participants <0>\n';

test('a data reference is accepted wherever a pattern argument is', () => {
  const ast = ok(`${PARTS}# crush wcl Weather:3`);
  assert.match(JSON.stringify(ast), /"type":"dataRef","name":"Weather","index":3/);
});

test('a data reference works as a term inside a pattern', () => {
  const ast = ok(`${PARTS}# crush wcl <Weather:1 4>`);
  assert.match(JSON.stringify(ast), /"type":"dataRef","name":"Weather","index":1/);
});

test('a data reference does not loosen what a pattern may hold', () => {
  bad(`${PARTS}# crush wcl <wcl Weather:1>`, /pattern expects positive numbers/);
});

test('# cycles reads fixed numbers, so it names the limit rather than reporting an object', () => {
  const errors = bad(`${PARTS}# cycles wcl Weather:3`, /cannot read 'Weather:3'/);
  assert.ok(!errors.some(e => /\[object Object\]/.test(e.message)),
    'the token is reported as it was written');
});

test('the colon binds an identifier to digits and nothing else', () => {
  ok(`${PARTS}# cycles wcl 20`, 'a plain numeric argument is untouched');
  bad(`${PARTS}# crush wcl :3`);
});
