import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageAggregatorCapture } from '../src/bot/page-scripts.js';

/**
 * Runs the page-side aggregator capture tap outside a browser so its gate
 * logic is testable under node:test: a fake `window`/`APP.conference._room`,
 * an AudioContext stand-in that hands each participant's ScriptProcessor back
 * to the test (so PCM frames are pushed by hand), and the tap's 1s roster
 * scan captured from setInterval so tests advance it explicitly.
 *
 * The scenarios mirror the leave sequences observed live (2026-07-13):
 * which of the three drain() gates — roster membership, playing flag,
 * resolver — is still open at each instant is exactly what these tests pin.
 */
function installTap() {
  const procsByJitsiId = new Map(); // jitsiId -> that peer's ScriptProcessor stand-in

  // Every fake node tracks its own disconnect so teardown is observable.
  const fakeNode = (extra = {}) => ({ connect() {}, disconnected: false, disconnect() { this.disconnected = true; }, ...extra });

  // Models the REAL page's pageAudioBridge, which wraps window.AudioContext so
  // EVERY `new AudioContext()` call anywhere on the page — including inside
  // tapTrack — returns the SAME shared singleton (also used for the mic
  // stream and pageMasterPlayer's output). This is deliberately NOT one fake
  // context per participant: a live regression closed this shared instance on
  // one participant's departure and silenced the entire page, which a
  // per-participant fake context could never have caught.
  let sharedCtx = null;
  class RealFakeAudioContext {
    constructor() { this.closed = false; }
    createMediaStreamSource(stream) {
      this._ownerId = stream.ownerId;
      return fakeNode();
    }
    createScriptProcessor() {
      const proc = fakeNode({ onaudioprocess: null });
      procsByJitsiId.set(this._ownerId, proc);
      return proc;
    }
    createGain() {
      return fakeNode({ gain: { value: 1 } });
    }
    get destination() { return {}; }
    close() { this.closed = true; return Promise.resolve(); }
  }
  function FakeAudioContext(...args) {
    if (!sharedCtx) sharedCtx = new RealFakeAudioContext(...args);
    return sharedCtx;
  }
  FakeAudioContext.prototype = RealFakeAudioContext.prototype;

  // Stable participant objects: tapTrack guards re-tapping with a WeakSet on
  // the track, so each participant keeps the same track object across scans
  // — including across a removeFromRoster/addToRoster pair, which models a
  // transient room.getParticipants() glitch (the underlying JitsiTrack is
  // unchanged) rather than an actual leave-and-rejoin (a fresh track object).
  const roster = [];
  const participantsById = new Map();
  const makeParticipant = (jitsiId) => {
    const track = {
      getType: () => 'audio',
      getOriginalStream: () => ({ ownerId: jitsiId, getAudioTracks: () => [{}] }),
      getTrack: () => null,
    };
    return { getId: () => jitsiId, getTracks: () => [track] };
  };
  const getOrMakeParticipant = (jitsiId) => {
    let p = participantsById.get(jitsiId);
    if (!p) { p = makeParticipant(jitsiId); participantsById.set(jitsiId, p); }
    return p;
  };

  const resolverMap = new Map(); // jitsiId -> room-index token (sidecar view)
  const playingSet = new Set();  // jitsiIds the peer-state bus reports playing

  globalThis.APP = { conference: { _room: { getParticipants: () => roster.slice() } } };
  globalThis.window = {
    AudioContext: FakeAudioContext,
    __trussalRoomIndexForJitsiId: (jitsiId) => resolverMap.get(jitsiId) ?? null,
    __trussalPeerIsPlaying: (jitsiId) => playingSet.has(jitsiId),
  };

  // Capture the scan the tap schedules so tests drive roster ticks by hand.
  let scan = null;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { scan = fn; return 0; };
  try {
    pageAggregatorCapture();
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  return {
    cap: globalThis.window.__trussalAggCapture,
    scan: () => scan(),
    addToRoster: (jitsiId) => { roster.push(getOrMakeParticipant(jitsiId)); },
    removeFromRoster: (jitsiId) => {
      const i = roster.findIndex((p) => p.getId() === jitsiId);
      if (i >= 0) roster.splice(i, 1);
    },
    resolverMap,
    playingSet,
    procs: procsByJitsiId,
    // The one shared AudioContext every participant's tap actually uses.
    sharedCtx: () => sharedCtx,
    // One ScriptProcessor frame from this peer's tap (2048 samples, like the
    // real FRAME size). Works after the participant has been scanned once.
    pushFrame: (jitsiId, sample = 0.1) => {
      const proc = procsByJitsiId.get(jitsiId);
      assert.ok(proc && proc.onaudioprocess, `tap exists for ${jitsiId}`);
      proc.onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(2048).fill(sample) },
      });
    },
  };
}

