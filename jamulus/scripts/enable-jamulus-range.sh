#!/usr/bin/env bash
set -euo pipefail

echo "Starting Master Directory on port 22000..."
sudo mkdir -p "/home/trussal-audio/recordings/22000"
sudo systemctl enable "jamulus@22000.service"
sudo systemctl restart "jamulus@22000.service"

echo "Waiting for directory to stabilize..."
sleep 5

# Enable and start Jamulus servers on ports 22000–22010
for port in {22001..22010}; do
  echo "Enabling Jamulus server on port ${port}"
  sudo mkdir -p "/home/trussal-audio/recordings/${port}"
  sudo systemctl enable "jamulus@${port}.service"
  sudo systemctl restart "jamulus@${port}.service"
done

echo "Fixing permissions..."
sudo chown -R trussal-audio:trussal-audio /home/trussal-audio/recordings/

echo "All 11 servers are now initializing"

