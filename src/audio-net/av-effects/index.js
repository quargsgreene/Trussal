// Effects Service: turns the metaprogram's `#` chain into live WebAudio
// nodes inserted after all existing effects (between the master bus and the
// context destination) plus the matching visual state for the Hydra output.
//
// Audio-node params re-derive from worst-case metrics on every metrics
// update; the chain itself rebuilds only when the applied program changes.
// An effect written with mini-notation arguments (`# crush wcl <2 4>`) also
// has to be re-derived as the cycle grid advances, which no metrics update
// would trigger — hence the pattern tick, armed only while such an argument
// is in the chain.
// grid is visual-only: it renders panel overlays and contributes no audio
// node. room is visual-only HERE too: its audio node runs on the
// aggregator's master path (bots/src/bot/aggregator-bot.js #syncMasterRoom),
// which is the mix every client hears — inserting it locally as well would
// reverb that audio twice.

import { roomParams, createRoomNode } from './Room.js';
import { echoParams, createEchoNode } from './Echo.js';
import { crushParams, createCrushNode } from './Crush.js';
import { noiseParams, createNoiseNode } from './Noise.js';
import { renderGridOverlays, clearGridOverlays } from './Grid.js';
import { resolveEffectParams } from '../MetaprogrammerParser.js';
import { chainHasValuePattern } from '../ValuePattern.js';

// How often patterned effect arguments are re-read off the cycle grid. The
// value itself is a pure function of network time, so every client agrees on
// it whatever the tick phase; this only sets how promptly a subdivision
// boundary (`# crush wcl [2 8]`) is heard.
export const PATTERN_TICK_MS = 50;

// room's entry is DORMANT, not live: setChain/updateMetrics skip it because
// the reverb belongs to the aggregator's master bus (see the header). It is
// kept wired so local-chain room can be switched back on in one place if the
// mix ever stops going through an aggregator.
const AUDIO_EFFECTS = {
  room: { params: roomParams, create: createRoomNode },
  echo: { params: echoParams, create: createEchoNode },
  crush: { params: crushParams, create: createCrushNode },
  noise: { params: (m) => noiseParams(m), create: createNoiseNode }
};

// Pure: resolve the full parameter set for a chain at given metrics and at a
// position on the cycle grid (fractional cycles since the epoch, which only
// patterned arguments read). Exported for tests and for the research log.
export function computeChainParams(chainEntries, metrics, sampleRate = 48000, cyclePos = 0) {
  const out = [];
  for (const entry of (chainEntries || [])) {
    const user = resolveEffectParams(entry);
    switch (entry.fn) {
      case 'room': out.push({ fn: 'room', params: roomParams(metrics, user) }); break;
      case 'echo': out.push({ fn: 'echo', params: echoParams(metrics, user, sampleRate) }); break;
      case 'crush': out.push({ fn: 'crush', params: crushParams(metrics, user, cyclePos) }); break;
      case 'noise': out.push({ fn: 'noise', params: noiseParams(metrics) }); break;
      case 'grid': out.push({ fn: 'grid', params: { landmarks: !!user.landmarks } }); break;
      default: break; // pattern fns (ply/chop/…) apply to scheduling, not the bus
    }
  }
  return out;
}

// Merge the chain's visual counterparts into one state object for Hydra.
export function visualStateFor(chainParams) {
  const state = { brightness: 1, lowpass: 1, pixelate: 1, noise: 0 };
  for (const { fn, params } of chainParams) {
    if (fn === 'room') state.lowpass = Math.min(state.lowpass, params.visualLowpass);
    if (fn === 'echo') state.brightness = params.visualBrightness;
    if (fn === 'crush') state.pixelate = Math.max(state.pixelate, params.visualPixelate);
    if (fn === 'noise') state.noise = Math.max(state.noise, params.visualNoise);
  }
  return state;
}

export class EffectsChainManager {
  // insert/remove: latency-instrument's master-chain hooks.
  // getCyclePosition: () → fractional cycles since the epoch, or null before
  // the grid is running — what patterned effect arguments are read against.
  constructor({ audioCtx, insert, remove, getPeers, getLocalJitsiId, getCyclePosition }) {
    this._ctx = audioCtx;
    this._insert = insert;
    this._remove = remove;
    this._getPeers = getPeers || (() => []);
    this._getLocalJitsiId = getLocalJitsiId || (() => null);
    this._getCyclePosition = getCyclePosition || (() => 0);
    this._nodes = [];       // [{ fn, node }]
    this._chainEntries = [];
    this._metrics = null;   // last metrics seen, for pattern-driven re-derives
    this._endpoints = null; // { input, output } handed to insert()
    this._grid = null;      // { landmarks } | null
    this._gridTimer = null;
    this._patternTimer = null;
  }

