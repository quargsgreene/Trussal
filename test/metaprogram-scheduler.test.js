import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beatSeconds,
  timingTargetSeconds,
  cycleLength,
  expandCycle,
  AVBufferQueue,
  MetaprogramScheduler,
  WCPL_FULL_SCALE_S
} from '../src/audio-net/MetaprogramScheduler.js';
import {
  parseMetaprogram,
  appendParticipantToProgram,
  removeParticipantFromProgram
} from '../src/audio-net/MetaprogrammerParser.js';

function astOf(text) {
  const { ast, errors } = parseMetaprogram(text);
  assert.deepEqual(errors, []);
  return ast;
}

// --- Cycle-length math ---------------------------------------------------------

test('plan example: 120 bpm, wcl 900 ms, factor 3 → smallest beats ≥ 2.7 s = 6 beats', () => {
  const { beats, seconds } = cycleLength({
    cycles: { metric: 'wcl', factor: 3 },
    tempo: { value: 120, unit: 'bpm' },
    metrics: { wcl: 900 }
  });
  assert.equal(beats, 6);
  assert.equal(seconds, 3);
});

test('exact multiples stay exact (≥); zero metric floors at one beat', () => {
  // wcl 1000 ms at 120 bpm: 2 beats == 1.0 s covers it exactly → 2 beats.
  assert.equal(cycleLength({
    cycles: { metric: 'wcl', factor: 1 },
    tempo: { value: 120, unit: 'bpm' },
    metrics: { wcl: 1000 }
  }).beats, 2);
  assert.equal(cycleLength({
    cycles: { metric: 'wcl', factor: 1 },
    tempo: { value: 120, unit: 'bpm' },
    metrics: { wcl: 0 }
  }).beats, 1);
});

test('a fixed amount pins the timing metric; live metrics are ignored', () => {
  // `# cycles wcl 10 0.3` — 0.3 s × 10 = 3 s even on a 5-second-WCL network.
  assert.equal(timingTargetSeconds(
    { metric: 'wcl', factor: 10, fixed: 0.3 }, { wcl: 5000 }
  ), 3);
  const { beats, seconds } = cycleLength({
    cycles: { metric: 'wcl', factor: 10, fixed: 0.3 },
    tempo: { value: 120, unit: 'bpm' },
    metrics: { wcl: 5000 }
  });
  assert.equal(beats, 6); // lands exactly on the beat grid, no extra beat
  assert.equal(seconds, 3);
  // wcpl pins a loss fraction onto the same 10 s full scale.
  assert.equal(timingTargetSeconds(
    { metric: 'wcpl', factor: 2, fixed: 0.1 }, { wcpl: 0.9 }
  ), 0.1 * WCPL_FULL_SCALE_S * 2);
});

test('tempo units: bpm and cpm are per minute, cps per second', () => {
  assert.equal(beatSeconds({ value: 120, unit: 'bpm' }), 0.5);
  assert.equal(beatSeconds({ value: 120, unit: 'cpm' }), 0.5);
  assert.equal(beatSeconds({ value: 2, unit: 'cps' }), 0.5);
});

test('wcj uses ms; wcpl maps loss fraction onto the 10 s full scale', () => {
  assert.equal(timingTargetSeconds({ metric: 'wcj', factor: 2 }, { wcj: 250 }), 0.5);
  assert.equal(timingTargetSeconds({ metric: 'wcpl', factor: 1 }, { wcpl: 0.5 }), 0.5 * WCPL_FULL_SCALE_S);
});

// --- Cycle expansion --------------------------------------------------------------

test('alternate <0 1> plays one participant per cycle, round-robin', () => {
  const ast = astOf('$ participants <0 1>\n');
  assert.deepEqual(expandCycle(ast.participants, 0).map(e => e.token), ['0']);
  assert.deepEqual(expandCycle(ast.participants, 1).map(e => e.token), ['1']);
  assert.deepEqual(expandCycle(ast.participants, 2).map(e => e.token), ['0']);
});

