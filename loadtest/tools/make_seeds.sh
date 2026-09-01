#!/usr/bin/env bash
# make_seeds.sh — fake camera + mic files for Chromium's
# --use-file-for-fake-video-capture / --use-file-for-fake-audio-capture.
# Chromium loops these, so ~20 s is plenty. Moving content keeps the VP8/9
# encoder doing real work (a static frame would understate CPU + bitrate).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/../media/seeds}"
mkdir -p "$OUT"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }

# 320x240@15 is the S-scenario default (config/scenarios.yaml media_profile).
# Add more sizes if a scenario overrides video_height.
for spec in "320x240:15" "640x360:24"; do
  size=${spec%%:*}; fps=${spec##*:}
  f="$OUT/camera_${size/x/x}_${fps}.y4m"
  if [[ -s "$f" ]]; then echo "have $f"; continue; fi
  echo "encoding $f"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=${size}:rate=${fps}" \
    -f lavfi -i "life=size=${size}:rate=${fps}:ratio=0.1" \
    -filter_complex "[0:v][1:v]blend=all_mode=screen,format=yuv420p" \
    -t 20 "$f"
done
ln -sf "camera_320x240_15.y4m" "$OUT/camera.y4m" 2>/dev/null || true

f="$OUT/mic_16k.wav"
if [[ ! -s "$f" ]]; then
  echo "encoding $f"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=220:sample_rate=16000:duration=20" \
    -af "tremolo=f=6:d=0.7,aeval=val(0)*0.6" -ac 1 "$f"
fi
echo "seeds in $OUT:"; ls -la "$OUT"