  cyclePosition() {
    const pos = this._getCyclePosition();
    return (typeof pos === 'number' && isFinite(pos) && pos > 0) ? pos : 0;
  }

  setChain(chainEntries, metrics) {
    this._teardownAudio();
    this._chainEntries = chainEntries || [];
    this._metrics = metrics;
    const resolved = computeChainParams(
      this._chainEntries, metrics, this._ctx ? this._ctx.sampleRate : 48000, this.cyclePosition()
    );

    this._grid = null;
    const audioParams = [];
    for (const cp of resolved) {
      if (cp.fn === 'grid') this._grid = cp.params;
      else if (cp.fn === 'room') continue; // aggregator-master effect; visual only here
      else audioParams.push(cp);
    }

    if (this._ctx && audioParams.length) {
      const input = this._ctx.createGain();
      const output = this._ctx.createGain();
      let head = input;
      for (const cp of audioParams) {
        const node = AUDIO_EFFECTS[cp.fn].create(this._ctx, cp.params);
        head.connect(node.input);
        head = node.output;
        this._nodes.push({ fn: cp.fn, node });
      }
      head.connect(output);
      this._endpoints = { input, output };
      if (this._insert) this._insert(this._endpoints);
    }

    this._syncGridLoop();
    this._syncPatternLoop();
    this._publishVisual(resolved);
  }

  updateMetrics(metrics) {
    this._metrics = metrics;
    this.refresh();
  }

  // Re-derive every node's params from the last metrics at the current cycle
  // position, and push them into the live nodes. Public because it is what
  // the pattern tick calls: nothing about it is internal-only.
  refresh() {
    if (!this._chainEntries.length) return;
    const resolved = computeChainParams(
      this._chainEntries, this._metrics, this._ctx ? this._ctx.sampleRate : 48000, this.cyclePosition()
    );
    let i = 0;
    for (const cp of resolved) {
      if (cp.fn === 'grid') { this._grid = cp.params; continue; }
      if (cp.fn === 'room') continue; // no local node — see setChain
      const entry = this._nodes[i++];
      if (entry && entry.fn === cp.fn) entry.node.update(cp.params);
    }
    this._publishVisual(resolved);
  }

  _publishVisual(resolved) {
    if (typeof window !== 'undefined') window._ncVisual = visualStateFor(resolved);
  }

  patternTicking() { return this._patternTimer != null; }

  // Patterned arguments change with the cycle, not with the metrics, so they
  // need a clock of their own. Armed only while the chain actually holds one:
  // a constant-argument chain keeps re-deriving on metrics updates alone.
  _syncPatternLoop() {
    const wanted = chainHasValuePattern(this._chainEntries) && typeof setInterval !== 'undefined';
    if (wanted && !this._patternTimer) {
      this._patternTimer = setInterval(() => this.refresh(), PATTERN_TICK_MS);
    } else if (!wanted && this._patternTimer) {
      clearInterval(this._patternTimer);
      this._patternTimer = null;
    }
  }

  _syncGridLoop() {
    if (this._grid && !this._gridTimer && typeof document !== 'undefined') {
      this._gridTimer = setInterval(() => {
        renderGridOverlays(this._getPeers(), this._getLocalJitsiId(), { landmarks: this._grid.landmarks });
      }, 1000);
    } else if (!this._grid && this._gridTimer) {
      clearInterval(this._gridTimer);
      this._gridTimer = null;
      clearGridOverlays();
    }
  }

  _teardownAudio() {
    if (this._endpoints && this._remove) this._remove(this._endpoints);
    for (const { node } of this._nodes) node.dispose();
    this._nodes = [];
    this._endpoints = null;
  }

  dispose() {
    this._teardownAudio();
    this._chainEntries = [];
    this._metrics = null;
    this._grid = null;
    this._syncGridLoop();
    this._syncPatternLoop();
    if (typeof window !== 'undefined') window._ncVisual = { brightness: 1, lowpass: 1, pixelate: 1, noise: 0 };
  }
}
