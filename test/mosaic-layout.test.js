import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gridSide,
  occupancy,
  assignSlot,
  releaseSlot,
  reconcileSlots,
  cellRect,
  layoutCells
} from '../src/audio-net/MosaicLayout.js';

// --- grid side ----------------------------------------------------------------

test('mosaic: side is ceil(sqrt(n)) over the occupied cells', () => {
  assert.equal(gridSide(0), 0);
  assert.equal(gridSide(1), 1);
  assert.equal(gridSide(2), 2);
  assert.equal(gridSide(4), 2);
  assert.equal(gridSide(5), 3);
  assert.equal(gridSide(9), 3);
  assert.equal(gridSide(10), 4);
});

test('mosaic: occupancy ignores blanks', () => {
  assert.equal(occupancy([]), 0);
  assert.equal(occupancy(['a', null, 'c']), 2);
});

// --- slot assignment ----------------------------------------------------------

test('mosaic: a full arrangement appends at the end', () => {
  let slots = [];
  slots = assignSlot(slots, 'a');
  slots = assignSlot(slots, 'b');
  slots = assignSlot(slots, 'c');
  assert.deepEqual(slots, ['a', 'b', 'c']);
});

test('mosaic: an arrival fills the earliest blank before growing', () => {
  const slots = releaseSlot(['a', 'b', 'c', 'd'], 'b');
  assert.deepEqual(slots, ['a', null, 'c', 'd']);
  assert.deepEqual(assignSlot(slots, 'e'), ['a', 'e', 'c', 'd']);
});

test('mosaic: a departure blanks in place, keeping everyone else put', () => {
  assert.deepEqual(releaseSlot(['a', 'b', 'c'], 'b'), ['a', null, 'c']);
});

test('mosaic: trailing blanks are trimmed, not kept as positions', () => {
  assert.deepEqual(releaseSlot(['a', 'b', 'c'], 'c'), ['a', 'b']);
  assert.deepEqual(releaseSlot(['a', null, 'c'], 'c'), ['a']);
});

test('mosaic: assigning an already-placed token does not move it', () => {
  const slots = ['a', null, 'c'];
  assert.deepEqual(assignSlot(slots, 'c'), ['a', null, 'c']);
});

// The regression this module's fitToGrid exists for: five performers, then
// three stop. Occupancy 2 means a 2x2 grid, but 'e' sits at index 4 — outside
// it. Holes must close far enough that every occupant still has a cell.
test('mosaic: holes close only as far as the shrunken grid requires', () => {
  let slots = ['a', 'b', 'c', 'd', 'e'];
  // Losing 'b' drops the grid to 2x2 = 4 cells while the array is 5 long, so
  // one hole closes and 'e' moves inside. The next two departures leave holes
  // that the 2x2 can still hold, so 'a' and 'e' keep the corners they have.
  slots = releaseSlot(slots, 'b');
  assert.deepEqual(slots, ['a', 'c', 'd', 'e']);
  for (const gone of ['c', 'd']) slots = releaseSlot(slots, gone);
  assert.deepEqual(slots, ['a', null, null, 'e']);
  assert.equal(occupancy(slots), 2);
  // Every occupant is still drawable — nobody fell off the arrangement.
  const cells = layoutCells(slots, 900, 900);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map(c => c.rect), [
    { x: 0, y: 0, w: 450, h: 450 },
    { x: 450, y: 450, w: 450, h: 450 }
  ]);
});

test('mosaic: a hole that still fits the grid is preserved', () => {
  // Occupancy 3 -> k=2 -> 4 cells; length 3 fits, so the hole stays.
  assert.deepEqual(releaseSlot(['a', 'b', 'c', 'd'], 'b'), ['a', null, 'c', 'd']);
});

// --- reconciliation -----------------------------------------------------------

test('mosaic: reconcile lands the same layout as one-at-a-time changes', () => {
  const start = ['a', 'b', 'c'];
  const batched = reconcileSlots(start, ['a', 'c', 'd']);
  const stepwise = assignSlot(releaseSlot(start, 'b'), 'd');
  assert.deepEqual(batched, stepwise);
  assert.deepEqual(batched, ['a', 'd', 'c']);
});

test('mosaic: reconcile to nobody empties the arrangement', () => {
  assert.deepEqual(reconcileSlots(['a', 'b'], []), []);
});

test('mosaic: reconcile is idempotent', () => {
  const once = reconcileSlots([], ['a', 'b', 'c']);
  assert.deepEqual(reconcileSlots(once, ['a', 'b', 'c']), once);
});

// --- geometry -----------------------------------------------------------------

test('mosaic: cells fill the frame, so a 16:9 output has 16:9 cells', () => {
  // n=5 -> k=3 -> 1280/3 x 720/3
  const rect = cellRect(0, 5, 1280, 720);
  assert.equal(rect.w, 1280 / 3);
  assert.equal(rect.h, 720 / 3);
  assert.ok(Math.abs(rect.w / rect.h - 1280 / 720) < 1e-12);
});

test('mosaic: a lone participant takes the whole frame', () => {
  assert.deepEqual(cellRect(0, 1, 1280, 720), { x: 0, y: 0, w: 1280, h: 720 });
});

test('mosaic: indices run left to right, top to bottom', () => {
  const at = (i) => cellRect(i, 5, 900, 900);
  assert.deepEqual(at(0), { x: 0, y: 0, w: 300, h: 300 });
  assert.deepEqual(at(2), { x: 600, y: 0, w: 300, h: 300 });
  assert.deepEqual(at(3), { x: 0, y: 300, w: 300, h: 300 });
  assert.deepEqual(at(8), { x: 600, y: 600, w: 300, h: 300 });
});

test('mosaic: the bottom row is filled left to right, leaving the rest blank', () => {
  // Five occupants in a 3x3: indices 0..4 are drawn, 5..8 never appear.
  const cells = layoutCells(['a', 'b', 'c', 'd', 'e'], 900, 900);
  assert.deepEqual(cells.map(c => c.index), [0, 1, 2, 3, 4]);
  const bottomRow = cells.filter(c => c.rect.y === 300);
  assert.deepEqual(bottomRow.map(c => c.rect.x), [0, 300]);
});

test('mosaic: layout omits blank slots but keeps the survivors indexed', () => {
  const cells = layoutCells(['a', null, 'c', 'd'], 1280, 720);
  assert.deepEqual(cells.map(c => c.token), ['a', 'c', 'd']);
  assert.deepEqual(cells.map(c => c.index), [0, 2, 3]);
});

test('mosaic: an empty arrangement draws nothing', () => {
  assert.deepEqual(layoutCells([], 1280, 720), []);
  assert.equal(cellRect(0, 0, 1280, 720), null);
});
