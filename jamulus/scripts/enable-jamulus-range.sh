#!/usr/bin/env bash
set -euo pipefail

# Enable and start Jamulus servers on ports 22000–22010
for port in {22000..22010}; do
  echo "Enabling Jamulus server on port ${port}"
  sudo systemctl enable --now "jamulus@${port}.service"
done

