 #!/bin/bash
 npm run clean;
 npm run build;
 npm run deploy:local;
 cd /home/trussal-video/Trussal/docker-jitsi-meet;
 docker compose build --no-cache web && docker compose rm -sf web && docker compose up -d web;
 docker compose build --no-cache latency && docker compose rm -sf latency && docker compose up -d latency;
 docker compose down && docker compose up -d;
