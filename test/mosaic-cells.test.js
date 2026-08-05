import test from 'node:test';
import assert from 'node:assert/strict';

import { mosaicCellsForPeers, cellsEqual, compareTokens } from '../src/audio-net/MosaicCells.js';

const HYDRA = 'await initHydra()\nosc(10).out()';
const HYDRA_CAM = 'await initHydra()\nsrc(s0).out()';

function peer(over = {}) {
  return { peerId: `p${over.roomIndex ?? 0}`, roomIndex: '0', jitsiId: 'j0', pattern: HYDRA, ...over };
}

test('cells: only peers running Hydra get one', () => {
  const cells = mosaicCellsForPeers([
    peer({ roomIndex: '0', pattern: HYDRA }),
    peer({ roomIndex: '1', pattern: 's("bd sd")' }),
    peer({ roomIndex: '2', pattern: '' })
  ]);
  assert.deepEqual(cells.map(c => c.token), ['0']);
});

test('cells: the aggregator never appears in its own mosaic', () => {
  const cells = mosaicCellsForPeers([
    peer({ roomIndex: 'pi', isAggregator: true }),
    peer({ roomIndex: '0' })
  ]);
  assert.deepEqual(cells.map(c => c.token), ['0']);
});

test('cells: a peer with no room index can never take a turn, so gets no cell', () => {
  const cells = mosaicCellsForPeers([peer({ roomIndex: null })]);
  assert.deepEqual(cells, []);
});

test('cells: bots are participants like anyone else', () => {
  const cells = mosaicCellsForPeers([
    peer({ roomIndex: '0' }),
    peer({ roomIndex: '0a', isBot: true })
  ]);
  assert.deepEqual(cells.map(c => c.token), ['0', '0a']);
});

// The exact shape a bot announces: its generated Hydra preamble, a blank line,
// then the Strudel half (bots/src/bot/page-scripts.js, pageStrudelBoot). The
// test above passes a hand-written Hydra pattern, which is why it stayed green
// while production bots announced their Strudel half alone — and every ring
// turn that fell to a bot published a black frame.
const BOT_ANNOUNCED = [
  'await initHydra()',
  'osc(60,0.1,1.4).kaleid(4).out(o0)',
  '',
  'stack(',
  '  s("[bd ~]*2 sd:2"),',
  '  note("c3 eb3").s("sawtooth")',
  ')'
].join('\n');

test('cells: a bot announcing its whole program earns a cell, with its preamble intact', () => {
  const cells = mosaicCellsForPeers([peer({ roomIndex: '0a', isBot: true, pattern: BOT_ANNOUNCED })]);
  assert.deepEqual(cells.map(c => c.token), ['0a']);
  assert.equal(cells[0].preamble, 'await initHydra()\nosc(60,0.1,1.4).kaleid(4).out(o0)');
  assert.equal(cells[0].source, 'reexecute');
});

test('cells: a bot announcing only its Strudel half earns none', () => {
  // The pre-fix production behaviour, pinned so it cannot return unnoticed.
  const cells = mosaicCellsForPeers([
    peer({ roomIndex: '0a', isBot: true, pattern: 'stack(\n  s("[bd ~]*2 sd:2")\n)' })
  ]);
  assert.deepEqual(cells, []);
});

test('cells: camera-fed code is blitted, everything else re-executed', () => {
  const cells = mosaicCellsForPeers([
    peer({ roomIndex: '0', pattern: HYDRA }),
    peer({ roomIndex: '1', pattern: HYDRA_CAM })
  ]);
  assert.deepEqual(cells.map(c => c.source), ['reexecute', 'blit']);
});

test('cells: only the Hydra preamble crosses into the page', () => {
  const cells = mosaicCellsForPeers([
    peer({ pattern: `${HYDRA}\n\ns("bd sd").fast(2)` })
  ]);
  assert.equal(cells[0].preamble, HYDRA);
  assert.ok(!cells[0].preamble.includes('bd sd'));
});

test('cells: a Map roster (as the aggregator holds it) is accepted', () => {
  const roster = new Map([['p0', peer({ roomIndex: '0' })]]);
  assert.deepEqual(mosaicCellsForPeers(roster).map(c => c.token), ['0']);
});

test('cells: order is stable and numeric, so simultaneous arrivals agree', () => {
  const cells = mosaicCellsForPeers([
    peer({ roomIndex: '10' }),
    peer({ roomIndex: '2' }),
    peer({ roomIndex: '9' })
  ]);
  assert.deepEqual(cells.map(c => c.token), ['2', '9', '10']);
});

test('cells: bot tokens sort after plain indices', () => {
  assert.deepEqual(['2a', '1', '10'].sort(compareTokens), ['1', '10', '2a']);
});

// --- change gate --------------------------------------------------------------

test('cells: equality ignores metrics churn but catches a code edit', () => {
  const before = mosaicCellsForPeers([peer({ rtt: 30 })]);
  const sameCode = mosaicCellsForPeers([peer({ rtt: 90 })]);
  assert.ok(cellsEqual(before, sameCode), 'a metrics-only update must not re-push');

  const edited = mosaicCellsForPeers([peer({ pattern: 'await initHydra()\nosc(40).out()' })]);
  assert.ok(!cellsEqual(before, edited), 'an edited preamble must re-push');
});

test('cells: equality catches a peer starting or stopping Hydra', () => {
  const one = mosaicCellsForPeers([peer({ roomIndex: '0' })]);
  const two = mosaicCellsForPeers([peer({ roomIndex: '0' }), peer({ roomIndex: '1' })]);
  assert.ok(!cellsEqual(one, two));
  assert.ok(!cellsEqual(two, []));
});

test('cells: equality catches a peer switching to camera-fed code', () => {
  const reexec = mosaicCellsForPeers([peer({ pattern: HYDRA })]);
  const blit = mosaicCellsForPeers([peer({ pattern: HYDRA_CAM })]);
  assert.ok(!cellsEqual(reexec, blit));
});

test('cells: a preamble binding parameters to patterns is flagged for the page', () => {
  const cells = mosaicCellsForPeers([
    peer({ roomIndex: '0', pattern: 'await initHydra()\nosc(10).out()' }),
    peer({ roomIndex: '1', pattern: 'await initHydra()\nosc(H("<10 40>")).out()' })
  ]);
  assert.deepEqual(cells.map(c => c.usesPatternParams), [false, true]);
});

test('cells: adding an H() binding re-pushes, so the cell waits for Strudel', () => {
  const plain = mosaicCellsForPeers([peer({ pattern: 'await initHydra()\nosc(10).out()' })]);
  const bound = mosaicCellsForPeers([peer({ pattern: 'await initHydra()\nosc(H("<10 40>")).out()' })]);
  assert.ok(!cellsEqual(plain, bound));
});
