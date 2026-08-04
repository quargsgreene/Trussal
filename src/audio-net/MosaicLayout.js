// MosaicLayout.js — where each Hydra participant's canvas sits in the
// aggregator's published frame.
//
// Slots, not a list. A participant keeps the index they were given for as long
// as they are running Hydra, so the mosaic doesn't reshuffle every time
// somebody else starts or stops — the room learns "top-left is Ada" and that
// stays true. A departure blanks its index rather than closing the gap, and
// the next arrival fills the earliest blank before the array ever grows. That
// is the whole reason this is an array with holes instead of a Set.
//
// Pure: no DOM, no canvases. The page script owns creating and destroying the
// actual elements; this module only decides who is where and how big.

// The side of the square arrangement: ceil(sqrt(n)) cells per row, and the
// same number of rows. n counts OCCUPIED slots, not the array length, so a
// mosaic with holes packs down as tightly as its occupants allow.
export function gridSide(occupied) {
  const n = Math.max(0, Math.floor(occupied));
  return n === 0 ? 0 : Math.ceil(Math.sqrt(n));
}

export function occupancy(slots) {
  return (slots || []).reduce((n, token) => n + (token == null ? 0 : 1), 0);
}

// Trailing blanks are not a position anyone can be at — they would inflate the
// array without changing what is drawn, and would make "append to the end"
// leave a growing tail of holes behind a churning room. Canonical form has no
// trailing null.
function trimTrailingBlanks(slots) {
  const out = slots.slice();
  while (out.length && out[out.length - 1] == null) out.pop();
  return out;
}

// Holes cost grid space that the arrangement — sized by ceil(sqrt(occupied)) —
// has not got. Four of five performers stopping leaves [A,·,·,·,E]: one
// occupant at index 4, but a 2×2 grid with only four cells. Something has to
// give, and it is position stability, but only exactly as far as needed: close
// the EARLIEST hole and re-check, so occupants keep their indices whenever the
// layout can still hold them. Terminates because a hole-free array has length
// === occupied, and k*k >= occupied always.
function fitToGrid(slots) {
  const out = trimTrailingBlanks(slots);
  const k = gridSide(occupancy(out));
  while (out.length > k * k) {
    const hole = out.indexOf(null);
    if (hole === -1) break; // unreachable: no holes means length === occupied
    out.splice(hole, 1);
  }
  return out;
}

// Give `token` a slot: the earliest blank if one exists, otherwise a new index
// at the end (the bottom-right-most contiguous position). Idempotent — a token
// already placed keeps the index it has, so a repeated code update doesn't
// move a performer's cell.
export function assignSlot(slots, token) {
  const out = trimTrailingBlanks(slots || []);
  if (token == null) return out;
  if (out.includes(token)) return out;
  const gap = out.indexOf(null);
  if (gap === -1) out.push(token);
  else out[gap] = token;
  return out;
}

// Blank `token`'s slot, keeping every other participant's index. The canvas is
// removed by the caller; the hole stays so the next arrival can take it.
export function releaseSlot(slots, token) {
  const out = (slots || []).slice();
  const at = out.indexOf(token);
  if (at !== -1) out[at] = null;
  return fitToGrid(out);
}

// Reconcile the slot array against the set of tokens currently running Hydra,
// in one step: everyone who stopped is blanked, everyone new is assigned (in
// the order given), everyone else stays put. This is what a peer-state update
// calls, so a batch of changes in one roster message can't produce a different
// layout than the same changes arriving one at a time.
export function reconcileSlots(slots, hydraTokens) {
  const wanted = new Set(hydraTokens || []);
  let out = trimTrailingBlanks(slots || []);
  for (const token of out) {
    if (token != null && !wanted.has(token)) out = releaseSlot(out, token);
  }
  for (const token of hydraTokens || []) out = assignSlot(out, token);
  return out;
}

// The cell rectangle for a slot index, in device pixels of a `width`×`height`
// frame. Cells fill the frame: each is width/k by height/k, so on a 16:9
// output the cells are 16:9 too and no black bars are published. Returns null
// for an index outside the current arrangement.
export function cellRect(index, occupied, width, height) {
  const k = gridSide(occupied);
  if (!k || !(index >= 0) || index >= k * k) return null;
  const w = width / k;
  const h = height / k;
  return {
    x: (index % k) * w,
    y: Math.floor(index / k) * h,
    w,
    h
  };
}

// Every drawable cell of the current layout, in slot order — blanks omitted.
// `{ token, index, rect }` is exactly what the compositor needs per frame.
export function layoutCells(slots, width, height) {
  const list = slots || [];
  const occupied = occupancy(list);
  const out = [];
  for (let index = 0; index < list.length; index++) {
    const token = list[index];
    if (token == null) continue;
    const rect = cellRect(index, occupied, width, height);
    if (rect) out.push({ token, index, rect });
  }
  return out;
}
