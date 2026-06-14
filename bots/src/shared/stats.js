/**
 * Statistics helpers for the health-monitoring policy.
 *
 * Why hand-rolled instead of a stats library: we need exactly two small,
 * well-defined functions on the hot health-check path. A dependency would add
 * install weight to every bot container for ~20 lines of arithmetic.
 *
 * `percentile` uses the linear-interpolation method (R-7, the numpy/Excel
 * default) so thresholds behave predictably on small fleets (N <= 10).
 */

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('percentile() requires a non-empty array');
  }
  if (p < 0 || p > 100) throw new RangeError('p must be in [0, 100]');
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * True when `value` sits at or above the p-th percentile of `fleetValues`
 * (the full fleet's samples, including this bot's own).
 *
 * Guards:
 *  - with fewer than 4 samples a 95th-percentile comparison is statistically
 *    meaningless and would let one noisy reading kill a bot in a small
 *    fleet, so we never flag below that size;
 *  - the comparison is strict (>) rather than >=: linear interpolation pulls
 *    p95 strictly below a genuine outlier's own value (its sample drags the
 *    interpolated threshold up but not all the way), so strict > still
 *    flags real outliers — while in a degenerate uniform fleet every bot
 *    sits exactly AT p95 and >= would replace all of them at once.
 */
export const MIN_FLEET_FOR_PERCENTILE = 4;

export function isAtOrAbovePercentile(value, fleetValues, p) {
  if (fleetValues.length < MIN_FLEET_FOR_PERCENTILE) return false;
  return value > percentile(fleetValues, p);
}

/**
 * Worst-case latency (WCL) for the Global Drum Circle staggering model
 * (role 2). Computed by the CONDUCTOR each health tick over every bot's
 * self-reported latency: if all bots wait for the slowest link, every
 * participant hears entries/updates land aligned. Kept here (not in the
 * orchestrator) because the script generator's variation step consumes it
 * too.
 */
export function worstCaseLatency(fleetLatenciesMs) {
  if (!Array.isArray(fleetLatenciesMs) || fleetLatenciesMs.length === 0) {
    throw new RangeError('worstCaseLatency() requires a non-empty array');
  }
  return Math.max(...fleetLatenciesMs);
}

/**
 * Entry offset for bot `index` in role 2: offsets are subdivisions of the
 * WCL — bot i enters at i * (WCL / subdivisions), so the full round spans
 * `count / subdivisions` worst-case-latency windows and no bot's update can
 * arrive at any listener before the previous bot's update has.
 */
export function staggerOffsetMs(index, count, wclMs, subdivisions = 1) {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError('index must be in [0, count)');
  }
  if (!Number.isInteger(subdivisions) || subdivisions < 1) {
    throw new RangeError('subdivisions must be a positive integer');
  }
  return index * (wclMs / subdivisions);
}
