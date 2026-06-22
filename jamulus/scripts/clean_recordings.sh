#!/usr/bin/env bash
set -euo pipefail

RECORDINGS_DIR="/home/trussal-audio/recordings"
THRESHOLD=90
LOG="/home/trussal-audio/Trussal/jamulus/scripts/clean_recordings.log"

disk_usage() {
    df --output=pcent / | tail -1 | tr -d ' %'
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

usage=$(disk_usage)
if (( usage < THRESHOLD )); then
    exit 0
fi

log "Disk usage at ${usage}% — starting cleanup of $RECORDINGS_DIR"

# Collect all jam session dirs sorted oldest-first by directory name (names are timestamp-based)
mapfile -t sessions < <(
    find "$RECORDINGS_DIR" -mindepth 2 -maxdepth 2 -type d -name 'Jam-*' | sort
)

if (( ${#sessions[@]} == 0 )); then
    log "No session directories found — nothing to delete"
    exit 0
fi

deleted=0
for session in "${sessions[@]}"; do
    usage=$(disk_usage)
    if (( usage < THRESHOLD )); then
        break
    fi
    size=$(du -sh "$session" 2>/dev/null | cut -f1)
    rm -rf "$session"
    log "Deleted $session ($size)"
    (( deleted++ )) || true
done

usage=$(disk_usage)
log "Done. Removed $deleted session(s). Disk usage now at ${usage}%"
