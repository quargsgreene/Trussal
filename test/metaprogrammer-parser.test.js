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
  assert.equal(ast.tempo.value, 120); // default injected
  assert.equal(ast.tempo.unit, 'bpm');
});

test('spec: default four-human program with explicit defaults', () => {
  const ast = ok(`$ participants <0 1 2 3>
# cycles wcl 2000 // Default if not specified
# tempo 120 bpm // Tempo takes two arguments, quantity and unit
`);
  assert.deepEqual(ast.cycles, { metric: 'wcl', factor: 2000, fixed: null });
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

test('spec: bad example — pattern argument to an effect is rejected', () => {
  bad(`$ participants [0 1 _@2 4@3 10!2 2a? 2 - 4zza]
# cycles wcj 3
# tempo 90/4 cpm
# room wcl (pink # range 0 1)
`, /pattern arguments/);
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

  ast = ok('$ participants [0 2 1 4 3]\n# echo 2.1 9\n# ply 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { nSamplesFactor: 2.1, magnitudeFeedbackFactor: 9 });
  assert.deepEqual(ast.chain[1], { fn: 'ply', args: [2], line: 3, col: 3 });

  ast = ok('$ participants [0 2 1 4 3]\n# crush 1.0003\n# chop 2\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), { reductionFactor: 1.0003 });

  ast = ok('$ participants [0 2 1 4 3]\n# noise\n');
  assert.deepEqual(resolveEffectParams(ast.chain[0]), {});

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

test('argument arity and positivity are validated', () => {
  bad('$ participants <0>\n# ply\n', /takes 1/);
  bad('$ participants <0>\n# room wcl 1 2 3\n', /takes 0–2/);
  bad('$ participants <0>\n# noise 3\n', /takes 0/);
  bad('$ participants <0>\n# crush 0\n', /positive real/);
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
  assert.equal(text, '$ participants <0>\n# cycles wcl 2000\n# tempo 120 bpm\n');
  const ast = ok(text);
  assert.deepEqual(ast.participants.stacks[0].elements.map(e => e.token), ['0']);
  // The implicit default (no # cycles line) mirrors the same directive.
  const implied = ok('$ participants <0>\n');
  assert.deepEqual(implied.cycles, { metric: 'wcl', factor: 2000, fixed: null, defaulted: true });
});

test('comments and blank lines anywhere are ignored', () => {
  ok('// leading comment\n\n$ participants <0 1> // trailing\n\n// between\n# cycles wcj\n');
});
