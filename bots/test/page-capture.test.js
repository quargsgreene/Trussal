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

  // tapTrack creates one AudioContext per tap and calls
  // createMediaStreamSource(stream) before createScriptProcessor(), so the
  // stream's owner id (stamped on the fake stream below) identifies which
  // participant the processor belongs to.
  class FakeAudioContext {
    createMediaStreamSource(stream) {
      this._ownerId = stream.ownerId;
      return { connect() {} };
    }
    createScriptProcessor() {
      const proc = { onaudioprocess: null, connect() {} };
      procsByJitsiId.set(this._ownerId, proc);
      return proc;
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    get destination() { return {}; }
  }

  // Stable participant objects: tapTrack guards re-tapping with a WeakSet on
  // the track, so each participant keeps the same track object across scans.
  const roster = [];
  const makeParticipant = (jitsiId) => {
    const track = {
      getType: () => 'audio',
      getOriginalStream: () => ({ ownerId: jitsiId, getAudioTracks: () => [{}] }),
      getTrack: () => null,
    };
    return { getId: () => jitsiId, getTracks: () => [track] };
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
    addToRoster: (jitsiId) => { roster.push(makeParticipant(jitsiId)); },
    removeFromRoster: (jitsiId) => {
      const i = roster.findIndex((p) => p.getId() === jitsiId);
      if (i >= 0) roster.splice(i, 1);
    },
    resolverMap,
    playingSet,
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
// resolved — and its tap emits one final tail frame. Delivering that tail
// re-registered the ring slot the leave had just compacted, permanently
// (markDeparted had consumed every leave signal). The roster gate must
// discard it.
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

  // B's ScriptProcessor outlives the WebRTC track and emits one last frame.
  tap.pushFrame('human-b');
  tap.pushFrame('human-a');
  assert.deepEqual(
    tap.cap.drain().map((t) => t.jitsiId),
    ['human-a'],
    'the departed peer\'s tail is discarded — delivered, it would re-register the compacted ring slot',
  );

  // The peer-leave finally lands (playing + resolver shut); still nothing.
  tap.playingSet.delete('human-b');
  tap.resolverMap.delete('human-b');
  tap.pushFrame('human-b');
  assert.deepEqual(tap.cap.drain(), [], 'nothing further from the departed peer');
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
// flag reopens its captures deliver (and re-register at the tail) again.
test('a present peer that stops and resumes playing delivers again (no roster-gate false positive)', () => {
  const tap = installTap();
  tap.addToRoster('human-a');
  tap.resolverMap.set('human-a', '0');
  tap.playingSet.add('human-a');
  tap.scan();
  tap.pushFrame('human-a');
  assert.equal(tap.cap.drain().length, 1, 'delivers while playing');

  // Stops playing but stays in the meeting: the play-state fast path frees
  // the slot, and the (silent) captures deliver nothing…
  tap.playingSet.delete('human-a');
  tap.scan();
  assert.deepEqual(tap.cap.drainLeaves(), ['human-a'], 'stop frees the turn like a departure');
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
