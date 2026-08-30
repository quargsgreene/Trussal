// Per-target ordered update queues for the MCP agent.
//
// Every AI-composed update is enqueued FIFO per target (a bot's cluster
// index like '1a', or 'metaprogram'); the delivery worker drains them in
// order, so "bots consume queued buffer updates in order" holds even when
// Claude fires several revisions quickly. Pure module — node:test drives it
// directly.

export class UpdateQueues {
  constructor({ maxPerTarget = 32 } = {}) {
    this.maxPerTarget = maxPerTarget;
    this._queues = new Map(); // target → [{ code, note, enqueuedAt, seq }]
    this._seq = 0;
  }

  enqueue(target, code, note = '') {
    if (!target || typeof code !== 'string') throw new TypeError('enqueue(target, code) required');
    let q = this._queues.get(target);
    if (!q) { q = []; this._queues.set(target, q); }
    const entry = { code, note, enqueuedAt: Date.now(), seq: this._seq++ };
    q.push(entry);
    while (q.length > this.maxPerTarget) q.shift();
    return { position: q.length, seq: entry.seq };
  }

  drain(target) {
    const q = this._queues.get(target);
    if (!q || q.length === 0) return null;
    const entry = q.shift();
    if (q.length === 0) this._queues.delete(target);
    return entry;
  }

  peekAll(target) {
    return (this._queues.get(target) || []).slice();
  }

  targets() {
    return [...this._queues.keys()];
  }

  depth(target) {
    return (this._queues.get(target) || []).length;
  }
}
