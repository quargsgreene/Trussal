// The OUTPUT-STAGE counterpart of the `#` effect chain: what shape (if any)
// the aggregator's composed frame is rendered onto, and what surrounds it.
//
// Separate from VideoState.js on purpose, and applied BEFORE it: the stage
// decides the frame's GEOMETRY — the composed mosaic becomes a texture on a
// shape, inside a skybox, scattered through a particle system — while
// VideoState decides what happens to that rendered image afterwards (crush,
// blur, grain, echo). The order is the same one a painter works in: ground,
// form, glaze. A chain with neither is the plain mosaic, unchanged.
//
// Composition model (the one the parser's tables mirror): exactly ONE shape
// command is live at a time — last wins, like `# mosaic` re-typed — while
// skybox, particle2, particle3, tiling, tessellation and background are
// independent layers that stack with the shape and with each other, and
// camera3d / controls3d / lighting3d set how any three.js layer is viewed
// and lit (each last-wins, like the shape). Every
// directive here is media-gated, so `# tetrahedron … ["audio"]` leaves the
// picture alone exactly as `# room … ["audio"]` does.
//
// Pure module: no DOM, no canvas, no libraries — it only resolves the chain
// into plain numbers the page stage consumes. Runs in the bundle, in bots,
// and under node:test.

import {
  THREE_SHAPES, P5_SHAPES, TILING_MODES, CONTROLS3D_MODES, LIGHTING3D_MODES
} from '../MetaprogrammerParser.js';
import { evaluateValuePattern, isValuePattern } from '../ValuePattern.js';
import { entryAffects } from '../EffectMedia.js';

// The stage's defaults, named here so tests and the docs quote the same
// numbers the page uses. Everything below is per-cycle or per-frame, chosen
// to stay legible on a 1280x720 output under software WebGL.
export const PARTICLE2_DEFAULTS = { count: 1200, size: 3, speed: 1 };
export const PARTICLE3_DEFAULTS = { count: 1500, size: 2.5, speed: 1 };
export const TESSELLATION_DEFAULTS = { cols: 4, rows: 3, spin: 0.35 };
export const TILING_DEFAULT_COUNT = 3;
export const SKYBOX_DEFAULT_FOV = 80;
// The camera as three.js would leave it: straight on, level, auto-fit, the
// stage's 50° lens. Degrees throughout (see CAMERA3D_SLOTS in the parser).
export const CAMERA3D_DEFAULTS = { azimuth: 0, polar: 90, zoom: 1, fov: 50, roll: 0 };
// Speed is turns (or loops) per cycle — one lap every 8 cycles by default, so
// a camera move reads as a phrase rather than a spin. `amount` is per mode:
// orbit's polar swing and trackball's axis tilt in degrees, map's pan reach
// and fly's dive depth as fractions of the view.
export const CONTROLS3D_DEFAULTS = {
  orbit: { speed: 0.125, amount: 20 },
  trackball: { speed: 0.125, amount: 35 },
  map: { speed: 0.125, amount: 0.35 },
  fly: { speed: 0.125, amount: 0.6 },
};
const CONTROLS3D_AMOUNT_MAX = { orbit: 80, trackball: 90, map: 2, fly: 0.95 };
// Intensity 1 shows the frame at full brightness where the key light hits it
// square on; the key comes from the upper right front.
export const LIGHTING3D_DEFAULTS = { intensity: 1, azimuth: 45, polar: 45, spin: 0, color: '#ffffff' };

// Ceilings, same rationale as VideoState's: past these a setting stops
// reading as the intended picture and starts reading as a broken stream —
// and particle counts times software rasterization is the fastest way to
// lose the frame rate the whole mosaic depends on.
export const MAX_PARTICLES = 8000;
export const MAX_TILING_COUNT = 12;
export const MAX_TESSELLATION_COLS = 16;
export const MAX_TESSELLATION_ROWS = 12;

// The neutral stage: nothing rendered but the frame itself.
export function neutralOutputState() {
  return {
    shape: null,
    tiling: null,
    skybox: false,
    particle2: null,
    particle3: null,
    tessellation: null,
    background: null,
    camera3d: null,
    controls3d: null,
    lighting3d: null,
  };
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo));

// One parameter, as the page wants it: a finite number, or null meaning "use
// the default in the table above". Rests (`~`) parse to null; a patterned
// element is sampled at cyclePos like every other `#` argument; a data
// reference walks its column over the cycle. Anything else — an empty
// pattern, a dropped chance — is null too, so the page never sees NaN.
function param(value, cyclePos) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (isValuePattern(value) || (value && value.type === 'dataRef')) {
    const v = evaluateValuePattern(value, cyclePos);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return null;
}