test('alternation order: rejoin-suffixed tokens rotate exactly as written', () => {
  const cases = [
    ['<0 0a 0b>', ['0', '0a', '0b']],
    ['<0b 0 0a>', ['0b', '0', '0a']],
    ['<0a 0b 0>', ['0a', '0b', '0']]
  ];
  for (const [seq, order] of cases) {
    const ast = astOf(`$ participants ${seq}\n`);
    for (let cycle = 0; cycle < order.length * 2; cycle++) {
      assert.deepEqual(
        expandCycle(ast.participants, cycle).map(e => e.token),
        [order[cycle % order.length]],
        `${seq} cycle ${cycle}`
      );
    }
  }
});

test('repeated tokens keep their own slots and play once per occurrence', () => {
  const cases = [
    ['<0 0 0a>', ['0', '0', '0a']],
    ['<0 0b 0a 0b 0b 0a>', ['0', '0b', '0a', '0b', '0b', '0a']],
    ['<0 0a 0 0b 0a 0b 0>', ['0', '0a', '0', '0b', '0a', '0b', '0']]
  ];
  for (const [seq, order] of cases) {
    const ast = astOf(`$ participants ${seq}\n`);
    for (let cycle = 0; cycle < order.length * 2; cycle++) {
      assert.deepEqual(
        expandCycle(ast.participants, cycle).map(e => e.token),
        [order[cycle % order.length]],
        `${seq} cycle ${cycle}`
      );
    }
  }
});

test('<0 1>*2 plays two half-cycle slots per cycle', () => {
  const ast = astOf('$ participants <0 1>*2\n');
  const evs = expandCycle(ast.participants, 0);
  assert.deepEqual(evs.map(e => [e.token, e.start, e.dur]), [['0', 0, 0.5], ['1', 0.5, 0.5]]);
  // Next cycle continues the rotation.
  assert.deepEqual(expandCycle(ast.participants, 1).map(e => e.token), ['0', '1']);
});

test('subdivide [0 1 ~ 3]: rests advance time silently', () => {
  const ast = astOf('$ participants [0 1 ~ 3]\n');
  const evs = expandCycle(ast.participants, 0);
  assert.deepEqual(evs.map(e => [e.token, e.start, e.dur]), [
    ['0', 0, 0.25], ['1', 0.25, 0.25], ['3', 0.75, 0.25]
  ]);
});

test('@ weights and ! replication shape the subdivision', () => {
  const w = expandCycle(astOf('$ participants [0@3 1]\n').participants, 0);
  assert.deepEqual(w.map(e => [e.token, e.start, e.dur]), [['0', 0, 0.75], ['1', 0.75, 0.25]]);
  const r = expandCycle(astOf('$ participants [0!2 1]\n').participants, 0);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map(e => e.token), ['0', '0', '1']);
  assert.ok(Math.abs(r[1].start - 1 / 3) < 1e-12);
});

test('? degradation is deterministic per cycle (all clients agree)', () => {
  const ast = astOf('$ participants [0? 1? 2? 3? 4? 5? 6? 7?]\n');
  const a = expandCycle(ast.participants, 5).map(e => `${e.token}@${e.start}`);
  const b = expandCycle(ast.participants, 5).map(e => `${e.token}@${e.start}`);
  assert.deepEqual(a, b);
  // Across many cycles roughly half survive (sanity, not distribution law).
  let kept = 0;
  for (let c = 0; c < 50; c++) kept += expandCycle(ast.participants, c).length;
  assert.ok(kept > 100 && kept < 300, `kept ${kept} of 400`);
});

test('stacks (,) run concurrently offset by one cycle each', () => {
  const ast = astOf('$ participants <0 2, 1>\n');
  // Cycle 0: stack 1 (offset 1) is silent — before its epoch.
  assert.deepEqual(expandCycle(ast.participants, 0).map(e => [e.token, e.stack]), [['0', 0]]);
  // Cycle 1: stack 0 shows '2', stack 1 (effective cycle 0) shows '1'.
  const c1 = expandCycle(ast.participants, 1).map(e => [e.token, e.stack]);
  assert.deepEqual(c1, [['2', 0], ['1', 1]]);
});

