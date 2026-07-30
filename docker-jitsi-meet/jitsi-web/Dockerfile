# Docker only substitutes ARGs declared BEFORE the FROM. Without this line the
# expression below collapses to its literal default whatever .env or compose
# say, which is how web ended up on `stable` (2026-06-08) while prosody, jicofo
# and jvb ran `unstable` images cached from 2026-05-07. docker-compose.yml
# passes this through as a build arg so all four move together.
ARG JITSI_IMAGE_VERSION=stable-11031
FROM jitsi/web:${JITSI_IMAGE_VERSION}

# Images
COPY trussal-watermark.svg   /usr/share/jitsi-meet/images/trussal-watermark.svg
COPY favicon.ico             /usr/share/jitsi-meet/images/favicon.ico
COPY welcome-background.png  /usr/share/jitsi-meet/images/welcome-background.png

# Translations (English)
COPY main.json /usr/share/jitsi-meet/lang/main.json
COPY main.json /usr/share/jitsi-meet/lang/main-enGB.json
# Title / meta tags
COPY title.html /usr/share/jitsi-meet/title.html
# CSS overrides (already working for you)
COPY custom.css /tmp/custom.css
RUN cat /tmp/custom.css >> /usr/share/jitsi-meet/css/all.css
COPY latency-worklet-v2.js     /usr/share/jitsi-meet/latency-worklet-v2.js
COPY jamulus-relay-player.js   /usr/share/jitsi-meet/jamulus-relay-player.js
COPY custom-config.js /usr/share/jitsi-meet/custom-config.js
# Strudel's SharedWorker is loaded from this path relative to custom-config.js
COPY assets /usr/share/jitsi-meet/assets

# **Patch the React bundle fallback strings**
RUN sed -i \
  -e 's|"headerTitle":"Jitsi Meet"|"headerTitle":"Trussal"|' \
  -e 's|"headerSubtitle":"Secure and high quality meetings"|"headerSubtitle":"   "|' \
  /usr/share/jitsi-meet/libs/app.bundle.min.js

