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

# Session dirs a running Jamulus server still has open. Deleting one of these
# does NOT reclaim space — the kernel keeps its blocks allocated until the
# process closes the fd (so `df` stays full while `du` shows it gone) — and it
# corrupts an in-progress recording. An already-unlinked open file reports its
# path as "<path> (deleted)", so we strip that suffix to still recognise a
# session that a previous (buggy) run half-deleted. Emits one session dir per
# line; may be empty.
sessions_in_use() {
    local pid fd tgt
    for pid in $(pgrep jamulus 2>/dev/null); do
        for fd in /proc/"$pid"/fd/*; do
            tgt=$(readlink "$fd" 2>/dev/null) || continue
            tgt=${tgt% (deleted)}
            case "$tgt" in
                "$RECORDINGS_DIR"/*/Jam-*/*) dirname "$tgt" ;;
            esac
        done
    done | sort -u
}

usage=$(disk_usage)
if (( usage < THRESHOLD )); then
    exit 0
fi

log "Disk usage at ${usage}% — starting cleanup of $RECORDINGS_DIR"

# All jam session dirs, oldest-first (names are timestamp-based).
mapfile -t sessions < <(
    find "$RECORDINGS_DIR" -mindepth 2 -maxdepth 2 -type d -name 'Jam-*' | sort
)

if (( ${#sessions[@]} == 0 )); then
    log "No session directories found — nothing to delete"
    exit 0
fi

mapfile -t in_use < <(sessions_in_use)
is_in_use() {
    local s=$1 u
    for u in "${in_use[@]:-}"; do
        [[ -n "$u" && "$s" == "$u" ]] && return 0
    done
    return 1
}

deleted=0
skipped=0
for session in "${sessions[@]}"; do
    usage=$(disk_usage)
    if (( usage < THRESHOLD )); then
        break
    fi
    if is_in_use "$session"; then
        log "Skipping $session — still open by a running Jamulus server"
        (( skipped++ )) || true
        continue
    fi
    size=$(du -sh "$session" 2>/dev/null | cut -f1)
    rm -rf "$session"
    log "Deleted $session ($size)"
    (( deleted++ )) || true
done

usage=$(disk_usage)
if (( usage >= THRESHOLD )); then
    log "WARNING: still at ${usage}% — every remaining session is in active use. \
Deleting an open recording would not free space; restart jamulus@* (releases the \
held files) or add storage."
fi
log "Done. Removed $deleted session(s), skipped $skipped in-use. Disk usage now at ${usage}%"