test('nested groups subdivide their span', () => {
  const ast = astOf('$ participants <0 [1 2]>\n');
  const c1 = expandCycle(ast.participants, 1);
  assert.deepEqual(c1.map(e => [e.token, e.start, e.dur]), [['1', 0, 0.5], ['2', 0.5, 0.5]]);
});

// --- AV buffer queue ---------------------------------------------------------------

test('queue is FIFO; empty dequeue is null (slot silence, never a stall)', () => {
  const q = new AVBufferQueue();
  assert.equal(q.dequeue(), null);
  q.enqueue({ pattern: 'a', bytes: 0 });
  q.enqueue({ pattern: 'b', bytes: 0 });
  assert.equal(q.dequeue().pattern, 'a');
  assert.equal(q.dequeue().pattern, 'b');
  assert.equal(q.dequeue(), null);
});

test('depth bound evicts the oldest; byte bound evicts down to the cap', () => {
  const q = new AVBufferQueue({ maxBuffers: 3, maxBytes: 100 });
  for (let i = 0; i < 5; i++) q.enqueue({ pattern: String(i), bytes: 10 });
  assert.equal(q.length, 3);
  assert.equal(q.evicted, 2);
  assert.equal(q.peek().pattern, '2');

  const qb = new AVBufferQueue({ maxBuffers: 10, maxBytes: 100 });
  qb.enqueue({ pattern: 'big1', bytes: 80 });
  qb.enqueue({ pattern: 'big2', bytes: 80 }); // 160 > 100 → drop big1
  assert.equal(qb.length, 1);
  assert.equal(qb.peek().pattern, 'big2');
  assert.equal(qb.bytes, 80);
});

// --- Scheduler (fake clock) -----------------------------------------------------------

function makeScheduler(text, metrics) {
  let now = 0;
  const events = [];
  const sched = new MetaprogramScheduler({
    now: () => now,
    onEvent: (e) => events.push(e),
    lookaheadS: 0.05,
    setIntervalFn: null,
    clearIntervalFn: null
  });
  sched.setProgram(astOf(text));
  sched.setMetrics(metrics);
  return { sched, events, advance: (t) => { now = t; sched.tick(); }, nowRef: () => now };
}

test('integration: <0 1>*2 emits the slot open/close grid against the fake clock', () => {
  // wcl 900 ms, factor 3, 120 bpm → 6 beats = 3 s cycles.
  const { sched, events, advance } = makeScheduler(
    '$ participants <0 1>*2\n# cycles wcl 3\n',
    { wcl: 900 }
  );
  sched.start(0);
  advance(2.99); // covers cycle 0 only
  const c0 = events.filter(e => e.cycle === 0);
  assert.deepEqual(
    c0.map(e => [e.type, e.token ?? null, e.t]),
    [
      ['cycle-start', null, 0],
      ['slot-open', '0', 0], ['slot-close', '0', 1.5],
      ['slot-open', '1', 1.5], ['slot-close', '1', 3]
    ]
  );
  assert.equal(c0[0].seconds, 3);
  advance(3.01); // cycle 1 becomes visible inside the lookahead
  const c1open = events.filter(e => e.cycle === 1 && e.type === 'slot-open');
  assert.deepEqual(c1open.map(e => [e.token, e.t]), [['0', 3], ['1', 4.5]]);
});

test('program and metric changes land at the next cycle boundary, not mid-cycle', () => {
  const { sched, events, advance } = makeScheduler(
    // Implicit default is cycles wcl 2000; true LAN wcl 0.45 ms → 0.9 s
    // target → 2 beats = 1 s.
    '$ participants <0>\n', { wcl: 0.45 }
  );
  sched.start(0);
  advance(0.01);
  assert.equal(events.find(e => e.type === 'cycle-start').seconds, 1);

  sched.setProgram(astOf('$ participants <7>\n'));
  sched.setMetrics({ wcl: 1.2 }); // × 2000 → 2.4 s → 5 beats = 2.5 s
  advance(0.5); // still inside cycle 0 → nothing new applied yet
  assert.ok(!events.some(e => e.type === 'slot-open' && e.token === '7'));

  advance(1.01); // boundary crossed: new program + metrics take effect
  const c1 = events.filter(e => e.cycle === 1);
  assert.equal(c1.find(e => e.type === 'cycle-start').seconds, 2.5);
  assert.equal(c1.find(e => e.type === 'slot-open').token, '7');
});

