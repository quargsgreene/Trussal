// O2-style clock synchronization.
//
// Maps a local clock (in the browser: audioCtx.currentTime) onto the O2
// relay's reference clock. Like O2: bursts of /_cs/get round-trips, the
// burst's minimum-RTT reply wins (least queueing noise), and
// offset = serverTime + rtt/2 − localReceiveTime, so
// networkTime = localTime + offset. Re-syncs on a cadence; between bursts a
// drift estimate (offset delta per local second across recent bursts)
// extrapolates the mapping.
//
// Dependency-injected (send fn + local clock + timers) so node:test drives
// it deterministically; makeBrowserClockSync wires the real O2LiteClient.

export const DEFAULT_BURST = 5; // ?
export const DEFAULT_BURST_SPACING_MS = 100;
export const DEFAULT_RESYNC_INTERVAL_MS = 10000;

export class ClockSync {
  constructor({
    sendCsGet,               // (seqno, clientTime) → void
    now,                     // () → local seconds
    burst = DEFAULT_BURST,
    burstSpacingMs = DEFAULT_BURST_SPACING_MS,
    resyncIntervalMs = DEFAULT_RESYNC_INTERVAL_MS,
    // Wrap the globals rather than storing bare references: in browsers
    // setTimeout/clearTimeout are Window methods that throw "Illegal invocation"
    // unless called with the global as their receiver, and here they'd be
    // invoked as this._setTimeout(...) with the ClockSync instance as receiver.
    // (node's timers don't check the receiver, so node:test never hit this.)
    setTimeoutFn = (typeof setTimeout !== 'undefined' ? (fn, ms) => setTimeout(fn, ms) : null),
    clearTimeoutFn = (typeof clearTimeout !== 'undefined' ? (id) => clearTimeout(id) : null)
  }) {
    if (typeof sendCsGet !== 'function' || typeof now !== 'function') {
      throw new TypeError('ClockSync needs sendCsGet and now functions');
    }
    this._send = sendCsGet;
    this._now = now;
    this._burst = burst;
    this._burstSpacingMs = burstSpacingMs;
    this._resyncIntervalMs = resyncIntervalMs;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;

    this._seq = 0;
    this._burstBest = null;      // { rtt, offset } best reply of the burst in flight
    this._burstRemaining = 0;
    this._offset = null;         // networkTime − localTime, seconds
    this._drift = 0;             // d(offset)/d(localTime)
    this._history = [];          // [{ localT, offset }] recent burst results
    this._rounds = 0;
    this._lastRtt = null;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._beginBurst();
  }

  stop() {
    this._running = false;
    if (this._timer && this._clearTimeout) this._clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule(fn, ms) {
    if (!this._setTimeout) return;
    this._timer = this._setTimeout(fn, ms);
  }

  _beginBurst() {
    this._burstBest = null;
    this._burstRemaining = this._burst;
    this._fireOne();
  }

  _fireOne() {
    if (!this._running) return;
    this._send(this._seq++, this._now());
    this._burstRemaining--;
    if (this._burstRemaining > 0) {
      this._schedule(() => this._fireOne(), this._burstSpacingMs);
    } else {
      // Leave one spacing for the last reply to land, then commit the burst.
      this._schedule(() => this._commitBurst(), this._burstSpacingMs * 2);
    }
  }

  // Feed every /_cs/rply here (wire onCsReply to this).
  handleReply(seqno, clientSentTime, serverTime) {
    const localT = this._now();
    const rtt = localT - clientSentTime;
    if (!(rtt >= 0) || !isFinite(rtt)) return;
    const offset = serverTime + rtt / 2 - localT;
    if (!this._burstBest || rtt < this._burstBest.rtt) {
      this._burstBest = { rtt, offset, localT };
    }
    this._lastRtt = rtt;
  }

  _commitBurst() {
    if (this._burstBest) {
      const { offset, localT } = this._burstBest;
      this._offset = offset;
      this._rounds++;
      this._history.push({ localT, offset });
      if (this._history.length > 8) this._history.shift();
      if (this._history.length >= 2) {
        const first = this._history[0];
        const last = this._history[this._history.length - 1];
        const dt = last.localT - first.localT;
        this._drift = dt > 1 ? (last.offset - first.offset) / dt : 0;
      }
      this._anchorLocalT = localT;
    }
    if (this._running) {
      this._schedule(() => this._beginBurst(), this._resyncIntervalMs);
    }
  }

  isSynced() { return this._offset != null; }

  // localTime (audio clock) → network reference time.
  toNetworkTime(localT) {
    if (this._offset == null) return null;
    const dt = this._anchorLocalT != null ? localT - this._anchorLocalT : 0;
    return localT + this._offset + this._drift * dt;
  }

  // network reference time → localTime (audio clock).
  toAudioTime(networkT) {
    if (this._offset == null) return null;
    // Invert the (mildly) drift-corrected mapping; drift is ppm-scale, one
    // Newton step is exact to numerical precision.
    let localT = networkT - this._offset;
    const err = this.toNetworkTime(localT) - networkT;
    return localT - err / (1 + this._drift);
  }

  stats() {
    return { offset: this._offset, drift: this._drift, rounds: this._rounds, lastRtt: this._lastRtt };
  }
}

// Browser wiring: one ClockSync per room over the /o2 relay path, clocked by
// the shared AudioContext.
// clarify how this data gets passed to 02lite
export function makeClockSyncOverO2(client, getLocalSeconds) {
  const sync = new ClockSync({
    sendCsGet: (seq, t) => client.sendCsGet(seq, t),
    now: getLocalSeconds
  });
  client.onCsReply((seq, clientT, serverT) => sync.handleReply(seq, clientT, serverT));
  return sync;
}
