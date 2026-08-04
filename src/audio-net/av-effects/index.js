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
// node. room and noise are visual-only HERE too: their audio nodes run on the
// aggregator's master path (bots/src/bot/aggregator-bot.js #syncMasterRoom /
// #syncMasterNoise), which is the mix every client hears — building them
// locally as well would reverb that audio twice and lay one uncorrelated
// noise bed per browser over a mix that already carries the room's.

import { roomParams, createRoomNode } from './Room.js';
import { echoParams, createEchoNode } from './Echo.js';
import { crushParams, createCrushNode } from './Crush.js';
import { noiseParams, createNoiseNode } from './Noise.js';
import { renderGridOverlays, clearGridOverlays } from './Grid.js';
import { resolveEffectParams } from '../MetaprogrammerParser.js';
import { chainHasValuePattern } from '../ValuePattern.js';

// How often a chain with PATTERNED arguments re-reads them off the cycle grid.
// The metrics-driven path is event-driven and cycle boundaries are pushed by
// the Metaprogrammer, but a SUB-cycle step (`# crush wcl [2 8]`, `# echo wcl
// [1 4] …`) falls between both, so those chains poll at the scheduler's own
// tick rate.
//
// This is a sampling floor, not exact timing: a step edge lands within one
// tick of where it belongs, and a pattern subdividing a short cycle into more
// steps than that can skip some entirely (a 12-step pattern on a 0.5 s cycle
// is ~42 ms a step). The sampled VALUE is a pure function of network time, so
// clients still agree on what is playing — they just cross the edge up to a
// tick apart. Anything finer wants the scheduler's timestamped slot events
// driving AudioParam automation, which waits on that machinery being armed.
export const PATTERN_TICK_MS = 50;

// room's and noise's entries are DORMANT, not live: setChain/updateMetrics
// skip them because both belong to the aggregator's master bus (see the
// header). They stay wired so local-chain room/noise can be switched back on
// in one place if the mix ever stops going through an aggregator.
const MASTER_BUS_EFFECTS = new Set(['room', 'noise']);

// fn → node constructor. The parameter functions are NOT registered here:
// computeChainParams calls each by name, and a second copy of that mapping
// was dead weight that could only drift from the switch that actually runs.
const AUDIO_EFFECTS = {
  room: createRoomNode,
  echo: createEchoNode,
  crush: createCrushNode,
  noise: createNoiseNode
};

// Pure: resolve the full parameter set for a chain at given metrics and cycle
// position. `cycle` is { cycleSeconds, cyclePos } — cyclePos (fractional cycles
// since the epoch) is what every patterned argument is sampled at, and echo
// needs the length too, since its delay is written in cycles. Exported for
// tests and for the research log.
export function computeChainParams(chainEntries, metrics, cycle = {}) {
  const out = [];
  for (const entry of (chainEntries || [])) {
    // noise's patterns are read here rather than in its params function, so
    // the position has to reach resolveEffectParams as well.
    const user = resolveEffectParams(entry, { cycle: cycle.cyclePos || 0 });
    switch (entry.fn) {
      case 'room': out.push({ fn: 'room', params: roomParams(metrics, user, cycle.cyclePos || 0) }); break;
      case 'echo': out.push({ fn: 'echo', params: echoParams(metrics, user, cycle) }); break;
      case 'crush': out.push({ fn: 'crush', params: crushParams(metrics, user, cycle.cyclePos || 0) }); break;
      case 'noise': out.push({ fn: 'noise', params: noiseParams(metrics, user) }); break;
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
    if (fn === 'echo') state.brightness = Math.min(state.brightness, params.visualBrightness);
    if (fn === 'crush') state.pixelate = Math.max(state.pixelate, params.visualPixelate);
    if (fn === 'noise') state.noise = Math.max(state.noise, params.visualNoise);
  }
  return state;
}

export class EffectsChainManager {
  // insert/remove: latency-instrument's master-chain hooks.
  // getCycleContext: () → { cycleSeconds, cyclePos } for the grid the room is
  // on — cyclePos being the fractional cycles since the epoch that patterned
  // effect arguments are read against, so they resolve to the same element the
  // aggregator is using. Its default keeps this class usable without a
  // scheduler (tests, and any browser whose grid has not started): a 1 s cycle
  // frozen at position 0.
  constructor({ audioCtx, insert, remove, getPeers, getLocalJitsiId, getCycleContext }) {
    this._ctx = audioCtx;
    this._insert = insert;
    this._remove = remove;
    this._getPeers = getPeers || (() => []);
    this._getLocalJitsiId = getLocalJitsiId || (() => null);
    this._getCycleContext = getCycleContext || (() => ({ cycleSeconds: 1, cyclePos: 0 }));
    this._nodes = [];       // [{ fn, node }]
    this._chainEntries = [];
    this._metrics = null;   // last metrics seen, for the pattern tick
    this._endpoints = null; // { input, output } handed to insert()
    this._grid = null;      // { landmarks } | null
    this._gridTimer = null;
    this._patternTimer = null;
  }

  // The grid the patterned arguments are read against, defended against a
  // scheduler that has not started (null/NaN position) so a chain still
  // resolves rather than producing NaN parameters.
  cycleContext() {
    const ctx = this._getCycleContext() || {};
    const pos = ctx.cyclePos;
    const seconds = ctx.cycleSeconds;
    return {
      cyclePos: (typeof pos === 'number' && isFinite(pos) && pos > 0) ? pos : 0,
      cycleSeconds: (typeof seconds === 'number' && isFinite(seconds) && seconds > 0) ? seconds : 1
    };
  }

  setChain(chainEntries, metrics) {
    this._teardownAudio();
    this._chainEntries = chainEntries || [];
    this._metrics = metrics;
    const resolved = computeChainParams(this._chainEntries, metrics, this.cycleContext());

    this._grid = null;
    const audioParams = [];
    for (const cp of resolved) {
      if (cp.fn === 'grid') this._grid = cp.params;
      else if (MASTER_BUS_EFFECTS.has(cp.fn)) continue; // aggregator-master effect; visual only here
      else audioParams.push(cp);
    }

    if (this._ctx && audioParams.length) {
      const input = this._ctx.createGain();
      const output = this._ctx.createGain();
      let head = input;
      for (const cp of audioParams) {
        const node = AUDIO_EFFECTS[cp.fn](this._ctx, cp.params);
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
    const resolved = computeChainParams(this._chainEntries, this._metrics, this.cycleContext());
    let i = 0;
    for (const cp of resolved) {
      if (cp.fn === 'grid') { this._grid = cp.params; continue; }
      if (MASTER_BUS_EFFECTS.has(cp.fn)) continue; // no local node — see setChain
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
  // need a clock of their own. Whether any parameter follows the grid is a
  // property of the PROGRAM, so it is settled here, at setChain time, rather
  // than re-resolved on every tick. Armed only while the chain actually holds
  // one: a constant-argument chain keeps re-deriving on metrics updates alone.
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
