/**
 * CircularParticipantQueue — the fixed-order cyclic ring the aggregator streams
 * participants through, one at a time.
 *
 * It owns three things the alternation needs and nothing else (the PCM itself
 * lives in the AggregatorBot's per-participant RingBuffers):
 *
 *  1. A stable jitsiId -> room-index-token mapping, ASSIGNED ONCE. The first
 *     time a participant's audio is seen we pin its jitsiId to the room index
 *     token the sidecar handed it (0 for the first human, 0a/0b/… for that
 *     human's bots, 1 for the next human, …) and never change it — even if the
 *     token were later re-announced. So a participant's media-stream source maps
 *     to exactly one slot for the whole meeting (requirement 2).
 *
 *  2. The order of the ring: JOIN ORDER. Room indices are themselves assigned in
 *     join order and are immutable for the meeting (see
 *     latency-instrument/room-indices.js), so appending each participant the
 *     first time it is seen — with a numeric-then-suffix tiebreak for any that
 *     first appear together — yields the default room-join ordering
 *     (requirement 3). New participants extend the tail; existing slots never
 *     shift, so a mid-meeting join can't renumber whose turn it is.
 *
 *  3. The circular WRITE POINTER. `serve()` maps the current time to a slot
 *     index and returns whose turn it is. The pointer advances one slot every
 *     `slotMs`; at any instant exactly one participant is active, so only that
 *     one participant's audio is streamed to the client and every other
 *     participant contributes nothing (requirement 1). `serve()` also reports
 *     when the pointer has "reached the same position again" (a full lap), the
 *     moment a slot's previously-held audio becomes stale — see `lapped` and how
 *     the AggregatorBot pairs it with the RingBuffer's oldest-sample eviction
 *     (requirement 4).
 *
 * Pure module, no page/DOM/WebAudio dependency — testable under node:test.
 */

// Order two participant tokens the way rooms number their participants:
// numeric index first (0, 1, 2, …), then the per-owner bot suffix (0, 0a, 0b).
// This is the deterministic tiebreak for participants first seen in the same
// ingest batch; across batches, first-seen (join) order already governs. Falls
// back to a plain string compare for anything that doesn't parse so the order
// is always total and stable.
export function tokenOrder(a, b) {
  const ma = /^(\d+)([a-z]*)$/.exec(String(a));
  const mb = /^(\d+)([a-z]*)$/.exec(String(b));
  if (ma && mb) {
    const na = Number(ma[1]), nb = Number(mb[1]);
    if (na !== nb) return na - nb;
    return ma[2] < mb[2] ? -1 : ma[2] > mb[2] ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export class CircularParticipantQueue {
  constructor({ now, slotMs = 4000 } = {}) {
    // Injected clock so the rotation is deterministic in tests without real time.
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.slotMs = Math.max(1, Number(slotMs) || 4000);

    // The ring itself: one entry per participant, in join order.
    this._slots = [];                  // [{ jitsiId, token }]
    this._indexByJitsiId = new Map();  // media-stream id -> ring index (assign-once)
    this._indexByToken = new Map();    // room-index token -> ring index (one slot/token)

    // Write-pointer bookkeeping.
    this._startMs = null;              // when the first turn began (lazy)
    this._lastSlot = -1;               // monotonic guard against a backward clock
    this._servedSlotAt = [];           // per-position: slot index it was last served
  }

  /** Participants currently in the ring. */
  get size() { return this._slots.length; }

  /** Room-index tokens in join order (the fixed rotation order). */
  order() { return this._slots.map((s) => s.token); }

  /** Pinned token for a media-stream id, or null if never registered. */
  tokenFor(jitsiId) {
    const i = this._indexByJitsiId.get(String(jitsiId));
    return i == null ? null : this._slots[i].token;
  }

  /** Media-stream id that first claimed a token, or null. */
  jitsiIdFor(token) {
    const i = this._indexByToken.get(String(token));
    return i == null ? null : this._slots[i].jitsiId;
  }

  hasJitsiId(jitsiId) { return this._indexByJitsiId.has(String(jitsiId)); }
  hasToken(token) { return this._indexByToken.has(String(token)); }

  /**
   * Pin `jitsiId -> token` the first time either is seen and append a ring slot
   * for it, returning the token to route this participant's audio by. Assign-once
   * on both keys:
   *   - a jitsiId already in the ring keeps its original token (a later, differing
   *     token for the same source is ignored — the mapping persists);
   *   - a token already held by an earlier slot is not duplicated: the jitsiId is
   *     bound to that existing slot (this is how a slot first seeded by token
   *     alone later resolves against the real media-stream id).
   * Either way the ring gains at most one slot per participant.
   */
  register(jitsiId, token) {
    const id = String(jitsiId);
    const tok = String(token);

    const known = this._indexByJitsiId.get(id);
    if (known != null) return this._slots[known].token; // already pinned

    const byToken = this._indexByToken.get(tok);
    if (byToken != null) {
      // Slot for this token already exists (e.g. seeded by token before the
      // real jitsiId was known). Bind this id to it without adding a duplicate.
      this._indexByJitsiId.set(id, byToken);
      const slot = this._slots[byToken];
      // Upgrade a token-placeholder identity to the real media-stream id so
      // jitsiIdFor() reports the source, not the token string.
      if (slot.jitsiId === tok && id !== tok) slot.jitsiId = id;
      return slot.token;
    }

    // Fresh participant: append at the tail (join order).
    const idx = this._slots.length;
    this._slots.push({ jitsiId: id, token: tok });
    this._indexByJitsiId.set(id, idx);
    this._indexByToken.set(tok, idx);
    this._servedSlotAt.push(null);
    return tok;
  }

  /**
   * Whose turn it is now. Maps the injected clock to a monotonic slot counter,
   * folds it onto the ring, and returns:
   *   - token:    the active participant's room-index token (null if the ring is
   *               empty), the ONLY participant whose audio should be streamed now;
   *   - position: the ring index the write pointer is on;
   *   - slot:     the monotonic turn counter (advances one per slotMs);
   *   - newTurn:  true only on the first serve() of a new slot (many playback
   *               ticks fall inside one slot);
   *   - lapped:   true when, on a new turn, the pointer has come back to this
   *               position after a full lap (>= size turns). That is the
   *               "write pointer reaches the same position again" event: the
   *               audio this slot held a lap ago is now stale.
   */
  serve() {
    const n = this._slots.length;
    if (!n) return { token: null, position: null, slot: -1, newTurn: false, lapped: false };

    const now = this.now();
    if (this._startMs == null) this._startMs = now;
    let slot = Math.floor((now - this._startMs) / this.slotMs);
    if (slot < this._lastSlot) slot = this._lastSlot; // clock ran backwards

    const position = ((slot % n) + n) % n;
    const token = this._slots[position].token;
    const newTurn = slot !== this._lastSlot;

    let lapped = false;
    if (newTurn) {
      const prev = this._servedSlotAt[position];
      if (prev != null && slot - prev >= n) lapped = true;
      this._servedSlotAt[position] = slot;
      this._lastSlot = slot;
    }
    return { token, position, slot, newTurn, lapped };
  }
}
