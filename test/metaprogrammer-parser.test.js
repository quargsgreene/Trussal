import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMetaprogram,
  resolveEffectParams,
  buildDefaultProgram
} from '../src/audio-net/MetaprogrammerParser.js';

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

// --- Spec examples, verbatim -----------------------------------------------

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
# cycles wcj
`, /cannot be chained/);
});

test('spec: good chainable example (rests, degrade, tempo fraction, effects)', () => {
  const ast = ok(`$ participants [0 1 _ 4? 10 2a - 2za ~]
# cycles wcj 3
# tempo 90/4 cpm
# room wcl 2.5
# noise
`);
  assert.equal(ast.participants.mode, 'subdivide');
  const els = ast.participants.stacks[0].elements;
  assert.equal(els.filter(e => e.type === 'rest').length, 3); // _ - ~
  const four = els.find(e => e.token === '4');
  assert.deepEqual(four.modifiers, [{ op: '?', value: null }]);
  assert.equal(ast.cycles.metric, 'wcj');
  assert.equal(ast.cycles.factor, 3);
  assert.equal(ast.tempo.value, 22.5); // 90/4
  assert.equal(ast.tempo.unit, 'cpm');
  assert.deepEqual(ast.chain.map(c => c.fn), ['room', 'noise']);
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2.5, fixedWclS: null });
});

test('spec: bad example — a Strudel call as an effect argument is rejected', () => {
  bad(`$ participants [0 1 _@2 4@3 10!2 2a? 2 - 4zza]
# cycles wcj 3
# tempo 90/4 cpm
# room wcl (pink # range 0 1)
`, /cannot take Strudel-call arguments/);
  // The sequence itself is legal (@/!/? apply "as usual"): removing the bad
  // room line makes the program valid.
  const ast = ok(`$ participants [0 1 _@2 4@3 10!2 2a? 2 - 4zza]
# cycles wcj 3
# tempo 90/4 cpm
`);
  const els = ast.participants.stacks[0].elements;
  assert.deepEqual(els.find(e => e.token === '4' && e.modifiers.length).modifiers, [{ op: '@', value: 3 }]);
  assert.deepEqual(els.find(e => e.token === '10').modifiers, [{ op: '!', value: 2 }]);
});

test('spec: effect examples — room wcl 2 0.4, echo + ply, crush + chop, noise, grid true', () => {
  let ast = ok('$ participants [0 2 1 4 3]\n# room wcl 2 0.4\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedWclS: 0.4 });

  ast = ok('$ participants [0 2 1 4 3]\n# echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200\n# ply 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    slots: [
      { param: 'length', metric: 'wcl', scale: 2, bound: 1500 },
      { param: 'feedback', metric: 'wcpl', scale: 0.3, bound: 20 },
      { param: 'gain', metric: 'wcl', scale: 3, bound: 1200 }
    ]
  });
  assert.deepEqual(ast.chain[1], { fn: 'ply', args: [2], line: 3, col: 3 });

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

// --- Index grammar in sequences ---------------------------------------------

test('bad bot indices inside sequences are parse errors with position', () => {
  const errors = bad('$ participants <0 0bcd 1>\n', /invalid participant index '0bcd'/);
  const err = errors.find(e => /0bcd/.test(e.message));
  assert.equal(err.line, 1);
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

test('structural errors: unclosed and mismatched brackets, missing participants', () => {
  bad('$ participants <0 1\n', /unclosed sequence/);
  bad('$ participants <0 1]\n', /mismatched/);
  bad('# cycles wcl\n', /missing '\$ participants'/);
  bad('', /missing '\$ participants'/);
  bad('$ participants <>\n', /empty sequence/);
});

// --- Directive validation -----------------------------------------------------

test('whitelisted pattern functions parse; anything else is rejected', () => {
  ok('$ participants <0>\n# shuffle 4\n# degrade\n# degradeBy 0.5\n# undegrade\n# undegradeBy 0.1\n# hush\n');
  bad('$ participants <0>\n# lpf 200\n', /not a NetCycles function/);
  bad('$ participants <0>\n# osc 10\n', /not a NetCycles function/);   // Hydra
  bad('$ participants <0>\n# range 0 1\n', /not a NetCycles function/);
});

test('room requires its wcl metric keyword; scale and fixed wcl are optional', () => {
  // Bare `# room wcl` → live wcl at scale 1.
  let ast = ok('$ participants <0>\n# room wcl\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 1, fixedWclS: null });
  // `# room wcl 2` → decay 2 × live wcl.
  ast = ok('$ participants <0>\n# room wcl 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedWclS: null });
  // The retired bare-number form and non-wcl metrics are parse errors.
  bad('$ participants <0>\n# room\n', /needs a metric keyword \(wcl\)/);
  bad('$ participants <0>\n# room 2\n', /needs a metric keyword \(wcl\)/);
  bad('$ participants <0>\n# room 2 0.4\n', /needs a metric keyword \(wcl\)/);
  bad('$ participants <0>\n# room wcj 2\n', /needs a metric keyword \(wcl\)/);
});

