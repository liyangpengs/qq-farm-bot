#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PID_FILE="$SCRIPT_DIR/app_dev.pid"
LOG_FILE="$SCRIPT_DIR/app_dev.log"

cd "$SCRIPT_DIR"

die() {
    echo "start.sh: $*" >&2
    exit 1
}

run_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        pnpm "$@"
    elif command -v corepack >/dev/null 2>&1; then
        corepack pnpm "$@"
    else
        die "pnpm or corepack is required."
    fi
}

is_our_process() {
    local pid="$1"
    local process_dir=""
    local command_line=""

    kill -0 "$pid" 2>/dev/null || return 1

    if [[ -e "/proc/$pid/cwd" ]]; then
        process_dir="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
        [[ -z "$process_dir" || "$process_dir" == "$SCRIPT_DIR" ]] || return 1
    fi

    if [[ -r "/proc/$pid/cmdline" ]]; then
        command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    fi
    [[ "$command_line" == *"core/client.js"* || "$command_line" == *"core/dist"* ]]
}

if [[ -f "$PID_FILE" ]]; then
    existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && is_our_process "$existing_pid"; then
        echo "qq-farm-bot is already running with PID $existing_pid."
        exit 0
    fi
    rm -f -- "$PID_FILE"
fi

command -v node >/dev/null 2>&1 || die "node is required."

if [[ ! -d "$SCRIPT_DIR/core/node_modules" || ! -d "$SCRIPT_DIR/web/node_modules" ]]; then
    echo "Installing workspace dependencies..."
    run_pnpm install --frozen-lockfile
fi

echo "Building Web and Core..."
run_pnpm run build

if [[ ! -f "$SCRIPT_DIR/core/client.js" ]]; then
    die "Build completed but core/client.js was not generated."
fi

: > "$LOG_FILE"
if command -v setsid >/dev/null 2>&1; then
    nohup setsid node "$SCRIPT_DIR/core/client.js" >> "$LOG_FILE" 2>&1 &
else
    nohup node "$SCRIPT_DIR/core/client.js" >> "$LOG_FILE" 2>&1 &
fi

app_pid="$!"
printf '%s\n' "$app_pid" > "$PID_FILE"

sleep 1
if ! is_our_process "$app_pid"; then
    echo "qq-farm-bot failed to start. Last log output:" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    rm -f -- "$PID_FILE"
    exit 1
fi

echo "Started qq-farm-bot with PID $app_pid."
echo "Logs: $LOG_FILE"
