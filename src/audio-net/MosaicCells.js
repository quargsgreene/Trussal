// MosaicCells.js — which peers get a cell in the aggregator's mosaic, and what
// fills it.
//
// The membership question, kept separate from MosaicLayout's geometry
// question. Given the roster the aggregator already holds (the sidecar's
// public peer view), this decides who is running Hydra right now and how their
// pixels are produced — re-executed locally, or blitted from their published
// track when the code reads a camera the aggregator hasn't got.
//
// Pure, so the aggregator can be tested without a browser: the page script is
// handed the result and does nothing but create, destroy and draw.

import { mosaicCellSource, splitHydraCode, usesPatternParams } from '../hydra-code.js';

// A peer earns a cell when it is a real ring participant running Hydra. The
// aggregator itself is excluded by its own `isAggregator` flag — the sidecar
// sets it on the aggregator's in-page record, which is the only form the
// aggregator appears in on this roster. It renders the mosaic rather than
// appearing in it, and a cell fed from its own published track would be a
// video feedback loop. Peers with no room index are excluded too: the ring
// addresses participants by token, so one without an index can never take a
// turn and its cell could never light up.
export function mosaicCellsForPeers(peers) {
  const list = Array.isArray(peers) ? peers : [...(peers?.values?.() ?? [])];
  const cells = [];
  for (const peer of list) {
    if (!peer || peer.isAggregator) continue;
    const token = peer.roomIndex == null ? null : String(peer.roomIndex);
    if (!token) continue;
    const source = mosaicCellSource(peer.pattern);
    if (!source) continue;
    cells.push({
      token,
      jitsiId: peer.jitsiId ?? null,
      source,
      // Only the preamble crosses into the page — the Strudel half is audio,
      // and the aggregator already has that peer's sound on the master bus.
      preamble: splitHydraCode(peer.pattern).preamble,
      // Whether this cell must wait for the Strudel pattern machinery before
      // its preamble runs: `H(...)` binds a parameter at evaluation time, so a
      // cell evaluated too early binds the fallback for the instance's life.
      usesPatternParams: usesPatternParams(peer.pattern)
    });
  }
  // Stable order so a batch of simultaneous arrivals lands the same slots on
  // any run: by token, numerically where both are plain indices (so 10 sorts
  // after 9, not after 1), lexically otherwise (bot tokens like '2a').
  cells.sort((a, b) => compareTokens(a.token, b.token));
  return cells;
}

export function compareTokens(a, b) {
  const na = Number(a);
  const nb = Number(b);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Whether two cell lists differ in anything the page must act on. The
// aggregator recomputes cells on every peer update — which arrives on every
// metrics tick, several times a second per peer — so without this the page
// would be re-evaluating Hydra preambles continuously.
export function cellsEqual(a, b) {
  const x = a || [];
  const y = b || [];
  if (x.length !== y.length) return false;
  return x.every((cell, i) => (
    cell.token === y[i].token &&
    cell.jitsiId === y[i].jitsiId &&
    cell.source === y[i].source &&
    cell.preamble === y[i].preamble &&
    cell.usesPatternParams === y[i].usesPatternParams
  ));
}
