/**
 * Local audio bed (spec: "Accompanying local audio to each container is also
 * generated via ffmpeg according to the user settings with respect to the
 * Strudel and Hydra code").
 *
 * Implementation: a band-limited noise bed confined to the SAME frequency
 * band the bot's Strudel variation occupies (role 1), at the SAME staged
 * gain — so the bed reinforces rather than fights the mix. It writes to the
 * ALSA loopback playback device; the Jamulus client captures the loopback's
 * other end, so the bed and the browser's Strudel audio sum on the same
 * virtual cable.
 *
 * Returned as an argv array (not a shell string) so no escaping bugs can
 * reach spawn().
 */

export function ffmpegBedArgs({
  loFreq,
  hiFreq,
  gain,
  alsaDevice = 'plughw:Loopback,0,0',
  sampleRate = 48000, // Jamulus operates at 48 kHz; match it to skip resampling
}) {
  if (!(loFreq > 0 && hiFreq > loFreq)) throw new RangeError('need 0 < loFreq < hiFreq');
  if (!(gain > 0 && gain <= 1)) throw new RangeError('gain must be in (0, 1]');
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `anoisesrc=color=pink:sample_rate=${sampleRate}:amplitude=1`,
    '-af', `highpass=f=${loFreq},lowpass=f=${hiFreq},volume=${gain}`,
    '-f', 'alsa',
    alsaDevice,
  ];
}
