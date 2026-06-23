/**
 * Audio math shared by the script generator (per-bot gain/effects params) and
 * the bot's ffmpeg bed generator.
 *
 * Gain staging: N uncorrelated sources summed at the Jamulus mix grow in
 * power, not amplitude, so per-bot gain scales by 1/sqrt(N). A fixed 3 dB
 * headroom (HEADROOM = 0.7) keeps even correlated peaks (perfect-unison role!)
 * from clipping the server mix.
 *
 * Effects chain ("Trussal latency and jitter-based effects chain"): the
 * measured network latency becomes the echo delay time so the effect is
 * literally the room the network creates; jitter modulates feedback so an
 * unstable link sounds audibly smeared.
 *
 * Note on scope: this module uses each bot's OWN latency/jitter (local
 * color). The fleet-wide worst-case latency (WCL) that drives role 2
 * (staggered round entry) is a different quantity: it is computed by the
 * conductor on each health tick as max() over all bots' reported latencies
 * (see worstCaseLatency in shared/stats.js) and fed into the script
 * generator's variation step.
 */

const HEADROOM = 0.7; // ~ -3 dBFS budget for the whole fleet

export function gainForBotCount(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('bot count must be a positive integer');
  return HEADROOM / Math.sqrt(n);
}

/**
 * Feedback calibration. A feedback delay is BIBO-stable for any g < 1, but
 * worst-case echo buildup is the geometric sum 1/(1-g), so the constants are
 * chosen against the gain-staging budget rather than at the stability edge:
 *
 * - MAX_FEEDBACK 0.85: buildup 1/(1-0.85) ~= 6.7x (+16.5 dB), the most the
 *   HEADROOM/sqrt(N) staging plus Strudel's wet mix (< 1) can absorb without
 *   clipping the Jamulus mix; also the conventional musical ceiling before a
 *   delay tail reads as runaway.
 * - BASE_FEEDBACK 0.2: floor at zero jitter; the 2nd repeat sits at -28 dB,
 *   so latency is audible as one discrete slap echo without smearing.
 * - FEEDBACK_PER_JITTER_MS 0.005: maps the realistic jitter range onto the
 *   usable feedback interval -- (0.85 - 0.2) / 0.005 = 130 ms, so typical WAN
 *   jitter (~20 ms) gives a moderate 0.3 and only a catastrophic >= 130 ms
 *   link pins the ceiling.
 */
const BASE_FEEDBACK = 0.2;
const FEEDBACK_PER_JITTER_MS = 0.005;
const MAX_FEEDBACK = 0.85;

/**
 * Distortion + bitcrush ("network damage") calibration. The delay above turns
 * latency into the literal echo of the link, but on a LAN that delay is sub-10ms
 * and inaudible, so the network character also needs a tone that is present at
 * any latency and intensifies with a worse link:
 *
 * - BASE_DISTORT 0.8 (drive ≈ moderate grit) is audible even at ~0 latency so a
 *   LAN bot still clearly reads as "processed"; latency adds up to +2.0 of drive.
 * - BASE_CRUSH 7 bits is a gentle lo-fi crunch; jitter pulls it down toward
 *   MIN_CRUSH 4 (heavy) so an unstable link sounds quantised/broken.
 */
const BASE_DISTORT = 0.8;
const DISTORT_PER_LATENCY_MS = 1 / 30;
const MAX_DISTORT_EXTRA = 2.0;
const BASE_CRUSH = 7;
const CRUSH_PER_JITTER_MS = 0.5;
const MIN_CRUSH = 4;

const round2 = (x) => Math.round(x * 100) / 100;

export function effectsChain({ latencyMs, jitterMs }) {
  if (!(latencyMs >= 0) || !(jitterMs >= 0)) {
    throw new RangeError('latencyMs and jitterMs must be non-negative numbers');
  }
  return {
    delaySeconds: latencyMs / 1000,
    feedback: Math.min(MAX_FEEDBACK, BASE_FEEDBACK + jitterMs * FEEDBACK_PER_JITTER_MS),
    distortion: round2(BASE_DISTORT + Math.min(MAX_DISTORT_EXTRA, latencyMs * DISTORT_PER_LATENCY_MS)),
    crushBits: round2(Math.max(MIN_CRUSH, BASE_CRUSH - jitterMs * CRUSH_PER_JITTER_MS)),
  };
}
