// ARCHIVED 2026-08-28 — moved out of bots/src/shared/config.js as dead code.
//
// A frozen enum mapping UPPER_CASE names to the camelCase role keys. Nothing
// imported it — the role flags actually consulted are the lowercase keys of
// `defaultConfig.roles` (frequencyBands / staggeredRound / unison / stereoTiles),
// which mergeConfig validates against directly.

export const STRATIFICATION_ROLES = Object.freeze({
  FREQUENCY_BANDS: 'frequencyBands',
  STAGGERED_ROUND: 'staggeredRound',
  UNISON: 'unison',
  STEREO_TILES: 'stereoTiles',
});
