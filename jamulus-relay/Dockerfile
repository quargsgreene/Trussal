FROM ubuntu:22.04
ARG JAMULUS_TAG=r3_12_0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        jackd2 jack-tools ffmpeg nodejs npm curl wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
    && RELEASE_URL=$(curl -s "https://api.github.com/repos/jamulussoftware/jamulus/releases/tags/${JAMULUS_TAG}" \
         | grep -oP '"browser_download_url":\s*"\K[^"]+' \
         | grep -i 'ubuntu' | grep 'amd64' | grep '\.deb' | grep -iv 'headless' | head -1) \
    && echo "Downloading Jamulus from: $RELEASE_URL" \
    && wget -q "$RELEASE_URL" -O /tmp/jamulus.deb \
    && apt-get install -y --no-install-recommends /tmp/jamulus.deb \
    && rm /tmp/jamulus.deb \
    && rm -rf /var/lib/apt/lists/*

ENV QT_QPA_PLATFORM=offscreen
ENV JACK_NO_AUDIO_RESERVATION=1

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY relay.js ./
EXPOSE 8082
CMD ["node", "relay.js"]
