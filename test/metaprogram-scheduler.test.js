import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beatSeconds,
  timingTargetSeconds,
  cycleLength,
  describeCycleLength,
  expandCycle,
  AVBufferQueue,
  MetaprogramScheduler,
  WCPL_FULL_SCALE_S,
  MAX_EXPANSION_STEPS
} from '../src/audio-net/MetaprogramScheduler.js';
import {
  parseMetaprogram,
  appendParticipantToProgram,
  removeParticipantFromProgram,
  programHasParticipant,
  hasParticipantSequence
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

test('expandCycle tags each slot with its written-sequence index', () => {
  // `<0 1 0>` alternate: one entry per cycle, walking the written sequence —
  // the two `0`s are distinct occurrences and must not collapse to one index.
  const alt = astOf('$ participants <0 1 0>\n');
  assert.deepEqual(expandCycle(alt.participants, 0).map(e => [e.token, e.index]), [['0', 0]]);
  assert.deepEqual(expandCycle(alt.participants, 1).map(e => [e.token, e.index]), [['1', 1]]);
  assert.deepEqual(expandCycle(alt.participants, 2).map(e => [e.token, e.index]), [['0', 2]]);

  // `[0 1 0]` subdivide: all three share the cycle, indices in written order.
  const sub = astOf('$ participants [0 1 0]\n');
  assert.deepEqual(expandCycle(sub.participants, 0).map(e => [e.token, e.index]), [['0', 0], ['1', 1], ['0', 2]]);
});

test('slot-open and slot-close of the same slot share one id; ids are unique per cycle', () => {
  // `[0 1 0]` puts the same token in the cycle twice, which is exactly the case
  // (cycle, stack, token) cannot disambiguate — the aggregator pairs on `id`.
  const { sched, events } = makeScheduler('$ participants [0 1 0]\n# cycles wcl 1\n', { wcl: 3000 });
  sched.start(0);

  const opens = events.filter(e => e.type === 'slot-open' && e.cycle === 0);
  const closes = events.filter(e => e.type === 'slot-close' && e.cycle === 0);
  assert.equal(opens.length, 3);
  assert.equal(new Set(opens.map(e => e.id)).size, 3, 'every slot in a cycle gets its own id');
  assert.deepEqual(closes.map(e => e.id), opens.map(e => e.id), 'closes pair with opens');
  // The close lands exactly at open + dur, so a consumer can trust either edge.
  opens.forEach((open, i) => assert.equal(closes[i].t, open.t + open.dur));
});

test('getCycleLength reports the length in force, which is the aggregator turn length', () => {
  const { sched } = makeScheduler('$ participants <0>\n# cycles wcl 1\n', { wcl: 2000 });
  assert.equal(sched.getCycleLength().seconds, 2);
  sched.start(0);
  // Pending metrics land at the next boundary, not on the setter.
  sched.setMetrics({ wcl: 6000 });
  assert.equal(sched.getCycleLength().seconds, 2, 'still the length the last boundary scheduled');
});

test('describeCycleLength reports the length, the beat grid, and the metrics behind it', () => {
  const live = describeCycleLength({
    cycles: { metric: 'wcl', factor: 2, fixed: null },
    tempo: { value: 120, unit: 'bpm' },
    metrics: { wcl: 1500, wcpl: 0.02 }
  });
  assert.match(live, /^3\.000s \[6 beat\(s\) @ 0\.500s\] ← # cycles wcl 2 target 3\.000s /);
  assert.match(live, /wcl 1500\.0ms/);
  assert.match(live, /wcpl 2\.0%/);
  // A pinned amount says so, and reports the pinned target rather than the live one.
  const pinned = describeCycleLength({
    cycles: { metric: 'wcl', factor: 10, fixed: 0.3 },
    tempo: { value: 120, unit: 'bpm' },
    metrics: { wcl: 99000 }
  });
  assert.match(pinned, /# cycles wcl 10 0\.3 \(pinned\) target 3\.000s/);
});

test('the scheduler prints its cycle length on change and heartbeats when it holds', () => {
  const lines = [];
  let now = 0;
  const sched = new MetaprogramScheduler({
    now: () => now,
    onEvent: () => {},
    lookaheadS: 0.05,
    log: (l) => lines.push(l),
    label: 'test',
    setIntervalFn: null,
    clearIntervalFn: null
  });
  sched.setProgram(astOf('$ participants <0>\n# cycles wcl 1\n'));
  sched.setMetrics({ wcl: 1000 });
  sched.start(0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[test\] cycle length @ cycle 0: 1\.000s/);

  // A quiet run inside the heartbeat window prints nothing more...
  now = 5; sched.tick();
  assert.equal(lines.length, 1);
  // ...but a metrics change prints the new length and where it came from.
  sched.setMetrics({ wcl: 2500 });
  now = 6; sched.tick();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /cycle length @ cycle \d+: 2\.500s .* \(was 1\.000s\)$/);

  // Past the heartbeat window an unchanged length still reports.
  now = 40; sched.tick();
  assert.ok(lines.some(l => /cycle length steady/.test(l)), lines.join('\n'));
});

test('tempo units: bpm and cpm are per minute, cps per second', () => {
  assert.equal(beatSeconds({ value: 120, unit: 'bpm' }), 0.5);
  assert.equal(beatSeconds({ value: 120, unit: 'cpm' }), 0.5);
  assert.equal(beatSeconds({ value: 2, unit: 'cps' }), 0.5);
});

test('wcl uses ms; wcpl maps loss fraction onto the 10 s full scale', () => {
  assert.equal(timingTargetSeconds({ metric: 'wcl', factor: 2 }, { wcl: 250 }), 0.5);
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

test('subdivide [0 1 ~ 3]: a rest is a slot with nobody in it', () => {
  const ast = astOf('$ participants [0 1 ~ 3]\n');
  const evs = expandCycle(ast.participants, 0);
  // The rest occupies its share of the cycle like any other element — it is
  // emitted (so a consumer can say "resting HERE") but names no participant.
  assert.deepEqual(evs.map(e => [e.token, e.start, e.dur]), [
    ['0', 0, 0.25], ['1', 0.25, 0.25], [null, 0.5, 0.25], ['3', 0.75, 0.25]
  ]);
  assert.deepEqual(evs.map(e => e.rest === true), [false, false, true, false]);
  // Rests are numbered in their OWN index space, so the participant indices are
  // exactly what they would be with no rest in the program — the editor's two
  // scans (participants, rests) can never shift each other.
  assert.deepEqual(evs.map(e => e.index), [0, 1, 0, 2]);
});

test('every rest is addressable: `[0 ~ 1 ~]` numbers its two rests apart', () => {
  const ast = astOf('$ participants [0 ~ 1 ~]\n');
  const rests = expandCycle(ast.participants, 0).filter(e => e.rest);
  assert.deepEqual(rests.map(e => [e.index, e.start]), [[0, 0.25], [1, 0.75]]);
});

test('alternate `<0 ~ 1 ~>` rests on its own cycles, each naming its own `~`', () => {
  // The mode the aggregator actually runs, and a different path into emitInto
  // (one entry per cycle) than the subdivide case above.
  const ast = astOf('$ participants <0 ~ 1 ~>\n');
  const cycles = [];
  for (let c = 0; c < 4; c++) {
    const [ev] = expandCycle(ast.participants, c);
    cycles.push([ev.token, ev.rest === true, ev.index]);
  }
  assert.deepEqual(cycles, [
    ['0', false, 0],   // participant index 0
    [null, true, 0],   // rest index 0 — the two spaces number independently
    ['1', false, 1],
    [null, true, 1],
  ]);
});

test('`_` and `-` rest exactly as `~` does', () => {
  for (const glyph of ['~', '_', '-']) {
    const evs = expandCycle(astOf(`$ participants [0 ${glyph}]\n`).participants, 0);
    assert.deepEqual(evs.map(e => [e.token, e.rest === true]), [['0', false], [null, true]],
      `${glyph} rests`);
  }
});

test('a `?` that degrades to a rest has no written glyph, so no rest index', () => {
  // resolveEntry synthesizes that rest — it is in no index map, and there is no
  // `~` in the source to outline. It still occupies the slot.
  const ast = astOf('$ participants [0? 1? 2? 3? 4? 5? 6? 7?]\n');
  let degraded = 0;
  for (let c = 0; c < 50; c++) {
    for (const ev of expandCycle(ast.participants, c)) {
      if (!ev.rest) continue;
      degraded++;
      assert.equal(ev.index, null, 'a degraded participant addresses no rest glyph');
    }
  }
  assert.ok(degraded > 0, 'some cycles degrade');
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
  // Counted over the slots that still name a participant: a degraded one now
  // emits a rest slot rather than nothing, so the event count no longer moves.
  let kept = 0;
  for (let c = 0; c < 50; c++) kept += expandCycle(ast.participants, c).filter(e => !e.rest).length;
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

// --- Pattern-modifying operators --------------------------------------------------
//
// The turn a participant gets is what these operators move. `@` and `!` shape
// one repetition of the sequence, `*` `/` `%` set how fast the room reads it.

// One line per cycle, so a turn stretched over several cycles is visible as
// such rather than having to be inferred from starts and durations.
function cycles(text, n) {
  const ast = astOf(`$ participants ${text}\n`);
  const out = [];
  for (let c = 0; c < n; c++) {
    out.push(expandCycle(ast.participants, c).map(e => e.token).join(' '));
  }
  return out;
}

test('@ in an alternation lengthens the turn by that many cycles', () => {
  // `<0@2 1>`: one entry per cycle, but 0 is worth two of them — it holds the
  // ring for two whole cycles, which is what "plays twice as long" means when
  // a cycle IS the turn. The turn stays unbroken across the boundary.
  assert.deepEqual(cycles('<0@2 1>', 6), ['0', '0', '1', '0', '0', '1']);
  for (const cycle of [0, 1]) {
    assert.deepEqual(
      expandCycle(astOf('$ participants <0@2 1>\n').participants, cycle).map(e => [e.start, e.dur]),
      [[0, 1]], 'each of 0\'s cycles is a full-width slot, not a half'
    );
  }
  // In a subdivision the same weight buys a share of ONE cycle instead.
  const shares = expandCycle(astOf('$ participants [0@2 1]\n').participants, 0);
  assert.deepEqual(shares.map(e => e.token), ['0', '1']);
  assert.ok(Math.abs(shares[0].dur - 2 / 3) < 1e-12);
  assert.ok(Math.abs(shares[1].dur - 1 / 3) < 1e-12);
});

test('! repeats the turn that many times in a row', () => {
  assert.deepEqual(cycles('<0 1!3>', 8), ['0', '1', '1', '1', '0', '1', '1', '1']);
  // Bare `!` is Strudel's "once more" — and only binds when glued, so `0! 2`
  // is a doubled 0 followed by participant 2, not `0!2`.
  assert.deepEqual(cycles('<0! 2>', 6), ['0', '0', '2', '0', '0', '2']);
});

test('? drops the turn about half the time, per occurrence and identically everywhere', () => {
  const ast = astOf('$ participants <0 1?>\n');
  // Every client resolves the same cycle the same way.
  for (let c = 0; c < 20; c++) {
    assert.deepEqual(expandCycle(ast.participants, c), expandCycle(ast.participants, c));
  }
  // Both outcomes actually occur, near enough evenly. Counted over the slots
  // that still name a participant: a dropped turn emits a REST slot rather than
  // nothing, so the raw event count no longer moves.
  let kept = 0;
  for (let c = 1; c < 401; c += 2) kept += expandCycle(ast.participants, c).filter(e => !e.rest).length;
  assert.ok(kept > 60 && kept < 140, `kept ${kept} of 200`);
  // An explicit probability is honoured: ?1 always drops, ?0 never does.
  assert.deepEqual(cycles('<0 1?1>', 4), ['0', '', '0', '']);
  assert.deepEqual(cycles('<0 1?0>', 4), ['0', '1', '0', '1']);
});

test("a stretched turn's ? is decided once, not re-flipped at every cycle boundary", () => {
  // `0a?` is worth four cycles here (@2 doubled again by /2). The draw is
  // seeded by the OCCURRENCE, so those four cycles are all-or-nothing — the
  // turn must not flicker in and out mid-solo.
  const ast = astOf('$ participants <1@6 0a?@2>/2\n');
  // Counted over participant slots — a dropped turn still fills its span with a
  // rest slot, so the raw event count is 1 either way and would flicker unseen.
  let dropped = 0;
  for (let turn = 0; turn < 6; turn++) {
    const played = [0, 1, 2, 3].map(
      k => expandCycle(ast.participants, turn * 16 + 12 + k).filter(e => !e.rest).length
    );
    assert.ok(
      played.every(n => n === played[0]),
      `turn ${turn} flickered across its four cycles: ${played.join(',')}`
    );
    if (played[0] === 0) dropped++;
  }
  // …and the run actually exercises both outcomes, so "never flickers" is not
  // being satisfied by a turn that simply always played.
  assert.ok(dropped > 0 && dropped < 6, `${dropped} of 6 turns dropped`);
});

test('* halves each turn and packs more per cycle; / doubles each turn', () => {
  // The plan's worked example. `<0@2 1!3 0a?>` spends 6 units per lap: 0 for
  // two, 1 for three, 0a for one.
  const bare = cycles('<0@2 1!3 0a?>', 6);
  assert.deepEqual(bare.slice(0, 5), ['0', '0', '1', '1', '1']);

  // *2 reads two units per cycle: every turn is half as long, so 0's two units
  // become one cycle and 1's three units become three half-cycle turns.
  const fast = expandCycle(astOf('$ participants <0@2 1!3 0a?>*2\n').participants, 0);
  assert.deepEqual(fast.map(e => [e.token, e.start, e.dur]), [['0', 0, 1]]);
  assert.deepEqual(
    expandCycle(astOf('$ participants <0@2 1!3 0a?>*2\n').participants, 1)
      .map(e => [e.token, e.start, e.dur]),
    [['1', 0, 0.5], ['1', 0.5, 0.5]]
  );

  // /2 reads half a unit per cycle: 0's turn runs 4 cycles — four times the
  // *2 version's one and twice the unmodified version's two.
  assert.deepEqual(cycles('<0@2 1!3 0a?>/2', 10),
    ['0', '0', '0', '0', '1', '1', '1', '1', '1', '1']);

  // Same operators on a subdivision: /2 hands each element a whole cycle.
  assert.deepEqual(cycles('[0 1]/2', 4), ['0', '1', '0', '1']);
  assert.deepEqual(cycles('[0 1]*2', 1), ['0 1 0 1']);
  // And they compose, so *4/2 is ×2.
  assert.deepEqual(cycles('<0 1>*4/2', 2), ['0 1', '0 1']);
});

test('* and / on a token alone repeat or hold that one turn', () => {
  // `0*2` splits 0's own slot into two turns; the rest of the cycle is untouched.
  assert.deepEqual(
    expandCycle(astOf('$ participants [0*2 1]\n').participants, 0).map(e => [e.token, e.start, e.dur]),
    [['0', 0, 0.25], ['0', 0.25, 0.25], ['1', 0.5, 0.5]]
  );
  // `0/2` holds one turn across the whole slot rather than retriggering.
  assert.deepEqual(
    expandCycle(astOf('$ participants [0/2 1]\n').participants, 0).map(e => [e.token, e.dur]),
    [['0', 0.5], ['1', 0.5]]
  );
});

test('% sets steps per cycle', () => {
  assert.deepEqual(cycles('<0 1 2>%2', 3), ['0 1', '2 0', '1 2']);
  assert.deepEqual(cycles('[0 1 2 3]%2', 2), ['0 1', '2 3']);
});

test('a nested alternation advances once per visit, not once per cycle', () => {
  // Tidal/Strudel semantics: the inner pair only steps on the cycles it is
  // actually reached, so this is 0 1 0 2 — not 0 2 0 2.
  assert.deepEqual(cycles('<0 <1 2>>', 6), ['0', '1', '0', '2', '0', '1']);
  // Reached every cycle inside a subdivision, it steps every cycle.
  assert.deepEqual(cycles('[0 <1 2>]', 4), ['0 1', '0 2', '0 1', '0 2']);
  // A nested rate slices the inner group across the outer's cycles.
  assert.deepEqual(cycles('[0 [1 2]/2]', 4), ['0 1', '0 2', '0 1', '0 2']);
  assert.deepEqual(cycles('[0 [1 2]*2]', 1), ['0 1 2 1 2']);
});

test('an absurd rate degrades in both directions rather than silencing the room', () => {
  // Neither of these is a parse error, so an unclamped rate would silence the
  // room with no diagnostic anywhere: `*1e9` drives every span below EPS and
  // `/1e9` puts the whole window there, and BOTH then emit nothing for ever.
  const fast = expandCycle(astOf('$ participants <0 1>*1000000000\n').participants, 0);
  assert.ok(fast.length > 0, 'a huge speed-up still schedules turns');
  assert.ok(fast.length <= MAX_EXPANSION_STEPS, `emitted ${fast.length}`);
  const slowAst = astOf('$ participants <0 1>/1000000000\n').participants;
  for (let c = 0; c < 5; c++) {
    assert.equal(expandCycle(slowAst, c).length, 1, `cycle ${c} of a huge slow-down went silent`);
  }
  // The scheduler's tick is the loop that keeps the room streaming, so however
  // the rate is written it must also return promptly rather than grinding out
  // a billion repetitions.
  const started = Date.now();
  expandCycle(astOf('$ participants [<0 1>*1000000000]*1000000000\n').participants, 0);
  assert.ok(Date.now() - started < 1000, 'nested extremes still return promptly');
  // A merely dense rate is expanded in full, untouched by clamp or budget.
  assert.equal(expandCycle(astOf('$ participants <0 1>*100\n').participants, 0).length, 100);
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
    log: false,
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
    // Implicit default is cycles wcl 20; wcl is mouth-to-ear latency, so a
    // 45 ms room → 0.9 s target → 2 beats = 1 s.
    '$ participants <0>\n', { wcl: 45 }
  );
  sched.start(0);
  advance(0.01);
  assert.equal(events.find(e => e.type === 'cycle-start').seconds, 1);

  sched.setProgram(astOf('$ participants <7>\n'));
  sched.setMetrics({ wcl: 120 }); // × 20 → 2.4 s → 5 beats = 2.5 s
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

test('getCyclePosition reports fractional cycles for patterned effect arguments', () => {
  // wcl 900 ms, factor 3, 120 bpm → 3 s cycles (as above).
  const { sched, advance, nowRef } = makeScheduler(
    '$ participants <0>\n# cycles wcl 3\n', { wcl: 900 }
  );
  assert.equal(sched.getCyclePosition(0), null, 'no grid before start()');
  sched.start(0);
  advance(0);
  assert.equal(sched.getCyclePosition(nowRef()), 0);
  advance(1.5);
  assert.equal(sched.getCyclePosition(nowRef()), 0.5, 'halfway through cycle 0');
  advance(3);
  assert.equal(sched.getCyclePosition(nowRef()), 1);
  advance(7.5);
  assert.equal(sched.getCyclePosition(nowRef()), 2.5);
  // The lookahead schedules cycles ahead of the clock; the position must
  // follow the clock, not the furthest boundary already emitted.
  assert.equal(sched.getCyclePosition(6.0), 2);
});

test('getCyclePosition tracks the boundaries actually emitted, not a live division', () => {
  // A cycle-length change mid-run must not renumber the cycles already past:
  // 1 s cycles for three of them, then 2 s. Dividing elapsed time by the
  // current length would read cycle 1.5 where the grid says 3.
  const { sched, advance, nowRef } = makeScheduler(
    '$ participants <0>\n# cycles wcl 1 1\n', { wcl: 0 }
  );
  sched.start(0);
  advance(2.5);
  assert.equal(sched.getCyclePosition(nowRef()), 2.5);
  sched.setMetrics({ wcl: 0 });
  sched.setProgram(astOf('$ participants <0>\n# cycles wcl 1 2\n'));
  advance(3.0);
  assert.equal(sched.getCyclePosition(nowRef()), 3, 'boundary 3 is still cycle 3');
  advance(4.0);
  assert.equal(sched.getCyclePosition(nowRef()), 3.5, 'now halfway through a 2 s cycle');
});

test('a fast grid keeps the cycle containing now, however far the lookahead runs', () => {
  // 900 bpm → 1-beat cycles of ~0.067 s, so the 0.2 s lookahead schedules
  // several boundaries AHEAD of the clock every tick. Trimming the retained
  // grid by count alone would evict the cycle that is actually sounding and
  // freeze every value pattern on its first element.
  const { sched, advance, nowRef } = makeScheduler(
    '$ participants <0>\n# tempo 900 bpm\n', { wcl: 0 }
  );
  sched.start(0);
  for (let t = 0; t <= 2; t += 0.05) {
    advance(t);
    const pos = sched.getCyclePosition(nowRef());
    assert.ok(pos != null, `no position at t=${t.toFixed(2)}`);
    assert.ok(Math.abs(pos - t / (60 / 900)) < 1, `position adrift at t=${t.toFixed(2)}`);
  }
});

test('a stopped grid has no position rather than a frozen one', () => {
  const { sched, advance, nowRef } = makeScheduler(
    '$ participants <0>\n# cycles wcl 3\n', { wcl: 900 }
  );
  sched.start(0);
  advance(1.5);
  assert.equal(sched.getCyclePosition(nowRef()), 0.5);
  sched.stop();
  assert.equal(sched.getCyclePosition(nowRef()), null, 'not a plausible-looking stale value');
});

test('a re-anchor drops the old grid rather than reading a position off it', () => {
  const { sched, advance, nowRef } = makeScheduler(
    '$ participants <0>\n# cycles wcl 3\n', { wcl: 900 }
  );
  sched.start(0);
  advance(3);
  assert.equal(sched.getCyclePosition(nowRef()), 1);
  advance(-60); // clock jumped backwards past everything scheduled
  const pos = sched.getCyclePosition(nowRef());
  assert.equal(pos, 2, 'the counter keeps going across a re-anchor; only the clock moved');
  assert.equal(pos % 1, 0, 'and lands on a boundary, not partway through an abandoned cycle');
  // An instant from the discarded grid no longer resolves against it.
  assert.ok(sched.getCyclePosition(1) >= 2);
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
  let custom = '$ participants [0@2 3? 0a]\n# cycles wcl\n# room 2\n';
  custom = removeParticipantFromProgram(custom, '3');
  assert.match(custom, /\$ participants \[0@2 0a\]/);
  assert.match(custom, /# room 2/, 'user directives untouched');
  // '1a' must not match owner '1'.
  assert.match(removeParticipantFromProgram('$ participants <1 1a>\n', '1'), /<1a>/);
  // A token written WITH its modifiers is removable on its own terms — that
  // is how a `*$ participants <1@2>` button takes its voice back out — while
  // the bare owner still takes every decorated occurrence with it.
  assert.match(removeParticipantFromProgram('$ participants <0 1@2>\n', '1@2'), /<0>/);
  assert.match(removeParticipantFromProgram('$ participants <0 1@2>\n', '1'), /<0>/);
  assert.match(removeParticipantFromProgram('$ participants <0 1@2>\n', '1@3'), /<0 1@2>/);
});

test('participant membership answers for decorated tokens without a regex throw', () => {
  const text = '$ participants <0 1@2 2a>\n# cycles wcl\n';
  assert.equal(programHasParticipant(text, '0'), true);
  assert.equal(programHasParticipant(text, '1@2'), true);
  assert.equal(programHasParticipant(text, '2a'), true);
  assert.equal(programHasParticipant(text, '2'), false);
  assert.equal(programHasParticipant(text, '3'), false);
  // No `$ participants` statement → nothing is a member, and nothing throws.
  assert.equal(programHasParticipant('# cycles wcl\n', '0'), false);
  assert.equal(hasParticipantSequence(text), true);
  assert.equal(hasParticipantSequence('# cycles wcl\n'), false);
  assert.equal(hasParticipantSequence(''), false);
});

test('the roster helpers edit the LIVE statement, not a declaration or a comment', () => {
  // A `*$` button declaration and a commented-out line both contain the text
  // `$ participants <…>`; neither is the running program, and an unanchored
  // match would edit whichever came first in the file.
  const declared = '*$ participants <2a 2b>\n$ participants <0 1>\n# cycles wcl 20\n';
  assert.equal(programHasParticipant(declared, '0'), true);
  assert.equal(programHasParticipant(declared, '2a'), false);
  assert.match(appendParticipantToProgram(declared, '5'), /^\$ participants <0 1 5>$/m);
  assert.match(appendParticipantToProgram(declared, '5'), /^\*\$ participants <2a 2b>$/m);
  assert.match(removeParticipantFromProgram(declared, '0'), /^\$ participants <1>$/m);

  const commented = '// $ participants <0 1> — retired\n# cycles wcl 20\n';
  assert.equal(hasParticipantSequence(commented), false);
  assert.equal(appendParticipantToProgram(commented, '5'), commented);

  // An emptied sequence takes the next append without a stray separator.
  assert.match(appendParticipantToProgram('$ participants <>\n', '0'), /<0>/);
});
