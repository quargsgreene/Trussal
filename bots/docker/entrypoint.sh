#!/usr/bin/env bash
# Bot container boot.
#
# 1. Generate /etc/asound.conf for THIS bot: containers run host-networked
#    and share the host's /dev/snd, so "its own virtual loopback device"
#    means its own subdevice of the host's snd-aloop cards. The host loads
#    two cards at fixed indexes (modprobe snd-aloop enable=1,1 index=10,11
#    pcm_substreams=8,8); bot N claims card 10 sub N, or card 11 sub N-8.
#    A host without them (an unprivileged dev machine — no kernel modules)
#    gets no rig at all: the null device written at the top stands instead of
#    the cards, and jackd is skipped. Nothing is lost — the room hears the
#    bot through the in-page tap (bots/src/bot/page-scripts.js
#    pageAudioBridge), not through the loopback — and that null default keeps
#    EVERY role's browser off a real sound card, the aggregator included.
# 2. Xvfb before Chromium — with --enable-webgl/--ignore-gpu-blocklist,
#    Chromium aborts without a display even when headless.
# 3. exec the Node driver last, which spawns Chromium
set -euo pipefail

: "${BOT_ID:?BOT_ID env var is required}"
BOT_ROLE="${BOT_ROLE:-player}"

# Playback defaults to a silent null device for EVERY role, before any of the
# branching below. Nothing in the fleet should ever emit host audio — the room
# hears bots through their in-page tap — and a container sharing the host's
# /dev/snd must never fall through to a real card (on a dev machine, the
# speakers!). The player rig below overwrites this only when snd-aloop cards
# exist to claim; the aggregator branch keeps it. Chromium itself is never
# pointed at this device: without ALSA_PLAYBACK_DEVICE (exported only by the
# rig) it launches with --disable-audio-output, because playout into `null`
# runs free and wrecks WebRTC receive (see chromium-args.js).
cat > /etc/asound.conf <<EOF
pcm.!default {
    type null
}
EOF

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

# The aggregator makes no sound of its own — it stays on the null default
# written above and must never render the room to a real card — but it needs
# a display for Chromium's WebGL: it taps every participant's Jitsi <audio>
# in-page and will stream the assembled mix back.
if [ "$BOT_ROLE" = "aggregator" ]; then
  start_xvfb
  trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT
  exec node /repo/bots/src/bot/index.js
fi

if [ "$BOT_ID" -lt 8 ]; then CARD=10; SUB="$BOT_ID"; else CARD=11; SUB=$((BOT_ID - 8)); fi

JACK_PID=""
if aplay -l 2>/dev/null | grep -qi loopback; then

# dmix on the playback end: an ALSA hw subdevice is single-open, but TWO
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
# and every JACK client hangs forever in the registration
# handshake. This permanent silent writer opens dmix first (deterministically
# locking S16_LE/48k for the whole subdevice) and keeps the clock running
# for the container's lifetime; being silence, it mixes into the bed and
# Strudel audio at no cost.
sleep 1
#
# CAPTURE-ONLY (-C without -P): jackd must not touch the playback end — that
jackd -d alsa -C "plughw:${CARD},1,${SUB}" -r 48000 -p 256 &
JACK_PID=$!

# A host without the snd-aloop cards skips this whole rig: the null default
# written at the top of the file stands (silent playback), and jackd is
# skipped — with no loopback subdevice there is nothing for it to capture.
fi

# Xvfb last (see start_xvfb): with --enable-webgl/--ignore-gpu-blocklist,
# Chromium aborts without a display even when headless.
start_xvfb

trap 'kill "$XVFB_PID" $JACK_PID 2>/dev/null || true' EXIT

exec node /repo/bots/src/bot/index.js
