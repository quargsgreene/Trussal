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
 *     to one fixed token for the whole meeting — and thus to whichever ring
 *     slot(s) that token holds, since the metaprogram may list it more than once
 *     (requirement 2).
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
 *     This fixed-`slotMs` pointer is now the FALLBACK pace. In production the
 *     metaprogram's scheduler slot grid drives the rotation instead (see
 *     AggregatorBot #serveFromScheduler), so a turn lasts the network-derived
 *     cycle length rather than a constant. The pointer still paces before the
 *     first slot arrives, and in unit/standalone runs with no metaprogram sync
 *     — and the ORDER and MEMBERSHIP it rotates over are the metaprogram's
 *     either way (see applyMetaprogramOrder).
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
  // The ring itself: one entry per ring POSITION. A token normally holds a
  // single position, but the metaprogram may list a token more than once
  // (`$ participants <0 0 0a>`), so a token can own several positions and play
  // that many times per lap. The identity maps below are therefore one-to-many
  // (token -> positions), while each media-stream id still pins to exactly one
  // token.
  #slots = [];                  // [{ jitsiId, token, departed? }] — tokens may repeat
  #positionsByToken = new Map();// room-index token -> [ring indices], >=1 when present
  #tokenByJitsiId = new Map();  // media-stream id -> token (assign-once identity pin)
  // Write-pointer bookkeeping.
  #startMs = null;              // when the first turn began (lazy)
  #lastSlot = -1;               // monotonic guard against a backward clock
  #servedSlotAt = [];           // per-position: slot index it was last served
  // Metaprogram mode: when non-null, the ring is EXACTLY this token list (the
  // $ participants written order, repeats included) — see applyMetaprogramOrder.
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
    return this.#tokenByJitsiId.get(id) ?? this.#offRing.get(id) ?? null;
  }

  /** Media-stream id that first claimed a token, or null. */
  jitsiIdFor(token) {
    const positions = this.#positionsByToken.get(String(token));
    return positions && positions.length ? this.#slots[positions[0]].jitsiId : null;
  }

  hasJitsiId(jitsiId) { return this.#tokenByJitsiId.has(String(jitsiId)); }
  hasToken(token) { return this.#positionsByToken.has(String(token)); }

  /**
   * True if the queue already tracks this token ANYWHERE — a ring slot OR an
   * off-ring pin (a listed-but-unclaimed placeholder, or a present participant
   * waiting for the program to list them). Distinct from hasToken (ring only):
   * a caller seeding the ring from buffer tokens (#syncOrderFromBuffers) must
   * NOT re-register a token that is merely off-ring, because register() would
   * then park a second, pseudo-id (id===token) pin for it — which later shadows
   * the real media-stream id when the program lists the token, stranding the
   * live source off-ring so its leave can never ghost.
   */
  knowsToken(token) {
    const tok = String(token);
    if (this.#positionsByToken.has(tok)) return true;
    for (const t of this.#offRing.values()) if (t === tok) return true;
    return false;
  }

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

    if (this.#tokenByJitsiId.has(id)) return this.#tokenByJitsiId.get(id); // already pinned

    // Pinned while waiting OFF the ring (registered under a metaprogram that
    // doesn't list this token): the mapping persists, still no slot.
    if (this.#offRing.has(id)) return this.#offRing.get(id);

    const positions = this.#positionsByToken.get(tok);
    if (positions && positions.length) {
      // Slot(s) for this token already exist (seeded by token before the real
      // jitsiId was known, a metaprogram placeholder, or several positions when
      // the token is listed more than once). Bind this id to ALL of them —
      // every occurrence of the token plays the same participant — without
      // adding a duplicate. Upgrade each placeholder identity to the real
      // media-stream id so jitsiIdFor() reports the source, not the token. The
      // positions don't move, so update the pin in place rather than rebuilding.
      let upgradedPlaceholder = false;
      for (const p of positions) {
        if (this.#slots[p].jitsiId === tok && id !== tok) { this.#slots[p].jitsiId = id; upgradedPlaceholder = true; }
      }
      this.#tokenByJitsiId.set(id, tok);
      if (upgradedPlaceholder) this.#tokenByJitsiId.delete(tok); // drop the placeholder pseudo-id
      return tok;
    }

    // A metaprogram is in force and doesn't list this token (every listed
    // token already holds a slot, so the positions path above caught those):
    // the newcomer waits OFF the ring — identity pinned, its audio keeps
    // buffering bot-side, but SILENT until a program update lists the token
    // (applyMetaprogramOrder then folds the pin into a slot).
    if (this.#metaprogramOrder) {
      // Upgrade a token-placeholder pin to the real media-stream id.
      if (this.#offRing.get(tok) === tok && id !== tok) this.#offRing.delete(tok);
      this.#offRing.set(id, tok);
      return tok;
    }

    // Fresh participant (token not present): append one slot at the tail (join
    // order). Positions before it are unchanged, so update the maps in place.
    const idx = this.#slots.length;
    this.#slots.push({ jitsiId: id, token: tok });
    this.#servedSlotAt.push(null);
    this.#positionsByToken.set(tok, [idx]);
    this.#tokenByJitsiId.set(id, tok);
    return tok;
  }

  /**
   * Remove every slot the media-stream id's token holds (a repeated token owns
   * several), COMPACTING the ring so no empty gap is left where they were — a
   * departed participant never gets another (silent) turn.
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
    const id = String(jitsiId);
    const token = this.#tokenByJitsiId.get(id);
    if (token == null) return null;
    // A token may hold several positions (listed more than once). Splice from
    // the highest index down so earlier removals don't shift the ones still to
    // remove.
    const positions = (this.#positionsByToken.get(token) || []).slice().sort((a, b) => b - a);
    for (const p of positions) {
      this.#slots.splice(p, 1);
      this.#servedSlotAt.splice(p, 1);
    }
    // Positions after each removed slot shifted down — rebuild both maps.
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
      // An off-ring pin departs (removed immediately, buffer dropped). hadRingSlot
      // reports whether the same token ALSO holds a ring slot: true here is the
      // stranded-source desync (the schedule lists the token yet its live source
      // sat off-ring so the leave can't ghost) that knowsToken() now prevents.
      return { token, removed: true, reason: 'off-ring', hadRingSlot: this.#positionsByToken.has(token) };
    }
    const token = this.#tokenByJitsiId.get(id);
    if (token == null) return { token: null, removed: false, reason: 'unregistered', hadRingSlot: false };
    if (this.#metaprogramOrder) {
      // In metaprogram mode every ring token is listed (register() sends
      // unlisted ones off-ring), so the schedule still names this slot. Mark
      // every position the token holds (a repeat owns several) as a ghost.
      for (const p of (this.#positionsByToken.get(token) || [])) this.#slots[p].departed = true;
      return { token, removed: false, reason: 'ghost', hadRingSlot: true };
    }
    return { token: this.remove(id), removed: true, reason: 'join-order', hadRingSlot: false };
  }

  /**
   * Reverse a SPURIOUS departure: clear the departed (ghost) flag on every slot
   * a still-present participant's token holds, because fresh audio just proved
   * it never really left. depart() is driven by the page's leave detection,
   * which fires on a transient roster blip (getParticipants() is documented
   * "ICE-slow") or a play-state flicker as readily as a real leave; without this
   * the participant would loop its last-scheduled audio forever while its live
   * audio arrived unheard. A genuine leave delivers no more audio, so it is
   * never revived and stays a ghost until the program drops it. Returns true iff
   * a ghost flag was actually cleared.
   */
  revive(jitsiId) {
    const id = String(jitsiId);
    const token = this.#tokenByJitsiId.get(id);
    if (token == null) return false;
    let revived = false;
    for (const p of (this.#positionsByToken.get(token) || [])) {
      if (this.#slots[p].departed) { this.#slots[p].departed = false; revived = true; }
    }
    return revived;
  }

  // --- Metaprogram ordering ------------------------------------------------------
  //
  // When the room's JPattern metaprogram is in force, the $ participants
  // sequence dictates the ring's ORDER and MEMBERSHIP:
  //   - the rotation contains exactly the listed tokens, in written order (a
  //     listed token nobody has delivered audio for holds a placeholder slot —
  //     its turns are silent until register() binds the real stream to it);
  //   - an unlisted participant waits off the ring: pinned, buffering, silent
  //     until a program update lists its token;
  //   - a listed participant that leaves stays as a departed ghost, streaming
  //     its remaining held audio each turn, until the metaprogram is next
  //     re-applied: an update that still lists the token but saw no rejoin
  //     resets it to a silent placeholder, one that drops the token retires it,
  //     and a rejoiner who reclaims the slot un-ghosts it (revive) back to live.

  /**
   * Filter a raw metaprogram token list down to well-formed room-index tokens,
   * preserving written order AND multiplicity — a token listed N times yields N
   * entries (`<0 0 0a>` -> ['0','0','0a']), so it takes N ring positions and
   * plays N times per lap. Pure: no queue state is read or written.
   */
  captureMetaprogramTokens(rawTokens) {
    const out = [];
    for (const raw of Array.isArray(rawTokens) ? rawTokens : []) {
      const tok = String(raw);
      if (!/^\d+[a-z]*$/.test(tok)) continue;
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
   * `rawTokens` (filtered via captureMetaprogramTokens, repeats KEPT) in written
   * order — a token listed N times takes N ring positions and plays N times per
   * lap, all backed by the same participant. Existing slots carry their identity
   * and departed flag over to every occurrence; off-ring participants whose
   * token is now listed fold in; listed tokens nobody has claimed get
   * placeholder slots. Tokens the program no longer lists either move off-ring
   * (participant still present — their audio keeps buffering) or, when departed,
   * are RETIRED for good — the returned array of retired tokens (each once) is
   * the caller's cue to drop those buffers.
   *
   * `programUpdate` decides the fate of a departed ghost whose token IS still
   * listed — the leaver's grace period. A departed participant keeps its slot
   * and replays its last held audio for as long as the SAME program stays in
   * force, which is what the routine cycle-boundary re-adoption
   * (programUpdate=false, the default) preserves: the ghost's departed flag
   * carries over every occurrence so serve() keeps replaying it. The moment the
   * performer re-applies the metaprogram (programUpdate=true — an ▶ Apply /
   * Ctrl+Enter, roster seed, or catch-up), the grace ends: a still-listed ghost
   * that nobody has rejoined is RESET to a silent placeholder (departed flag
   * cleared, identity reset) and its token added to `retired` so the caller
   * drops the stale audio — the token is thereafter treated exactly like one
   * listed but never seen. (A ghost whose slot was reclaimed by a rejoiner is
   * already un-ghosted by revive() before this runs, so it carries over live.)
   *
   * An empty/invalid token list reverts to join-order mode: ghosts are
   * retired, off-ring participants fold back in (tokenOrder), survivors keep
   * their current arrangement.
   *
   * #servedSlotAt is reset either way, so `lapped` is approximate for the
   * next lap (observability only — same caveat as remove()).
   */
  applyMetaprogramOrder(rawTokens, { programUpdate = false } = {}) {
    const tokens = this.captureMetaprogramTokens(rawTokens);
    const retired = [];

    if (!tokens.length) {
      if (!this.#metaprogramOrder) return retired;
      this.#metaprogramOrder = null;
      // Revert to join-order mode, which holds ONE slot per token: collapse any
      // repeated token to a single survivor (first seen), retire departed
      // ghosts (once), then fold the off-ring waiters back in (tokenOrder).
      const seen = new Set();
      const survivors = [];
      for (const slot of this.#slots) {
        if (seen.has(slot.token)) continue;
        seen.add(slot.token);
        if (slot.departed) { retired.push(slot.token); continue; }
        survivors.push({ jitsiId: slot.jitsiId, token: slot.token });
      }
      const waiting = [...this.#offRing.entries()].sort((a, b) => tokenOrder(a[1], b[1]));
      for (const [id, tok] of waiting) survivors.push({ jitsiId: id, token: tok });
      this.#offRing.clear();
      this.#slots = survivors;
      this.#servedSlotAt = survivors.map(() => null);
      this.#rebuildIndexMaps();
      return retired;
    }

    this.#metaprogramOrder = tokens;
    // Identity (jitsiId + departed flag) per DISTINCT token, resolved ONCE so
    // every occurrence of a repeated token maps to the same participant. Read
    // from the current ring first (a token's slots share one identity, so the
    // first is enough), then the off-ring waiters, then a placeholder.
    const identityByToken = new Map();
    for (const slot of this.#slots) {
      if (!identityByToken.has(slot.token)) {
        identityByToken.set(slot.token, { jitsiId: slot.jitsiId, departed: !!slot.departed });
      }
    }
    const waitingIdByToken = new Map([...this.#offRing.entries()].map(([id, tok]) => [tok, id]));
    const listed = new Set(tokens);

    const next = [];
    for (const tok of tokens) {
      let identity = identityByToken.get(tok);
      if (!identity) {
        const waitingId = waitingIdByToken.get(tok);
        if (waitingId != null) {
          this.#offRing.delete(waitingId);
          identity = { jitsiId: waitingId, departed: false };
        } else {
          // Listed but never seen: a placeholder (silent turns) until audio
          // arrives and register() binds the real media-stream id to it.
          identity = { jitsiId: tok, departed: false };
        }
        identityByToken.set(tok, identity); // reuse for any further occurrences
      }
      // Genuine re-apply ends a still-listed ghost's grace period: nobody
      // rejoined (a reclaim would have cleared departed via revive() first), so
      // reset it to a silent placeholder and retire its stale audio — the token
      // is now treated exactly like one listed but never seen. Reset the shared
      // identity once so every further occurrence of a repeated token folds in
      // as the same placeholder (and the token is retired only once).
      if (programUpdate && identity.departed) {
        retired.push(tok);
        identity = { jitsiId: tok, departed: false };
        identityByToken.set(tok, identity);
      }
      const slot = { jitsiId: identity.jitsiId, token: tok };
      if (identity.departed) slot.departed = true;
      next.push(slot);
    }
    // Distinct current tokens the new program no longer lists (once each):
    // present participants wait off the ring (audio keeps buffering); departed
    // ghosts are retired for good.
    const handled = new Set();
    for (const slot of this.#slots) {
      if (listed.has(slot.token) || handled.has(slot.token)) continue;
      handled.add(slot.token);
      if (slot.departed) retired.push(slot.token);
      else this.#offRing.set(slot.jitsiId, slot.token);
    }
    this.#slots = next;
    this.#servedSlotAt = next.map(() => null);
    this.#rebuildIndexMaps();
    return retired;
  }

  // Rebuild both lookup maps from the slot array (positions changed: a
  // removal, a fresh append, or a metaprogram re-order). token -> positions is
  // one-to-many (a repeated token owns several); jitsiId -> token is the pin. A
  // placeholder alias (a slot seeded by token then bound to a real id)
  // collapses to just the real id.
  #rebuildIndexMaps() {
    this.#positionsByToken = new Map();
    this.#tokenByJitsiId = new Map();
    this.#slots.forEach((slot, i) => {
      let positions = this.#positionsByToken.get(slot.token);
      if (!positions) { positions = []; this.#positionsByToken.set(slot.token, positions); }
      positions.push(i);
      this.#tokenByJitsiId.set(slot.jitsiId, slot.token);
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
   *   - departed: true when this position is a ghost (metaprogram mode: the
   *               participant left but the program still lists the token). The
   *               caller replays the ghost's last held audio for the turn
   *               instead of streaming fresh audio.
   */
  serve() {
    const n = this.#slots.length;
    if (!n) return { token: null, position: null, slot: -1, newTurn: false, lapped: false, departed: false };

    const now = this.now();
    if (this.#startMs === null) this.#startMs = now;
    let slot = Math.floor((now - this.#startMs) / this.slotMs);
    if (slot < this.#lastSlot) slot = this.#lastSlot; // clock ran backwards

    const position = ((slot % n) + n) % n;
    const token = this.#slots[position].token;
    const departed = !!this.#slots[position].departed;
    const newTurn = slot !== this.#lastSlot;

    let lapped = false;
    if (newTurn) {
      const prev = this.#servedSlotAt[position];
      if (prev != null && slot - prev >= n) lapped = true;
      this.#servedSlotAt[position] = slot;
      this.#lastSlot = slot;
    }
    return { token, position, slot, newTurn, lapped, departed };
  }

  /**
   * Whether this token's ring slots are departed ghosts (metaprogram mode: the
   * participant left but the program still lists the token, so its turns replay
   * held audio rather than streaming fresh). serve() reports the same thing for
   * the position IT picked; this answers for a token chosen elsewhere — which
   * is what the scheduler-paced rotation needs, since there the metaprogram's
   * slot events pick the token, not the write pointer.
   *
   * A token's positions always share one identity (depart/applyMetaprogramOrder
   * set the flag across every occurrence), so `every` and `some` agree; `every`
   * is the conservative read — never replay a ghost unless it definitely left.
   */
  isDeparted(token) {
    const positions = this.#positionsByToken.get(String(token));
    if (!positions || !positions.length) return false;
    return positions.every((p) => !!this.#slots[p].departed);
  }

  /** First ring position the token holds, or null when it holds none. */
  positionOf(token) {
    const positions = this.#positionsByToken.get(String(token));
    return positions && positions.length ? positions[0] : null;
  }
}
