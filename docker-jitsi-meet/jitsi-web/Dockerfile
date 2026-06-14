FROM jitsi/web:${JITSI_IMAGE_VERSION:-stable}

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

