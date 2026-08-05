/**
 * Where a cluster's code comes from.
 *
 * Before botConfig, every bot in every room derived from one fleet-wide
 * `randomMasterScript`. Now each human's cluster derives from THAT human's
 * editor at the moment they pressed spawn, shaped by their `botConfig(...)`.
 * The fleet-wide random script survives as the fallback for a spawn that
 * carries no code, and as what `random: "full"` reaches for.
 *
 * Snapshot, not mirror: `captureClusterSource` is called on spawn and the text
 * is kept. A bot plays what its human was playing when it spawned, and only a
 * `retroactive: true` config re-captures. That is deliberate — a live mirror
 * would rewrite every bot's part mid-phrase every time its author typed.
 *
 * This module is pure so the whole matrix is testable without containers: it
 * takes code and a config and returns the {strudel, hydra} pair the bot boots
 * with. Everything about how that pair sits in the MIX — band, stereo position,
 * entry offset, gain staging, link fx — stays in variation.js and is applied
 * afterwards, unchanged.
 */

import { splitHydraCode, normalizePeerCode } from '../../../src/hydra-code.js';
import { hasTextCycles, keepTextStatements, splitStatements } from '../../../src/text-cycles-core.js';
import { defaultBotConfig, flag, parseBotConfig } from '../../../src/bot-config.js';
import { randomMasterScript } from './generator.js';
import {
  applyParamFactor,
  colorHydraPostlude,
  harmonySuffix,
  randomizeParams,
} from './bot-config-transform.js';

/**
 * Split a performer's editor text into the {strudel, hydra} shape the bot boot
 * path already speaks, using the browser's own rule so the fleet and the page
 * never disagree about where the preamble ends. `botConfig(...)` is stripped by
 * normalizePeerCode on the way through — the declaration configures the bots,
 * it is not part of what they play.
 */
export function masterFromPerformerCode(code) {
  const normalized = normalizePeerCode(code);
  if (!normalized) return null;
  const split = splitHydraCode(normalized);
  if (split) return { strudel: split.strudel, hydra: split.preamble };
  return { strudel: normalized, hydra: '' };
}

/**
 * Capture what a cluster will be built from. Returns the snapshot the fleet
 * stores per (room, owner); a spawn with no usable code falls back to the
 * fleet's own random master so a bot still plays something.
 *
 * A config that fails to parse is reported rather than silently ignored: the
 * performer typed something they expect to take effect, and a botConfig with a
 * typo would otherwise spawn a cluster that quietly behaves like the default.
 */
export function captureClusterSource(code, { fallbackMaster = null, seed = 0 } = {}) {
  const parsed = parseBotConfig(code);
  const master = masterFromPerformerCode(code)
    ?? fallbackMaster
    ?? randomMasterScript(seed);

  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      // Still usable: a broken config falls back to exact copies rather than
      // refusing to spawn, so a typo costs the config, not the cluster.
      source: { master, config: defaultBotConfig(), declared: false, capturedAt: Date.now() },
    };
  }

  return {
    ok: true,
    source: {
      master,
      config: parsed.config,
      declared: parsed.present,
      capturedAt: Date.now(),
    },
  };
}

/**
 * Flatten a {strudel, hydra} script back into one editor block, the way a
 * performer would have typed it: preamble, blank line, pattern. That blank line
 * is load-bearing — splitHydraCode is what the receiving page uses to find
 * where the preamble ends.
 *
 * Used when the fleet drives a running bot's REPL (a retroactive re-latch),
 * which speaks the same single-string remote-control path a human's edit does.
 */
export function scriptToEditorCode(script) {
  const hydra = String(script?.hydra ?? '').trim();
  const strudel = String(script?.strudel ?? '').trim();
  if (!hydra) return strudel;
  if (!strudel) return hydra;
  return `${hydra}\n\n${strudel}`;
}

/**
 * Strip the statements that paint words, for a bot whose human did not ask for
 * `textParrot`. Without this every bot in a cluster would repeat its author's
 * words, N times over, in every viewer's chat panel.
 */
export function dropTextStatements(strudel) {
  const src = String(strudel ?? '');
  if (!hasTextCycles(src) && !/(^|[^\w$.])(word|w)\s*\(/.test(src)) return src;
  const kept = splitStatements(src).filter((s) => !s.hasWord).map((s) => s.text);
  return kept.join('\n').trim();
}

/**
 * The {strudel, hydra} one bot boots with, before variation.js positions it in
 * the mix.
 *
 * `index` is the bot's ordinal within its own cluster (0-based), which is what
 * every spread — harmony voicing, colour scheme — is measured along, so a
 * cluster of N covers N positions rather than every bot landing on the same one.
 */
export function botScriptFor(source, { index, count = 1, seed = 0, botId = 0 } = {}) {
  const config = source?.config ?? defaultBotConfig();
  const master = source?.master ?? { strudel: '', hydra: '' };

  // `random: "full"` replaces the human's code outright — "fully randomizes the
  // code of each bot within existing constraints", and the curated palette in
  // generator.js is what those constraints are. Seeded per bot so a replacement
  // container rebuilds the identical script.
  const base = config.random === 'full'
    ? randomMasterScript(seed + botId + 1)
    : { strudel: master.strudel || '', hydra: master.hydra || '' };

  let strudel = base.strudel;
  let hydra = base.hydra;

  if (!flag(config.textParrot)) strudel = dropTextStatements(strudel);

  // Numeric shaping. paramFactor is the deterministic sibling of
  // random:"params"; when both are set the factor is applied first so the
  // jitter is measured around the scaled value the author asked for.
  if (config.paramFactor != null) {
    strudel = applyParamFactor(strudel, config.paramFactor);
    hydra = applyParamFactor(hydra, config.paramFactor);
  }
  if (config.random === 'params') {
    strudel = randomizeParams(strudel, seed + botId + 1);
    hydra = randomizeParams(hydra, seed + botId + 101);
  }

  // Pitch. Appended to the whole expression rather than rewritten into it, so
  // it composes with whatever the author wrote (see variation.js).
  const harmony = harmonySuffix(config.harmony, index, base.strudel, seed);
  if (harmony && strudel.trim()) strudel = `(\n${strudel}\n)${harmony}`;

  // Colour. A postlude reading o0 and writing back to it, exactly as the band
  // and tile roles do, so it stacks with them instead of replacing them.
  const colour = colorHydraPostlude(config.colorScheme, index, count, seed);
  if (colour && hydra.trim()) hydra = `${hydra}\n${colour}`;

  return { strudel, hydra };
}