// The live incident, step for step: on an in-app hangup the Jitsi presence
// leave lands BEFORE the sidecar peer-leave, so right after the roster
// backstop queues the departure, the departed peer still reads as playing +
// resolved — and its tap can still emit one final tail frame (teardownTap is
// deliberately NOT synchronous with the backstop — see the glitch-tolerance
// test below for why). drain()'s roster gate (lastSeen) is what discards it;
// the tap itself is only torn down later, once the absence has been
// confirmed over several scans.
test('hangup race: a departed peer\'s post-leave capture tail is discarded, not delivered', () => {
  const tap = installTap();
  tap.addToRoster('human-a');
  tap.resolverMap.set('human-a', '0');
  tap.playingSet.add('human-a');
  tap.addToRoster('human-b');
  tap.resolverMap.set('human-b', '3');
  tap.playingSet.add('human-b');
  tap.scan();

  tap.pushFrame('human-a');
  tap.pushFrame('human-b');
  assert.deepEqual(
    tap.cap.drain().map((t) => t.token).sort(),
    ['0', '3'],
    'both peers deliver while present and playing',
  );

  // The hangup: B drops out of the Jitsi roster and the next scan queues the
  // departure — while the sidecar peer-leave is still in flight, so B still
  // reads as playing and resolved (the gate lag at the heart of the race).
  tap.removeFromRoster('human-b');
  tap.scan();
  assert.deepEqual(tap.cap.drainLeaves(), ['human-b'], 'roster backstop queues the departure');

  // B's ScriptProcessor outlives the WebRTC track for a bit (teardown is
  // grace-windowed, not immediate) and emits one last frame.
  tap.pushFrame('human-b');
  tap.pushFrame('human-a');
  assert.deepEqual(
    tap.cap.drain().map((t) => t.jitsiId),
    ['human-a'],
    'the departed peer\'s tail is discarded — delivered, it would re-register the compacted ring slot',
  );
});

// The opposite leave ordering (tab close): the peer-state WS closes
// instantly, so playing + resolver shut first while Jitsi's roster stays
// stale for many seconds (ICE timeout). The roster gate passes the tail —
// the peer is still listed — and the playing gate discards it instead.
test('tab close: the playing gate discards the tail while the Jitsi roster is still stale', () => {
  const tap = installTap();
  tap.addToRoster('human-a');
  tap.resolverMap.set('human-a', '0');
  tap.playingSet.add('human-a');
  tap.addToRoster('human-b');
  tap.resolverMap.set('human-b', '3');
  tap.playingSet.add('human-b');
  tap.scan();
  tap.pushFrame('human-b');
  tap.cap.drain();

  tap.playingSet.delete('human-b');
  tap.resolverMap.delete('human-b');
  tap.scan(); // resolver fast path queues the departure
  assert.deepEqual(tap.cap.drainLeaves(), ['human-b'], 'resolver fast path queues the departure');

  tap.pushFrame('human-b');
  assert.deepEqual(tap.cap.drain(), [], 'tail discarded even though the peer is still in the stale roster');
});

// The documented stop -> play rejoin must survive the roster gate: a peer who
// stays in the meeting keeps its roster membership, so the moment the playing
// flag reopens its captures deliver again.
//
// A stop must NOT be reported via drainLeaves() — that queue feeds
// AggregatorBot.removeParticipant, which ghosts a still-listed token under an
// active Net Cycles metaprogram (the production default) instead of letting
// it go quietly silent, defeating an intentional Stop. It goes through the
// separate drainStopped() queue instead (see page-scripts.js's module doc and
// markStopped/markDeparted split).
test('a present peer that stops and resumes playing delivers again (no roster-gate false positive)', () => {
  const tap = installTap();
  tap.addToRoster('human-a');
  tap.resolverMap.set('human-a', '0');
  tap.playingSet.add('human-a');
  tap.scan();
  tap.pushFrame('human-a');
  assert.equal(tap.cap.drain().length, 1, 'delivers while playing');

  // Stops playing but stays in the meeting: the play-state fast path frees
  // the slot via drainStopped (NOT drainLeaves), and the (silent) captures
  // deliver nothing…
  tap.playingSet.delete('human-a');
  tap.scan();
  assert.deepEqual(tap.cap.drainLeaves(), [], 'a stop is not a departure — leftQueue stays empty');
  assert.deepEqual(tap.cap.drainStopped(), ['human-a'], 'stop is queued separately from a departure');
  tap.pushFrame('human-a', 0);
  assert.deepEqual(tap.cap.drain(), [], 'a stopped peer delivers nothing');

  // …until play resumes: still in the roster, so only the playing flag was
  // holding delivery back.
  tap.playingSet.add('human-a');
  tap.scan();
  tap.pushFrame('human-a');
  const takes = tap.cap.drain();
  assert.equal(takes.length, 1, 'delivers again after play resumes');
  assert.equal(takes[0].jitsiId, 'human-a');
});