// A whole bracket group, positions preserved so the page can index by slot.
function group(values, cyclePos) {
  return (values || []).map((v) => param(v, cyclePos));
}

// One color at this point on the cycle: a literal, or a color pattern whose
// terms are quoted strings, sampled per cycle by the same reader that samples
// numeric arguments (strings pass through it as scalars on the terms it lands
// on). A rest or anything unreadable is the fallback.
function colorAt(c, cyclePos, fallback) {
  if (typeof c === 'string') return c;
  if (isValuePattern(c) || (c && c.type === 'dataRef')) {
    const v = evaluateValuePattern(c, cyclePos);
    return typeof v === 'string' ? v : fallback;
  }
  return fallback;
}

// Degrees folded into [0, 360) — azimuths and rolls wrap rather than clamp.
const wrapDegrees = (v) => ((v % 360) + 360) % 360;

// A resolved background, or null. Colors pattern per cycle through colorAt,
// so `# background "gradient" <"#f00" "#00f"> "#000" 45` cross-fades its first
// color once per cycle.
function backgroundState(bg, cyclePos) {
  if (!bg) return null;
  if (bg.mode === 'image') {
    // A URL is not patternable through the reader — it is a literal, and the
    // page validates it by loading it (a dead URL leaves the base color).
    return { type: 'image', url: typeof bg.url === 'string' ? bg.url : null };
  }
  const color = (c, fallback) => colorAt(c, cyclePos, fallback);
  if (bg.mode === 'gradient') {
    return {
      type: 'gradient',
      from: color(bg.from, '#ff00aa'),
      to: color(bg.to, '#002244'),
      // Degrees, 0 pointing right, turning clockwise — the page converts to
      // a canvas gradient. Default straight down, the classic poster sweep.
      angle: param(bg.angle, cyclePos) ?? 90,
    };
  }
  const c = color(bg.color, '#000000');
  return { type: 'color', color: c };
}

