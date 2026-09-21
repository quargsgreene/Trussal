// noise — a noise bed on the room's mix whose SPECTRUM and OUTPUT VOLUME are
// each modulated by a worst-case metric the user picks:
//
//   `# noise [<metric>] [<spectrum factor>] [<metric>] [<volume factor>]
//            [<fixed amount 1>] [<fixed amount 2>]`
//
//   tilt    = clamp01(spectrum factor × metric₁)  0 = brown, 0.5 = pink, 1 = white
//   gain dB = 25 + clamp01(volume factor × metric₂) × (75 − 25)
//   gain    = 0.12 × 10^((dB − 25) / 20)
//
// A metric reads live unless the matching fixed amount pins it — the 5th and
// 6th arguments pin the 1st and 2nd metric IN WRITTEN ORDER, exactly as
// `# room wcl 2 0.4` pins room's wcl. Amounts are seconds for wcl/wcj/wcrtt
// and a loss fraction for wcpl, matching `# cycles`. Both metrics default to
// wcl, and a factor defaults to 1 only when its metric keyword was written:
// a bare `# noise` names neither metric, so nothing modulates and the bed
// sits at its floor — brown, 25 dB. The room's default program carries no
// `# noise` line at all, so a new meeting opens BYPASSED (no node, not a
// silent one).
//
// Colour is a continuous sweep, not the four steps of the superseded
// wcpl-threshold plan: three level-matched generators (brown, pink, white)
// run for the node's lifetime and `tilt` equal-power-crossfades the two
// adjacent ones, so worsening conditions open the bed's top end smoothly
// instead of jumping between buffers.
//
// Like room, the audio node runs on the AGGREGATOR's master path (the mix
// every client hears), not in each browser. Its image counterpart — grain
// following both the colour and the level — is applied on the aggregator's
// COMPOSITED FRAME (av-effects/VideoState.js), the single image the room
// sees, and its text counterpart injects glyphs into the words Text Cycles
// paints (av-effects/TextState.js). Pure math is separated from node
// construction for node:test.

// Ordered dark → bright: `tilt` sweeps along this axis.
export const NOISE_COLORS = ['brown', 'pink', 'white'];

// Hydra counterpart: grain per colour at full level, interpolated with tilt.
export const VISUAL_GRAIN = [0.15, 0.35, 0.6];

// The bed's floor (an unmodulated `# noise`) and its ceiling.
export const NOISE_BASE_DB = 25;
export const NOISE_MAX_DB = 75;

// Linear gain at NOISE_BASE_DB — the fixed gain the effect ran at before the
// volume became modulated, so a bare `# noise` (brown, see NOISE_RMS) is
// unchanged in level. The dB scale is anchored here rather than at full
// scale, which puts 0 dBFS around 43 dB: the 75 dB clamp is a bound on the
// modulation, NOT a promise that the bed stays inside the mix's headroom.
// The ceiling is ~38x linear and there is no limiter between here and the
// fan, so the top of the range clips the master deliberately.
export const NOISE_BASE_GAIN = 0.12;

// Each colour's buffer is normalized to this RMS so a tilt sweep is a change
// of spectrum only. The anchor is the BROWN generator's own RMS (measured
// 0.203), not white's, because brown is the colour a bare `# noise` selects:
// normalizing to white would leave the floor 9 dB hotter than the fixed-gain
// implementation ran at, which is the one level NOISE_BASE_GAIN is supposed
// to reproduce. Brown keeps its level, pink and white come down to meet it.
export const NOISE_RMS = 0.2;

// Generated loop length, seconds.
export const NOISE_LOOP_S = 2;

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

const SLOT_DEFAULTS = { metric: 'wcl', factor: 0, fixed: null };

// One metric's value in the unit the factors are written against: seconds for
// the time metrics (which arrive in ms), a fraction for wcpl. A pinned amount
// replaces the live reading entirely.
export function metricAmount(metrics, metric, fixed) {
  const live = Math.max(0, (metrics && metrics[metric]) || 0);
  const raw = fixed != null && fixed > 0 ? fixed : (metric === 'wcpl' ? live : live / 1000);
  return metric === 'wcpl' ? Math.min(1, raw) : Math.max(0, raw);
}

// One axis' modulation depth in [0, 1]. Factor 0 (the slot was never written)
// means that axis does not modulate at all.
export function modulationAmount(metrics, slot) {
  const s = { ...SLOT_DEFAULTS, ...(slot || {}) };
  if (!(s.factor > 0)) return 0;
  return clamp01(metricAmount(metrics, s.metric, s.fixed) * s.factor);
}

// Where `tilt` sits on the colour axis: the lower of the two adjacent colours
// and how far it has crossed toward the upper one.
function tiltSegment(tilt) {
  const span = clamp01(tilt) * (NOISE_COLORS.length - 1);
  const lower = Math.min(Math.floor(span), NOISE_COLORS.length - 2);
  return { lower, frac: span - lower };
}

