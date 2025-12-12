#!/usr/bin/env bash
set -euo pipefail

for port in {22000..22010}; do
  echo "Disabling Jamulus server on port ${port}..."
  sudo systemctl disable --now "jamulus@${port}.service" || true
done