test('crush takes a metric keyword, a scale factor, and an optional pinned amount', () => {
  // Bare `# crush wcl` → live wcl at scale 1 (the 8-bit resting depth).
  let ast = ok('$ participants <0>\n# crush wcl\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 1, fixedMetric: null });
  ast = ok('$ participants <0>\n# crush wcl 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedMetric: null });
  ast = ok('$ participants <0>\n# crush wcl 2 0.4\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { metric: 'wcl', scale: 2, fixedMetric: 0.4 });
  // Unlike room, crush reads any worst-case metric — wcrtt included.
  for (const metric of ['wcl', 'wcj', 'wcpl', 'wcrtt']) {
    ast = ok(`$ participants <0>\n# crush ${metric} 2\n`);
    assert.equal(resolveEffectParams(ast.chain[0]).metric, metric);
  }
  // The retired bare-number form is a parse error, as it is for room.
  bad('$ participants <0>\n# crush 1\n', /needs a metric keyword \(wcl\|wcj\|wcpl\|wcrtt\)/);
  bad('$ participants <0>\n# crush wcx 1\n', /needs a metric keyword/);
  bad('$ participants <0>\n# crush wcl 1 2 3\n', /takes 0–2/);
});

test('crush arguments may be mini-notation patterns, including the metric', () => {
  let ast = ok('$ participants <0>\n# crush wcl <2 4>\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    metric: 'wcl',
    scale: { type: 'valueSeq', mode: 'alternate', terms: [2, 4], line: 2, col: 13 },
    fixedMetric: null
  });

  // Patterned metric, and both at once.
  ast = ok('$ participants <0>\n# crush <wcl wcj> 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).metric.terms, ['wcl', 'wcj']);
  ast = ok('$ participants <0>\n# crush <wcl wcj> <2 4>\n');
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

  // Malformed patterns are errors, with the leaf kind named.
  bad('$ participants <0>\n# crush wcl <2 4\n', /unclosed pattern argument/);
  bad('$ participants <0>\n# crush wcl <>\n', /empty pattern argument/);
  bad('$ participants <0>\n# crush wcl <2 x>\n', /expects positive numbers/);
  bad('$ participants <0>\n# crush wcl <0 4>\n', /positive real/);
  bad('$ participants <0>\n# crush <wcl 2> 4\n', /expects metric names/);
  bad('$ participants <0>\n# crush <wcl foo> 4\n', /not a metric 'crush' can read/);
  bad('$ participants <0>\n# crush wcl <2 4>*2\n', /do not take modifiers/);
  // Inside the sequence too — and the modifier's operand must not survive as
  // an extra element of the pattern.
  const errs = bad('$ participants <0>\n# crush wcl <2@3 4>\n', /do not take modifiers \('@'\)/);
  assert.equal(errs.filter(e => /expects positive numbers/.test(e.message)).length, 0);
  // Strudel expressions stay out of the editor, patterns or not.
  bad('$ participants <0>\n# crush wcl (pink # range 0 1)\n', /cannot be executed in the NetCycles editor/);
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
  ast = ok('$ participants <0>\n# echo wcj 2 wcpl 0.3 wcrtt 3\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]).slots.map(s => [s.metric, s.scale, s.bound]),
    [['wcj', 2, null], ['wcpl', 0.3, null], ['wcrtt', 3, null]]);

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
  bad('$ participants <0>\n# echo wcl 2 wcj\n', /needs a feedback scale factor/);
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
  // Effects that did not opt in still reject them.
  bad('$ participants <0>\n# room wcl <2 4>\n', /unexpected argument/);
});

test('noise: two metric/factor pairs, then two amounts pinning those metrics', () => {
  // The spec line: spectrum from wcl × 20, volume from wcrtt × 10.
  let ast = ok('$ participants <0>\n# noise wcl 20 wcrtt 10\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    spectrum: { metric: 'wcl', factor: 20, fixed: null },
    volume: { metric: 'wcrtt', factor: 10, fixed: null }
  });
  // 5th and 6th arguments pin the metrics in written order.
  ast = ok('$ participants <0>\n# noise wcl 20 wcrtt 10 0.4 0.06\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {
    spectrum: { metric: 'wcl', factor: 20, fixed: 0.4 },
    volume: { metric: 'wcrtt', factor: 10, fixed: 0.06 }
  });
  // Metric keywords are optional and default to wcl; a keyword alone implies
  // factor 1, the way `# room wcl` does.
  assert.deepEqual(resolveEffectParams(ok('$ participants <0>\n# noise 20 10\n').chain[0]), {
    spectrum: { metric: 'wcl', factor: 20, fixed: null },
    volume: { metric: 'wcl', factor: 10, fixed: null }
  });
  assert.deepEqual(resolveEffectParams(ok('$ participants <0>\n# noise wcj\n').chain[0]).spectrum,
    { metric: 'wcj', factor: 1, fixed: null });
  // A keyword binds to the factor that follows it, so it may sit second.
  assert.deepEqual(resolveEffectParams(ok('$ participants <0>\n# noise 20 wcpl 2\n').chain[0]).volume,
    { metric: 'wcpl', factor: 2, fixed: null });

  bad('$ participants <0>\n# noise wcl 1 2 3 4 5\n', /at most 4 numeric arguments/);
  bad('$ participants <0>\n# noise wcl wcj 2\n', /already has a metric for its spectrum/);
  bad('$ participants <0>\n# noise wcl 1 wcj 2 0.4 0.5 wcl\n', /metric keywords go before/);
  bad('$ participants <0>\n# noise rtt 2\n', /unexpected argument 'rtt'/);
  bad('$ participants <0>\n# noise wcl 0\n', /positive real numbers/);
  bad('$ participants <0>\n# noise wcl (pink)\n', /patterns as '<…>'/);
});

test('noise: any slot may be a <…> pattern, sampled one element per cycle', () => {
  const ast = ok('$ participants <0>\n# noise <wcl wcj> <20 10> wcrtt <5 <1 2>>\n');
  const at = (cycle) => resolveEffectParams(ast.chain[0], { cycle });
  assert.deepEqual(at(0).spectrum, { metric: 'wcl', factor: 20, fixed: null });
  assert.deepEqual(at(1).spectrum, { metric: 'wcj', factor: 10, fixed: null });
  assert.deepEqual(at(2).spectrum, { metric: 'wcl', factor: 20, fixed: null }, 'wraps');
  // Nested: the inner group advances once per visit of its parent.
  assert.deepEqual([0, 1, 2, 3].map((c) => at(c).volume.factor), [5, 1, 5, 2]);

  // Subdivision has no meaning for a per-cycle argument, and a pattern may
  // not mix the two kinds of leaf.
  bad('$ participants <0>\n# noise wcl [20 10]\n', /use '<…>' alternation/);
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
  bad('$ participants <0>\n$ participants <1>\n', /duplicate '\$ participants'/);
  bad('$ participants <0>\n# tempo 100 bpm\n# tempo 90 cps\n', /duplicate # tempo/);
});

test('cycles metric must be a timing metric; scale and amount must be positive', () => {
  bad('$ participants <0>\n# cycles wcrtt\n', /timing metric/);
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
  ast = ok('$ participants <0>\n# cycles wcj\n');
  assert.deepEqual(ast.cycles, { metric: 'wcj', factor: 1, fixed: null });
  // The retired `*` spelling points at the positional form.
  bad('$ participants <0>\n# cycles wcl*3\n', /positional now/);
  // At most two arguments; anything else on the line is junk.
  bad('$ participants <0>\n# cycles wcl 10 0.3 5\n', /unexpected argument '5'/);
  bad('$ participants <0>\n# cycles wcl 2a\n', /unexpected argument '2a'/);
});

test('errors carry 1-based line/col for editor squiggles', () => {
  const errors = bad('$ participants <0 1>\n# cycles wcl\n# cycles wcj\n');
  const dup = errors.find(e => /chained/.test(e.message));
  assert.equal(dup.line, 3);
  assert.equal(dup.col, 3);
});

// --- Defaults / helpers --------------------------------------------------------

test('buildDefaultProgram emits the always-on default and round-trips the parser', () => {
  // Participant 0 — the first to join — streams continuously; nobody else is
  // listed, so later joiners stay silent until an edit adds them.
  const text = buildDefaultProgram();
  assert.equal(text, '$ participants <0>\n# cycles wcl 20\n');
  const ast = ok(text);
  assert.deepEqual(ast.participants.stacks[0].elements.map(e => e.token), ['0']);
  // No tempo directive in the default program, and none injected behind it.
  assert.equal(ast.tempo, null);
  // The implicit default (no # cycles line) mirrors the same directive.
  const implied = ok('$ participants <0>\n');
  assert.deepEqual(implied.cycles, { metric: 'wcl', factor: 20, fixed: null, defaulted: true });
});

test('comments and blank lines anywhere are ignored', () => {
  ok('// leading comment\n\n$ participants <0 1> // trailing\n\n// between\n# cycles wcj\n');
});
