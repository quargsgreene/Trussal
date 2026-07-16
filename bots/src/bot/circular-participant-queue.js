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
 *  2. The order of the ring. JOIN ORDER by default: room indices are themselves
 *     assigned in join order and are immutable for the meeting (see
 *     latency-instrument/room-indices.js), so appending each participant the
 *     first time it is seen — with a numeric-then-suffix tiebreak for any that
 *     first appear together — yields the default room-join ordering
 *     (requirement 3). New participants extend the tail; existing slots never
 *     shift, so a mid-meeting join can't renumber whose turn it is. A leave
 *     removes and compacts the slot (see remove); a rejoin re-appends at the
 *     tail, so leaving is the only operation that renumbers, and only to close
 *     the gap. When the room's metaprogram is in force the ring instead
 *     follows the $ participants sequence — written order AND membership; see
 *     applyMetaprogramOrder for the join/leave rules in that mode.
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
  // The ring itself: one entry per participant, in join order.
  #slots = [];                  // [{ jitsiId, token }]
  #indexByJitsiId = new Map();  // media-stream id -> ring index (assign-once)
  #indexByToken = new Map();    // room-index token -> ring index (one slot/token)
  // Write-pointer bookkeeping.
  #startMs = null;              // when the first turn began (lazy)
  #lastSlot = -1;               // monotonic guard against a backward clock
  #servedSlotAt = [];           // per-position: slot index it was last served
  // Metaprogram mode: when non-null, the ring is EXACTLY this token list (the
  // $ participants written order) — see applyMetaprogramOrder.
  #metaprogramOrder = null;
  // Participants registered while the metaprogram doesn't list their token:
  // jitsiId -> token, identity pinned but SILENT (no ring slot) until a
  // program update lists the token.
  #offRing = new Map();

  constructor({ now, slotMs = 4000 } = {}) {
    // Injected clock so the rotation is deterministic in tests without real time.
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.slotMs = Math.max(1, Number(slotMs) || 4000);
  }

  /** Participants currently in the ring. */
  get size() { return this.#slots.length; }

  /** Room-index tokens in join order (the fixed rotation order). */
  order() { return this.#slots.map((s) => s.token); }

  /** Pinned token for a media-stream id (in the ring OR waiting off it), or null. */
  tokenFor(jitsiId) {
    const id = String(jitsiId);
    const i = this.#indexByJitsiId.get(id);
    if (i != null) return this.#slots[i].token;
    return this.#offRing.get(id) ?? null;
  }

  /** Media-stream id that first claimed a token, or null. */
  jitsiIdFor(token) {
    const i = this.#indexByToken.get(String(token));
    return i == null ? null : this.#slots[i].jitsiId;
  }

  hasJitsiId(jitsiId) { return this.#indexByJitsiId.has(String(jitsiId)); }
  hasToken(token) { return this.#indexByToken.has(String(token)); }

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

    const known = this.#indexByJitsiId.get(id);
    if (known != null) return this.#slots[known].token; // already pinned

    // Pinned while waiting OFF the ring (registered under a metaprogram that
    // doesn't list this token): the mapping persists, still no slot.
    if (this.#offRing.has(id)) return this.#offRing.get(id);

    const byToken = this.#indexByToken.get(tok);
    if (byToken != null) {
      // Slot for this token already exists (e.g. seeded by token before the
      // real jitsiId was known, or a metaprogram placeholder). Bind this id to
      // it without adding a duplicate.
      this.#indexByJitsiId.set(id, byToken);
      const slot = this.#slots[byToken];
      // Upgrade a token-placeholder identity to the real media-stream id so
      // jitsiIdFor() reports the source, not the token string.
      if (slot.jitsiId === tok && id !== tok) slot.jitsiId = id;
      return slot.token;
    }

    // A metaprogram is in force and doesn't list this token (every listed
    // token already holds a slot, so the byToken path above caught those):
    // the newcomer waits OFF the ring — identity pinned, its audio keeps
    // buffering bot-side, but SILENT until a program update lists the token
    // (applyMetaprogramOrder then folds the pin into a slot).
    if (this.#metaprogramOrder) {
      // Upgrade a token-placeholder pin to the real media-stream id.
      if (this.#offRing.get(tok) === tok && id !== tok) this.#offRing.delete(tok);
      this.#offRing.set(id, tok);
      return tok;
    }

    // Fresh participant: append at the tail (join order).
    const idx = this.#slots.length;
    this.#slots.push({ jitsiId: id, token: tok });
    this.#indexByJitsiId.set(id, idx);
    this.#indexByToken.set(tok, idx);
    this.#servedSlotAt.push(null);
    return tok;
  }

  /**
   * Remove the slot for a media-stream id, COMPACTING the ring so no empty gap is
   * left where it was — a departed participant never gets another (silent) turn.
   * Returns the removed token, or null if the id was never registered.
   *
   * The write pointer keeps its monotonic slot counter and simply folds onto the
   * now-smaller ring (serve()'s `slot % size`), so the rotation continues from the
   * current turn over the remaining participants. Removal is the ONLY operation
   * that renumbers positions, and only to close the gap; a rejoin re-register()s at
   * the tail, preserving the "existing slots never shift" invariant. The removed
   * token is NOT recycled here — a returning participant is handed the same
   * immutable room index by the sidecar and re-registers under it; a genuinely new
   * participant gets the next index, never the departed one's.
   *
   * `#servedSlotAt` is spliced alongside `#slots` to stay index-aligned; its lap
   * history is then approximate for one lap (lapped is observability only). Note
   * the index maps are rebuilt from the compacted slots, so a placeholder alias (a
   * slot seeded by token then bound to a real id) collapses to just the real id.
   */
  remove(jitsiId) {
    const idOfParticipantToRemove = String(jitsiId);
    const indexOfParticipantToRemove = this.#indexByJitsiId.get(idOfParticipantToRemove);
    if (indexOfParticipantToRemove == null) return null;
    const { token } = this.#slots[indexOfParticipantToRemove];
    this.#slots.splice(indexOfParticipantToRemove, 1);
    this.#servedSlotAt.splice(indexOfParticipantToRemove, 1);
    // Every slot after the removed one shifted down by one — rebuild both maps.
    this.#rebuildIndexMaps();
    return token;
  }

  /**
   * A participant left the conference — the mode-aware exit, which the
   * aggregator calls instead of remove():
   *   - join-order mode (or an off-ring pin): remove immediately, exactly like
   *     remove() — `removed: true`, the caller drops the buffer too;
   *   - metaprogram mode: the slot is KEPT and marked departed. The program
   *     still lists this token, so its turns keep streaming whatever its most
   *     recent queued buffer holds; only a program update that drops the token
   *     retires the ghost (see applyMetaprogramOrder) — `removed: false`, the
   *     caller keeps the buffer.
   * Returns { token, removed }; token is null when the id was never seen.
   */
  depart(jitsiId) {
    const id = String(jitsiId);
    if (this.#offRing.has(id)) {
      const token = this.#offRing.get(id);
      this.#offRing.delete(id);
      return { token, removed: true };
    }
    const i = this.#indexByJitsiId.get(id);
    if (i == null) return { token: null, removed: false };
    if (this.#metaprogramOrder) {
      // In metaprogram mode every ring token is listed (register() sends
      // unlisted ones off-ring), so the schedule still names this slot.
      this.#slots[i].departed = true;
      return { token: this.#slots[i].token, removed: false };
    }
    return { token: this.remove(id), removed: true };
  }

  // --- Metaprogram ordering ------------------------------------------------------
  //
  // When the room's Net Cycles metaprogram is in force, the $ participants
  // sequence dictates the ring's ORDER and MEMBERSHIP:
  //   - the rotation contains exactly the listed tokens, in written order (a
  //     listed token nobody has delivered audio for holds a placeholder slot —
  //     its turns are silent until register() binds the real stream to it);
  //   - an unlisted participant waits off the ring: pinned, buffering, silent
  //     until a program update lists its token;
  //   - a listed participant that leaves stays as a departed ghost, streaming
  //     its remaining held audio each turn, until the program drops it.

  /**
   * Filter a raw metaprogram token list down to well-formed room-index tokens,
   * deduplicated keeping first appearance — the sequence's written order.
   * Pure: no queue state is read or written.
   */
  captureMetaprogramTokens(rawTokens) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(rawTokens) ? rawTokens : []) {
      const tok = String(raw);
      if (!/^\d+[a-z]*$/.test(tok) || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
    return out;
  }

  /** Whether a metaprogram ordering is currently in force on the ring. */
  hasValidMetaprogram() { return this.#metaprogramOrder != null; }

  /** Tokens pinned off the ring (registered while unlisted), waiting to be added. */
  waitingTokens() { return [...this.#offRing.values()]; }

  /**
   * Adopt the metaprogram's participant list: the ring becomes exactly
   * `rawTokens` (filtered/deduped via captureMetaprogramTokens) in written
   * order. Existing slots carry over with their identity and departed flag;
   * off-ring participants whose token is now listed fold in; listed tokens
   * nobody has claimed get placeholder slots. Slots the program no longer
   * lists either move off-ring (participant still present — their audio keeps
   * buffering) or, when departed, are RETIRED for good — the returned array
   * of retired tokens is the caller's cue to drop those buffers.
   *
   * An empty/invalid token list reverts to join-order mode: ghosts are
   * retired, off-ring participants fold back in (tokenOrder), survivors keep
   * their current arrangement.
   *
   * #servedSlotAt is reset either way, so `lapped` is approximate for the
   * next lap (observability only — same caveat as remove()).
   */
  applyMetaprogramOrder(rawTokens) {
    const tokens = this.captureMetaprogramTokens(rawTokens);
    const retired = [];

    if (!tokens.length) {
      if (!this.#metaprogramOrder) return retired;
      this.#metaprogramOrder = null;
      for (let i = this.#slots.length - 1; i >= 0; i--) {
        if (this.#slots[i].departed) {
          retired.push(this.#slots[i].token);
          this.#slots.splice(i, 1);
          this.#servedSlotAt.splice(i, 1);
        }
      }
      const waiting = [...this.#offRing.entries()].sort((a, b) => tokenOrder(a[1], b[1]));
      for (const [id, tok] of waiting) {
        this.#slots.push({ jitsiId: id, token: tok });
        this.#servedSlotAt.push(null);
      }
      this.#offRing.clear();
      this.#rebuildIndexMaps();
      return retired;
    }

    this.#metaprogramOrder = tokens;
    const slotByToken = new Map(this.#slots.map((s) => [s.token, s]));
    const waitingIdByToken = new Map([...this.#offRing.entries()].map(([id, tok]) => [tok, id]));
    const next = [];
    for (const tok of tokens) {
      const existing = slotByToken.get(tok);
      if (existing) { next.push(existing); slotByToken.delete(tok); continue; }
      const waitingId = waitingIdByToken.get(tok);
      if (waitingId != null) {
        this.#offRing.delete(waitingId);
        next.push({ jitsiId: waitingId, token: tok });
        continue;
      }
      // Listed but never seen: placeholder slot (silent turns) until audio
      // arrives and register() binds the real media-stream id to it.
      next.push({ jitsiId: tok, token: tok });
    }
    // Slots the program no longer lists: present participants wait off the
    // ring (their audio keeps buffering); departed ghosts are retired for good.
    for (const leftover of slotByToken.values()) {
      if (leftover.departed) retired.push(leftover.token);
      else this.#offRing.set(leftover.jitsiId, leftover.token);
    }
    this.#slots = next;
    this.#servedSlotAt = next.map(() => null);
    this.#rebuildIndexMaps();
    return retired;
  }

  // Rebuild both lookup maps from the slot array (positions changed: a
  // removal, or a metaprogram re-order). A placeholder alias (a slot seeded
  // by token then bound to a real id) collapses to just the real id.
  #rebuildIndexMaps() {
    this.#indexByJitsiId.clear();
    this.#indexByToken.clear();
    this.#slots.forEach((slot, i) => {
      this.#indexByJitsiId.set(slot.jitsiId, i);
      this.#indexByToken.set(slot.token, i);
    });
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
    const n = this.#slots.length;
    console.log('CircularParticipantQueue.serve() n=%d', n);
    if (!n) return { token: null, position: null, slot: -1, newTurn: false, lapped: false };

    const now = this.now();
    if (this.#startMs === null) this.#startMs = now;
    let slot = Math.floor((now - this.#startMs) / this.slotMs);
    if (slot < this.#lastSlot) slot = this.#lastSlot; // clock ran backwards

    const position = ((slot % n) + n) % n;
    const token = this.#slots[position].token;
    const newTurn = slot !== this.#lastSlot;

    let lapped = false;
    if (newTurn) {
      const prev = this.#servedSlotAt[position];
      if (prev != null && slot - prev >= n) lapped = true;
      this.#servedSlotAt[position] = slot;
      this.#lastSlot = slot;
    }
    console.log({ token, position, slot, newTurn, lapped });
    return { token, position, slot, newTurn, lapped };
  }
}
