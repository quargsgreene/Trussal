// ARCHIVED 2026-08-28 — moved out of src/audio-net/MetaprogrammerParser.js as
// dead code.
//
// A centralized per-effect defaults table, superseded by the per-effect
// parameter resolvers (roomParams / echoParams / crushParams / noiseParams …)
// that own their own bounds. Nothing read EFFECT_DEFAULTS.
//
// The three consts it referenced still live where they did:
// ECHO_DEFAULT_SLOTS in av-effects/Echo.js; MOSAIC_ENABLED_BY_DEFAULT and
// DISJOINT_CSS_ENABLED_BY_DEFAULT exported from MetaprogrammerParser.js.

import { ECHO_DEFAULT_SLOTS } from '../../../src/audio-net/av-effects/Echo.js';
import {
  MOSAIC_ENABLED_BY_DEFAULT,
  DISJOINT_CSS_ENABLED_BY_DEFAULT,
} from '../../../src/audio-net/MetaprogrammerParser.js';

export const EFFECT_DEFAULTS = {
  room: { metric: 'wcl', scale: 1, fixedMetric: null },
  // Bare `# echo`: wcl drives all three parameters, at half a cycle of delay,
  // half feedback and unity gain — each still normalized against wcl's default
  // upper bound, so these are the values reached at that bound rather than
  // fixed outputs. Bounds default per metric (av-effects/Echo.js, which owns
  // this table; echoParams falls back to the very same objects).
  echo: { slots: ECHO_DEFAULT_SLOTS },
  crush: { metric: 'wcl', scale: 1, fixedMetric: null },
  // Both noise axes default to wcl but to factor 0 — nothing modulates until
  // a factor (or the metric keyword that implies one) is written, which is
  // what makes a bare `# noise` the unmodulated floor.
  noise: {
    spectrum: { metric: 'wcl', factor: 0, fixed: null },
    volume: { metric: 'wcl', factor: 0, fixed: null }
  },
  grid: { landmarks: false },
  mosaic: { enabled: MOSAIC_ENABLED_BY_DEFAULT },
  disjointCss: { enabled: DISJOINT_CSS_ENABLED_BY_DEFAULT }
};