test('a backward clock jump re-anchors the grid instead of silencing it', () => {
  // The clock this scheduler reads is not continuous: ClockSync converging
  // swaps a local estimate for the relay's reference, and the relay's clock is
  // hrtime since the SIDECAR started, so a restart moves it backwards. Left
  // alone the next boundary sits unreachably in the future and NOTHING is ever
  // emitted again — which silenced a live room.
  const { sched, events, advance } = makeScheduler('$ participants <0 1>\n# cycles wcl 1\n', { wcl: 4000 });
  sched.start(1000);
  advance(1010);
  const before = events.filter(e => e.type === 'cycle-start').length;
  assert.ok(before > 0, 'emitting before the jump');

  advance(510);   // clock falls back 500 s, far beyond any cycle
  advance(520);
  const after = events.filter(e => e.type === 'cycle-start').length;
  assert.ok(after > before, `kept emitting across the jump (${before} -> ${after})`);
});

test('a far-future clock jump re-anchors rather than grinding out every missed cycle', () => {
  const { sched, events, advance } = makeScheduler('$ participants <0>\n# cycles wcl 1\n', { wcl: 4000 });
  sched.start(0);
  advance(1);
  const startedAt = Date.now();
  advance(1e9);   // 1e9 s at 4 s cycles would be 250 million iterations
  assert.ok(Date.now() - startedAt < 1000, 'returned promptly instead of hanging');
  assert.ok(events.some(e => e.type === 'cycle-start' && e.t >= 1e9), 'resumed at the new clock');
});

test('ordinary lateness does NOT re-anchor — only a real adrift does', () => {
  const { sched, events, advance } = makeScheduler('$ participants <0>\n# cycles wcl 1\n', { wcl: 4000 });
  sched.start(0);
  advance(0.01);
  // A couple of cycles late is normal catch-up: boundaries must stay on the
  // original 4 s grid, not be snapped to the observation time.
  advance(9);
  const starts = events.filter(e => e.type === 'cycle-start').map(e => e.t);
  // Boundaries stay on the original 4 s grid rather than snapping to 9. The
  // 12 s boundary is correctly still ahead of the lookahead horizon.
  assert.deepEqual(starts, [0, 4, 8], 'grid preserved across ordinary lateness');
});

test('stop() halts emission; restart resumes from a fresh epoch', () => {
  const { sched, events, advance } = makeScheduler('$ participants <0>\n', { wcl: 0 });
  sched.start(0);
  advance(0.2);
  sched.stop();
  const n = events.length;
  advance(5);
  assert.equal(events.length, n);
});

// --- Deliberate program text edits -------------------------------------------------------

test('append/remove helpers edit the sequence text; user text is preserved', () => {
  let text = '$ participants <0 1>\n# cycles wcl\n# tempo 120 bpm\n';
  text = appendParticipantToProgram(text, '2');
  assert.match(text, /\$ participants <0 1 2>/);
  text = appendParticipantToProgram(text, '1a');
  assert.match(text, /\$ participants <0 1 2 1a>/);
  // Duplicate append is a no-op.
  assert.equal(appendParticipantToProgram(text, '2'), text);

  text = removeParticipantFromProgram(text, '1');
  assert.match(text, /\$ participants <0 2 1a>/);
  // Removing a token also removes its modifier-decorated occurrences.
  let custom = '$ participants [0@2 3? 0a]\n# cycles wcj\n# room 2\n';
  custom = removeParticipantFromProgram(custom, '3');
  assert.match(custom, /\$ participants \[0@2 0a\]/);
  assert.match(custom, /# room 2/, 'user directives untouched');
  // '1a' must not match owner '1'.
  assert.match(removeParticipantFromProgram('$ participants <1 1a>\n', '1'), /<1a>/);
});
