# Docker only substitutes ARGs declared BEFORE the FROM. Without this line the
# expression below collapses to its literal default whatever .env or compose
# say, which is how web ended up on `stable` (2026-06-08) while prosody, jicofo
# and jvb ran `unstable` images cached from 2026-05-07. docker-compose.yml
# passes this through as a build arg so all four move together.
ARG JITSI_IMAGE_VERSION=stable-11031
FROM jitsi/web:${JITSI_IMAGE_VERSION}

# The static-asset cache-bust string (see the RUN below). run.sh passes the git
# commit so EVERY shard of a rack that builds the same commit stamps the SAME
# `?v=` — identical bytes at identical URLs, so an edge LB may serve
# `/custom-config.js` from any shard and Cloudflare caches it once. Falls back
# to a per-build timestamp when unset (a manual `docker build`).
ARG ASSET_VERSION=

# Images. Trussal's own page shell (index.html, below) replaces the Jitsi web
# app's, so the app's branding assets are no longer shipped: its translations
# (main.json), its <title> fragment (title.html), the watermark it drew during
# calls, and the welcome-page background are all never loaded, and the app's
# custom.css was never COPY'd here at all. Only the favicon is kept (browsers
# still request /favicon.ico), alongside the latency worklet Trussal fetches.
COPY favicon.ico             /usr/share/jitsi-meet/images/favicon.ico

COPY latency-worklet-v2.js     /usr/share/jitsi-meet/latency-worklet-v2.js
COPY custom-config.js /usr/share/jitsi-meet/custom-config.js
# Strudel's SharedWorker is loaded from this path relative to custom-config.js
COPY assets /usr/share/jitsi-meet/assets
# Optional pinned lib-jitsi-meet (see build-lib-jitsi.mjs / build.mjs).
# deploy:local always creates this dir before the build; an empty one is a
# no-op, so the Jitsi image's own /libs/lib-jitsi-meet.min.js stays in place. A
# supplied bundle merges over just that file. Since the Jitsi web app is no
# longer loaded, the Trussal loader is the only consumer of
# /libs/lib-jitsi-meet.min.js.
COPY libs /usr/share/jitsi-meet/libs

# Trussal's own page shell replaces the Jitsi web app's index.html. The web app
# bundle is never loaded, so there is no native prejoin/UI to inject over and
# nothing that could join a second conference; lib-jitsi-meet is the only client.
COPY index.html /usr/share/jitsi-meet/index.html
COPY page.css   /usr/share/jitsi-meet/page.css

# Per-build cache-bust for the assets a Trussal deploy actually changes. The
# shell references `/custom-config.js?v=__ASSET_VERSION__` and
# `/page.css?v=__ASSET_VERSION__`, so stamping the build id in makes Cloudflare's
# edge cache (per POP, keyed on the exact URL) and the browser fetch fresh URLs
# with no manual purge. run.sh builds web with --no-cache so `date` re-runs every
# deploy.
RUN BID="${ASSET_VERSION:-$(date +%Y%m%d%H%M%S)}" && \
    sed -i -E "s#__ASSET_VERSION__#${BID}#g" /usr/share/jitsi-meet/index.html