// The resource leak: markDeparted used to only clear the store/bookkeeping
// Sets, leaving the departed peer's ScriptProcessor+GainNode+source CONNECTED
// — which per spec keeps them alive and running (silently refilling `store`
// under the departed id) for the rest of the page's life. A departure must
// eventually tear the tap down: stop delivering frames and disconnect the
// per-participant graph. Teardown is grace-windowed (TAP_TEARDOWN_GRACE_SCANS
// consecutive misses), not immediate — see the glitch-tolerance test below
// for why — so this drives scan() past the window to observe it.
test('sustained absence eventually tears down the peer\'s ScriptProcessor (no leaked tap)', () => {
  const tap = installTap();
  tap.addToRoster('human-a');
  tap.resolverMap.set('human-a', '0');
  tap.playingSet.add('human-a');
  tap.scan();
  tap.pushFrame('human-a');
  assert.equal(tap.cap.drain().length, 1, 'tap is live while present');

  const proc = tap.procs.get('human-a');
  assert.ok(proc, 'tap resources exist before departure');

  tap.removeFromRoster('human-a');
  tap.scan(); // roster backstop fires markDeparted immediately (bookkeeping only)
  assert.deepEqual(tap.cap.drainLeaves(), ['human-a']);
  assert.notEqual(proc.onaudioprocess, null, 'tap is NOT torn down on the first miss');

  tap.scan(); // still within the grace window
  assert.notEqual(proc.onaudioprocess, null, 'tap still survives a second consecutive miss');

  tap.scan(); // grace window elapses on this, the third consecutive miss
  assert.equal(proc.onaudioprocess, null, 'processor stops delivering frames once sustained absence is confirmed');
  assert.equal(proc.disconnected, true, 'processor is disconnected on departure');
});

// The regression this session found LIVE: a single glitchy
// room.getParticipants() read (e.g. Jitsi's roster momentarily not listing
// everyone during a burst of joins — several bots joining at once) must NOT
// permanently kill a still-present peer's tap. teardownTap is irreversible
// (tapTrack's WeakSet guard means an unchanged JitsiTrack is never re-tapped),
// so a one-tick false departure reading would otherwise silence that peer for
// the rest of the meeting. The peer reappearing before the grace window
// elapses must reset the miss streak and leave the tap untouched.
test('a still-present peer survives a transient roster glitch (tap not torn down)', () => {
  const tap = installTap();
  tap.addToRoster('human-a');
  tap.resolverMap.set('human-a', '0');
  tap.playingSet.add('human-a');
  tap.scan();

  const proc = tap.procs.get('human-a');

  // Simulates a burst of joins causing Jitsi's roster to momentarily omit a
  // still-present peer: absent for one scan, then reappears.
  tap.removeFromRoster('human-a');
  tap.scan();
  assert.notEqual(proc.onaudioprocess, null, 'tap survives the glitch tick');

  tap.addToRoster('human-a');
  tap.scan();
  assert.notEqual(proc.onaudioprocess, null, 'tap is untouched once the peer reappears');

  // Confirms the miss streak actually reset, not just paused: several more
  // ticks of continuous presence must not accumulate toward teardown.
  tap.scan();
  tap.scan();
  tap.scan();
  assert.notEqual(proc.onaudioprocess, null, 'still delivering after the peer has been present all along');

  tap.pushFrame('human-a');
  assert.equal(tap.cap.drain().length, 1, 'audio still flows normally after the glitch');
});

// The live bug this session actually hit: pageAudioBridge wraps
// window.AudioContext into a page-wide SINGLETON (mic stream,
// pageMasterPlayer's output, and every participant's tap all share the same
// instance). Closing it for one departed peer silences the ENTIRE page, not
// just that peer — this is why teardownTap must never call ctx.close(), only
// disconnect the departed peer's OWN nodes.
test('tearing down a departed peer\'s tap never closes the shared AudioContext, and other peers keep delivering', () => {
  const tap = installTap();
  tap.addToRoster('human-a');
  tap.resolverMap.set('human-a', '0');
  tap.playingSet.add('human-a');
  tap.addToRoster('human-b');
  tap.resolverMap.set('human-b', '3');
  tap.playingSet.add('human-b');
  tap.scan();
  assert.ok(tap.sharedCtx(), 'both taps were built against the shared context');

  tap.removeFromRoster('human-b');
  tap.scan();
  tap.scan();
  tap.scan(); // grace window elapses -> human-b's tap is torn down
  assert.equal(tap.procs.get('human-b').onaudioprocess, null, 'the departed peer\'s tap is torn down');

  assert.equal(tap.sharedCtx().closed, false, 'the shared AudioContext used by the whole page is NEVER closed');
  tap.pushFrame('human-a');
  assert.deepEqual(
    tap.cap.drain().map((t) => t.jitsiId),
    ['human-a'],
    'a still-present peer keeps delivering after another peer\'s departure is torn down',
  );
});
