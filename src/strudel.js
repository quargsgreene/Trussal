// Strudel engine for the distributed instrument.
//
// One Cyclist scheduler per browser. Every browser combines the pattern code
// from every peer into a single `stack(...)` program and re-evaluates whenever
// any peer's state changes, so the whole room hears the same mix.
//
// Per-peer effect toggles are translated into Strudel-native operators
// (distort / crush / room) applied to that peer's portion of the stack — the
// worklet chain handles mic effects, this handles instrument effects.

import { getStrudelAudioContext } from './latency-instrument.js';
import { subscribePeerState, getAllPeers } from './peer-state.js';
import { subscribeParticipants, getLocalParticipant } from './participants.js';
import { registerSoundfonts } from '@strudel/soundfonts';

export const DEFAULT_PATTERN = `n("<0 1 2 3 4>*8").scale('G4 minor')
  .s("gm_lead_6_voice")
  .clip(sine.range(.2,.8).slow(8))
  .jux(rev)
  .room(2)
  .sometimes(add(note("12")))
  .lpf(perlin.range(200,20000).slow(4))
`;

let strudelMod = null;
let strudelBoot = null;
let lastEvaluated = null;
let anyPlaying = false;

// Effect-parameter calculation must mirror latency-instrument.js so the audible
// mix matches the per-peer mic chain settings.
function computePeerStrudelParams(peer) {
  const rtt = typeof peer.rtt === 'number' ? peer.rtt : 0;
  const jitter = typeof peer.jitter === 'number' ? peer.jitter : 0;
  let glitchIntensity = 0;
  if (peer.effects && peer.effects.distortion) {
    const cleanThreshold = 5;
    const maxGlitchThreshold = 70;
    glitchIntensity = Math.max(0, Math.min(1,
      (rtt - cleanThreshold) / (maxGlitchThreshold - cleanThreshold) + (jitter / 15)
    ));
  }
  let crushBits = 0;
  if (peer.effects && peer.effects.noise) {
    if (jitter > 0.5 && jitter < 1.5) crushBits = 6;
    else if (jitter >= 1.5 && jitter < 3) crushBits = 4;
    else if (jitter >= 3) crushBits = 3;
  }
  return {
    glitchIntensity,
    crushBits,
    reverb: !!(peer.effects && peer.effects.reverb)
  };
}

function wrapPeerPart(peer) {
  // Strip trailing semicolons/whitespace so the wrapped expression remains a
  // single legal expression when chained with .distort/.crush/.room.
  const code = (peer.pattern || '').replace(/[\s;]+$/g, '');
  if (!code || !peer.playing) return null;
  const params = computePeerStrudelParams(peer);
  let part = `(${code})`;
  if (params.glitchIntensity > 0) part += `.distort(${params.glitchIntensity.toFixed(3)})`;
  if (params.crushBits > 0)       part += `.crush(${params.crushBits})`;
  if (params.reverb)              part += `.room(2)`;
  return part;
}

async function loadStrudel() {
  if (strudelMod) return strudelMod;
  strudelMod = await import('@strudel/web');
  return strudelMod;
}

// Boot Strudel exactly once, wiring its audio destination through our master
// gain so the whole stacked program hits realDestination without re-entering
// any peer's per-peer chain. Same prebake as strudel.cc: GM soundfonts plus
// the tidalcycles dirt-samples pack so any pattern from the public REPL works
// without surprises.
async function ensureStrudel() {
  if (strudelBoot) return strudelBoot;
  strudelBoot = (async () => {
    const { audioCtx, destinationNode } = await getStrudelAudioContext();
    Object.defineProperty(audioCtx, 'destination', {
      configurable: true,
      get: () => destinationNode
    });

    const mod = await loadStrudel();
    const { initStrudel, initAudio, samples } = mod;
    await initStrudel({
      audioContext: audioCtx,
      prebake: async () => {
        try { registerSoundfonts(); } catch (e) { console.warn('[strudel] soundfonts failed', e); }
        if (typeof samples === 'function') {
          try { await samples('github:tidalcycles/dirt-samples'); }
          catch (e) { console.warn('[strudel] dirt-samples failed', e); }
        }
      }
    });
    if (typeof initAudio === 'function') {
      try { await initAudio({}); } catch (e) { console.warn('[strudel] initAudio failed', e); }
    }
    return audioCtx;
  })();
  return strudelBoot;
}

async function rebuildAndEvaluate() {
  const parts = getAllPeers()
    .map(wrapPeerPart)
    .filter(Boolean);

  const next = parts.length === 0 ? null : `stack(\n  ${parts.join(',\n  ')}\n)`;

  if (next === lastEvaluated) return;
  lastEvaluated = next;

  const { evaluate, hush } = await loadStrudel();
  if (!next) {
    anyPlaying = false;
    try { hush(); } catch (e) { /* ignore */ }
    return;
  }

  try {
    await evaluate(next);
    anyPlaying = true;
  } catch (e) {
    console.warn('[strudel] evaluate failed', e, '\nprogram:', next);
  }
}

// Strudel needs a user-gesture to bootstrap the audio context. The studio UI
// must call this from the Play click handler before anything is enqueued.
export async function bootStrudelOnUserGesture() {
  await ensureStrudel();
}

export async function syncStrudelFromPeers() {
  // Don't auto-boot; rebuild eagerly so the program is fresh when a user does
  // hit Play. If Strudel is already booted, evaluate immediately.
  if (!strudelBoot) return;
  await rebuildAndEvaluate();
}

export async function stopStrudel() {
  if (!strudelBoot) return;
  const { hush } = await loadStrudel();
  try { hush(); } catch (e) { /* ignore */ }
  anyPlaying = false;
  lastEvaluated = null;
}

export function isStrudelPlaying() { return anyPlaying; }

// React to roster changes — re-stack whenever someone's pattern, effects, or
// play state moves.
subscribePeerState((event, payload) => {
  if (event !== 'peer-upsert' && event !== 'peer-leave') return;
  if (strudelBoot) rebuildAndEvaluate();
});

subscribeParticipants((event) => {
  if (event === 'leave') {
    if (strudelBoot) rebuildAndEvaluate();
  }
});
