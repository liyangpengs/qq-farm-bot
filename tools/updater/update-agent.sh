#!/usr/bin/env bash
# Watches the panel's data volume for update requests and runs the host-side
# updater. Triggered by qq-farm-bot-update-agent.path / .timer (every minute).
set -Eeuo pipefail

DATA=${DATA:-/var/lib/docker/volumes/qq-farm-data/_data}
OPS=${OPS:-/opt/qq-farm-bot-ops}
LOG=${LOG:-/var/log/qq-farm-bot-update.log}
LOCK=${LOCK:-/run/qq-farm-bot-update-agent.lock}

exec 9>"$LOCK"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

if [ -f "$DATA/update-check-request" ]; then
    rm -f "$DATA/update-check-request"
    log "panel requested an update check"
    "$OPS/update-check.sh" >>"$LOG" 2>&1 || log "check failed"
fi

if [ -f "$DATA/update-request.json" ]; then
    mv -f "$DATA/update-request.json" "$DATA/update-request.processing.json" 2>/dev/null || true
    log "panel requested an update"
    if ! "$OPS/update-apply.sh" >>"$LOG" 2>&1; then
        log "panel-triggered update failed"
    fi
    rm -f "$DATA/update-request.processing.json"
fi