// The stage parameters in force for this chain, at this point on the cycle
// grid. `cycle` is the same { cycleSeconds, cyclePos } object VideoState and
// the audio params take — one position for every reader on the bot.
//
// Where several directives of the SAME slot are chained the last wins — a
// shape is a choice of one object, not a stack of overlays, so a re-typed
// `# sphere` replaces the `# tetrahedron` rather than fighting it. Different
// slots are independent and all apply.
export function outputStateFor(chainEntries, cycle = {}) {
  const cyclePos = cycle.cyclePos || 0;
  const state = neutralOutputState();

  for (const entry of (chainEntries || [])) {
    if (!entryAffects(entry, 'video', cyclePos)) continue;

    switch (entry.fn) {
      case 'skybox': {
        // Bare `# skybox` is on, matching `# mosaic`'s bare-true reading; the
        // parser supplies the default when the argument is omitted.
        state.skybox = entry.args ? entry.args[0] !== false : true;
        break;
      }
      case 'tiling': {
        const mode = TILING_MODES.includes(entry.mode) ? entry.mode : null;
        if (!mode || mode === 'none') { state.tiling = null; break; }
        const count = param(entry.args && entry.args[0] && entry.args[0][0], cyclePos);
        state.tiling = {
          mode,
          count: count == null ? TILING_DEFAULT_COUNT : clamp(Math.round(count), 1, MAX_TILING_COUNT),
        };
        break;
      }
      case 'particle2': {
        const [count, size, speed] = group(entry.args && entry.args[0], cyclePos);
        state.particle2 = {
          count: count == null ? PARTICLE2_DEFAULTS.count : clamp(Math.round(count), 16, MAX_PARTICLES),
          size: size == null ? PARTICLE2_DEFAULTS.size : clamp(size, 0.5, 32),
          speed: speed == null ? PARTICLE2_DEFAULTS.speed : clamp(speed, 0, 8),
        };
        break;
      }
      case 'particle3': {
        const [count, size, speed] = group(entry.args && entry.args[0], cyclePos);
        state.particle3 = {
          count: count == null ? PARTICLE3_DEFAULTS.count : clamp(Math.round(count), 16, MAX_PARTICLES),
          size: size == null ? PARTICLE3_DEFAULTS.size : clamp(size, 0.5, 32),
          speed: speed == null ? PARTICLE3_DEFAULTS.speed : clamp(speed, 0, 8),
        };
        break;
      }
      case 'tessellation': {
        const [cols, rows, spin] = group(entry.args && entry.args[0], cyclePos);
        state.tessellation = {
          cols: cols == null ? TESSELLATION_DEFAULTS.cols : clamp(Math.round(cols), 1, MAX_TESSELLATION_COLS),
          rows: rows == null ? TESSELLATION_DEFAULTS.rows : clamp(Math.round(rows), 1, MAX_TESSELLATION_ROWS),
          spin: spin == null ? TESSELLATION_DEFAULTS.spin : clamp(spin, 0, 4),
        };
        break;
      }
      case 'background': {
        // Last wins, like the shape slot: one backdrop, re-typed. A bare
        // `# background` clears it (backgroundState of null is null).
        state.background = backgroundState(entry.background, cyclePos);
        break;
      }
      case 'camera3d': {
        const D = CAMERA3D_DEFAULTS;
        const [azimuth, polar, zoom, fov, roll] = group(entry.args && entry.args[0], cyclePos);
        state.camera3d = {
          azimuth: azimuth == null ? D.azimuth : wrapDegrees(azimuth),
          // Off the poles: a camera looking exactly along its up vector has
          // no defined orientation.
          polar: polar == null ? D.polar : clamp(polar, 1, 179),
          zoom: zoom == null ? D.zoom : clamp(zoom, 0.05, 20),
          fov: fov == null ? D.fov : clamp(fov, 10, 120),
          roll: roll == null ? D.roll : wrapDegrees(roll),
        };
        break;
      }
      case 'controls3d': {
        const mode = CONTROLS3D_MODES.includes(entry.mode) ? entry.mode : null;
        if (!mode || mode === 'none') { state.controls3d = null; break; }
        const D = CONTROLS3D_DEFAULTS[mode];
        const [speed, amount] = group(entry.args && entry.args[0], cyclePos);
        state.controls3d = {
          mode,
          speed: speed == null ? D.speed : clamp(speed, 0, 8),
          amount: amount == null ? D.amount : clamp(amount, 0, CONTROLS3D_AMOUNT_MAX[mode]),
        };
        break;
      }
      case 'lighting3d': {
        const mode = LIGHTING3D_MODES.includes(entry.mode) ? entry.mode : null;
        if (!mode || mode === 'none') { state.lighting3d = null; break; }
        const D = LIGHTING3D_DEFAULTS;
        const [intensity, azimuth, polar, spin] = group(entry.args && entry.args[0], cyclePos);
        state.lighting3d = {
          mode,
          intensity: intensity == null ? D.intensity : clamp(intensity, 0, 10),
          azimuth: azimuth == null ? D.azimuth : wrapDegrees(azimuth),
          polar: polar == null ? D.polar : clamp(polar, 0, 180),
          spin: spin == null ? D.spin : clamp(spin, 0, 8),
          color: colorAt(entry.color, cyclePos, D.color),
        };
        break;
      }
      default: {
        // The shape commands. One slot, last wins.
        const family = entry.fn in THREE_SHAPES ? 'three'
          : (entry.fn in P5_SHAPES ? 'p5' : null);
        if (!family) break; // room/crush/noise/echo/grid/etc — not stage
        const args = entry.args || [];
        state.shape = {
          name: entry.fn,
          family,
          geometry: group(args[0], cyclePos),
          scene: group(args[1], cyclePos),
          animation: group(args[2], cyclePos),
        };
      }
    }
  }
  return state;
}

// Whether the stage has anything to render. The compositor uses this to keep
// the plain-mosaic path — the common case — byte-for-byte as it was: no
// texture capture, no extra canvas, no library loaded.
export function outputStageActive(state) {
  if (!state) return false;
  return !!(state.shape || state.skybox || state.particle2
    || state.particle3 || state.tessellation);
}

// Which libraries the stage needs for this state, so the page (and the
// diagnostics) can tell a three.js skybox from a p5 square. `background`
// alone needs neither — it is a 2D fill around whatever else is there — and
// nor do camera3d / controls3d / lighting3d, which only shape a three.js
// scene something else asked for. Tessellation follows the shape: a 3D
// shape's honeycomb is three.js, a 2D shape's tiling and the shapeless quilt
// are p5.
export function outputStageLibraries(state) {
  if (!outputStageActive(state)) return { three: false, p5: false };
  const s = state.shape;
  const threeShape = !!(s && s.family === 'three');
  return {
    three: !!(state.skybox || state.particle3 || threeShape),
    p5: !!(state.particle2 || (state.tessellation && !threeShape) || (s && s.family === 'p5')),
  };
}
