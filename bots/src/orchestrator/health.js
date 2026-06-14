/**
 * Pure health policy — separated from the Conductor so the exact rules that
 * kill or shrink a fleet are unit-testable with no I/O.
 */

import { isAtOrAbovePercentile } from '../shared/stats.js';

/**
 * Replacement policy (spec): a bot is terminated and replaced immediately
 * when it (a) reports any runtime/syntax eval error, or (b) sits at or above
 * the configured percentile (default 95th) of the fleet for latency OR RAM.
 * Percentile checks are guarded for tiny fleets inside isAtOrAbovePercentile,
 * and additionally by absolute floors (replaceLatencyFloorMs /
 * replaceRamFloorMb): in any fleet with spread someone always sits at p95,
 * so without floors the policy would perpetually execute the
 * relatively-worst healthy bot.
 */
export function shouldReplace(bot, fleet, cfg) {
  if (bot.errors && bot.errors.length > 0) {
    return { replace: true, reason: `eval error: ${bot.errors[0]}` };
  }
  const p = cfg.percentileCutoff;
  const latencies = fleet.map((b) => b.latencyMs);
  if (bot.latencyMs >= cfg.replaceLatencyFloorMs
      && isAtOrAbovePercentile(bot.latencyMs, latencies, p)) {
    return { replace: true, reason: `latency ${bot.latencyMs}ms ≥ p${p} of fleet` };
  }
  const ramMb = bot.ramBytes / 1e6;
  const rams = fleet.map((b) => b.ramBytes);
  if (ramMb >= cfg.replaceRamFloorMb
      && isAtOrAbovePercentile(bot.ramBytes, rams, p)) {
    return { replace: true, reason: `ram ${Math.round(ramMb)}MB ≥ p${p} of fleet` };
  }
  return { replace: false };
}

/**
 * Scale-down policy (spec): poor connectivity, fps under the user cutoff, or
 * memory over the user threshold shrink the session ceiling from maxBots.
 *
 * Each pressure becomes a factor in (0, 1]: 1 while healthy, proportional to
 * the violation once over the line (half the required fps → factor 0.5). The
 * binding constraint (min factor) scales the ceiling, floored at 1 bot so
 * the session never silently dies. Medians are used for fps/latency so one
 * outlier bot (the replacement policy's job) can't shrink the whole fleet.
 */
const POOR_LATENCY_MS = 400; // beyond this median RTT, connectivity is "unusually poor"

export function computeMaxBots({ medianFps, maxRamMb, medianLatencyMs }, cfg) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const fpsFactor = clamp01(medianFps / cfg.fpsMin);
  const memFactor = clamp01(cfg.memLimitMb / maxRamMb);
  const netFactor = clamp01(POOR_LATENCY_MS / medianLatencyMs);
  const factor = Math.min(fpsFactor, memFactor, netFactor);
  return Math.max(1, Math.floor(cfg.maxBots * factor));
}
