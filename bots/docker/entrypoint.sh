#!/usr/bin/env bash
# Bot container boot.
#
# 1. Generate /etc/asound.conf for THIS bot: containers run host-networked
#    and share the host's /dev/snd, so "its own virtual loopback device"
#    means its own subdevice of the host's snd-aloop cards. The host loads
#    two cards at fixed indexes (modprobe snd-aloop enable=1,1 index=10,11
#    pcm_substreams=8,8); bot N claims card 10 sub N, or card 11 sub N-8.
#    Default playback = the loopback, so Chromium's Strudel audio and the
#    ffmpeg bed land on the cable with no per-app config; Jamulus captures
#    the other end. (Strudel audio also leaves the bot a second way: the page
#    taps it into the bot's now-unmuted Jitsi mic — see page-scripts.js.)
# 2. Xvfb before Chromium — with --enable-webgl/--ignore-gpu-blocklist,
#    Chromium aborts without a display even when headless.
# 3. exec the Node driver last, which spawns Chromium, ffmpeg and Jamulus so
#    one container stop (the conductor's replace policy) kills everything.
set -euo pipefail

: "${BOT_ID:?BOT_ID env var is required}"
BOT_ROLE="${BOT_ROLE:-player}"

# Bring up an Xvfb display for this bot. Host networking shares the network
# namespace, so every bot needs a UNIQUE display number (X11's abstract socket
# collides otherwise) — derived from BOT_ID.
start_xvfb() {
  export DISPLAY=":$((99 + BOT_ID))"
  Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp &
  XVFB_PID=$!
  for _ in $(seq 1 50); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
}

# The aggregator makes no sound of its own: no ALSA loopback, no ffmpeg bed, no
# jackd/Jamulus (its BOT_ID isn't even a valid loopback subdevice). It only
# needs a display for Chromium's WebGL — it taps every participant's Jitsi
# <audio> in-page and will stream the assembled mix back.
if [ "$BOT_ROLE" = "aggregator" ]; then
  start_xvfb
  trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT
  exec node /app/src/bot/index.js
fi

if [ "$BOT_ID" -lt 8 ]; then CARD=10; SUB="$BOT_ID"; else CARD=11; SUB=$((BOT_ID - 8)); fi

# dmix on the playback end: an ALSA hw subdevice is single-open, but TWO
# writers share it here (Chromium's Strudel audio + the ffmpeg bed). dmix
# mixes them in software. ipc_key must be unique per bot or containers on
# the same host would attach to each other's mixer shm.
cat > /etc/asound.conf <<EOF
pcm.botmix {
    type dmix
    ipc_key $((5000 + BOT_ID))
    slave {
        pcm "hw:${CARD},0,${SUB}"
        rate 48000
        # snd-aloop forces both ends of a subdevice to share hw params.
        # The clock-keeper opens this dmix FIRST, so S16_LE/48k here is
        # what the whole subdevice (including jackd's capture end) locks
        # to — a mismatch surfaces as "requested or auto-format is not
        # available" and EIO.
        format S16_LE
        period_size 256
        periods 4
    }
}
pcm.!default {
    type plug
    slave.pcm "botmix"
}
ctl.!default {
    type hw
    card ${CARD}
}
EOF

export ALSA_PLAYBACK_DEVICE="default"

# CLOCK-KEEPER — must start BEFORE jackd. An snd-aloop capture end has no
# clock until something writes to its playback end; if jackd opens the
# capture side of a silent loopback, its engine freezes waiting for data
# and every JACK client (Jamulus!) hangs forever in the registration
# handshake. This permanent silent writer opens dmix first (deterministically
# locking S16_LE/48k for the whole subdevice) and keeps the clock running
# for the container's lifetime; being silence, it mixes into the bed and
# Strudel audio at no cost.
ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=48000:cl=stereo -f alsa default &
CLOCK_PID=$!
sleep 1

# Jamulus on Linux talks JACK, not ALSA directly: run a per-container jackd
# (jackd2 — jackd1's engine wedges on this topology) whose capture side is
# this bot's loopback capture end, so Jamulus transmits exactly what
# Chromium/ffmpeg played onto the cable. No -S: the clock-keeper already
# locked the subdevice to S16_LE, and jackd2's plug layer adapts (jackd1's
# -S produced big-endian and failed to start).
#
# CAPTURE-ONLY (-C without -P): jackd must not touch the playback end — that
# belongs to Chromium/ffmpeg via dmix, and a second opener gets "Device or
# resource busy". Jamulus's output (the server's return mix) ends up on
# unconnected JACK ports and is discarded by design: bots send, never
# listen, which also prevents a feedback loop of the bot re-transmitting
# the mix it receives.
jackd -d alsa -C "plughw:${CARD},1,${SUB}" -r 48000 -p 256 &
JACK_PID=$!

# Xvfb last (see start_xvfb): with --enable-webgl/--ignore-gpu-blocklist,
# Chromium aborts without a display even when headless.
start_xvfb

trap 'kill "$XVFB_PID" "$JACK_PID" "$CLOCK_PID" 2>/dev/null || true' EXIT

exec node /app/src/bot/index.js