// Per-colour generator gains. The two generators are uncorrelated, so their
// POWERS add: the cos/sin (equal-power) pair holds the bed's level flat across
// a sweep where a linear crossfade would dip ~3 dB in the middle.
export function noiseMix(tilt) {
  const { lower, frac } = tiltSegment(tilt);
  const mix = {};
  for (const color of NOISE_COLORS) mix[color] = 0;
  // cos(π/2) lands on 6e-17 rather than 0, which would leave a pure colour
  // reading as a two-generator blend — inaudible, but it churns the JSON the
  // aggregator dedups its page pushes against. Snap the endpoints exact.
  const snap = (g) => (Math.abs(g) < 1e-12 ? 0 : g);
  mix[NOISE_COLORS[lower]] = snap(Math.cos((frac * Math.PI) / 2));
  mix[NOISE_COLORS[lower + 1]] = snap(Math.sin((frac * Math.PI) / 2));
  return mix;
}

// The colour the bed is nearest — a label for readouts and logs; the audible
// blend is noiseMix(), which is rarely one pure colour.
export function noiseTypeForTilt(tilt) {
  const { lower, frac } = tiltSegment(tilt);
  return frac < 0.5 ? NOISE_COLORS[lower] : NOISE_COLORS[lower + 1];
}

export function noiseGainForDb(db) {
  const clamped = Math.min(NOISE_MAX_DB, Math.max(0, Number.isFinite(db) ? db : 0));
  return NOISE_BASE_GAIN * Math.pow(10, (clamped - NOISE_BASE_DB) / 20);
}

export function noiseParams(metrics, { spectrum = null, volume = null } = {}) {
  const tilt = modulationAmount(metrics, spectrum);
  const level = modulationAmount(metrics, volume);
  const gainDb = NOISE_BASE_DB + level * (NOISE_MAX_DB - NOISE_BASE_DB);
  const { lower, frac } = tiltSegment(tilt);
  const grain = VISUAL_GRAIN[lower] + (VISUAL_GRAIN[lower + 1] - VISUAL_GRAIN[lower]) * frac;
  return {
    tilt,
    gainDb,
    gain: noiseGainForDb(gainDb),
    mix: noiseMix(tilt),
    type: noiseTypeForTilt(tilt),
    // The image counterpart: colour sets the grain's character, level scales
    // it, so a quiet brown bed barely marks the image and a loud white one
    // buries it. Full scale (0.6) needs both a white tilt and the 75 dB
    // ceiling. Consumed by av-effects/VideoState.js, which lays it over the
    // aggregator's composited frame, and by TextState.js, where the same
    // level sets how many glyphs the bed injects into a word.
    visualNoise: grain * (gainDb / NOISE_MAX_DB)
  };
}

// Generate a noise buffer of the requested color (2 s loop).
export function fillNoise(channel, type) {
  if (type === 'white') {
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
    return channel;
  }
  if (type === 'pink') {
    // Voss-McCartney-ish via IIR (Paul Kellet's economy pink filter).
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < channel.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      channel[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    return channel;
  }
  // brown: integrated white, leaky.
  let last = 0;
  for (let i = 0; i < channel.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    channel[i] = last * 3.5;
  }
  return channel;
}

// Scale a filled buffer to a target RMS in place. As written the three
// generators span about 9 dB (white ≈ 2.9 × brown), and an unmatched pair
// makes the equal-power crossfade a volume ramp — so every colour is
// normalized before it reaches the mix gains.
export function normalizeRms(channel, target = NOISE_RMS) {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  const rms = Math.sqrt(sum / (channel.length || 1));
  if (!(rms > 0)) return channel;
  const scale = target / rms;
  for (let i = 0; i < channel.length; i++) channel[i] *= scale;
  return channel;
}

export function createNoiseNode(audioCtx, params) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  input.connect(output); // noise is additive; signal passes through

  const level = audioCtx.createGain();
  level.gain.value = params.gain;
  level.connect(output);

  // All three generators run for the node's lifetime; a colour at gain 0 is
  // silent but ready, so a tilt sweep is a crossfade rather than a buffer
  // rebuild mid-stream.
  const len = Math.max(1, Math.floor(audioCtx.sampleRate * NOISE_LOOP_S));
  const voices = NOISE_COLORS.map((color) => {
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    normalizeRms(fillNoise(buf.getChannelData(0), color));
    const gain = audioCtx.createGain();
    gain.gain.value = (params.mix && params.mix[color]) || 0;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    gain.connect(level);
    src.start();
    return { color, src, gain };
  });

  return {
    input,
    output,
    update(next) {
      level.gain.value = next.gain;
      voices.forEach((v) => { v.gain.gain.value = (next.mix && next.mix[v.color]) || 0; });
    },
    // Teardown logs and keeps going rather than logging and re-throwing: the
    // first failed stop()/disconnect() must not strand the generators still
    // running behind it. Nothing here is silent.
    dispose() {
      voices.forEach((v) => {
        try {
          v.src.stop();
        } catch (e) {
          console.error(`[noise] stopping the ${v.color} generator failed`, e);
        }
      });
      const named = [
        ['input', input], ['output', output], ['level', level],
        ...voices.flatMap((v) => [[`${v.color} source`, v.src], [`${v.color} gain`, v.gain]])
      ];
      named.forEach(([label, node]) => {
        if (!node) return;
        try {
          node.disconnect();
        } catch (e) {
          console.error(`[noise] disconnecting the ${label} node failed`, e);
        }
      });
    }
  };
}
