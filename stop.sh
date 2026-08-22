#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PID_FILE="$SCRIPT_DIR/app_dev.pid"

cd "$SCRIPT_DIR"

if [[ ! -f "$PID_FILE" ]]; then
    echo "qq-farm-bot is not running."
    exit 0
fi

app_pid="$(tr -d '[:space:]' < "$PID_FILE")"
if [[ ! "$app_pid" =~ ^[0-9]+$ ]]; then
    echo "Invalid PID file; removing it." >&2
    rm -f -- "$PID_FILE"
    exit 1
fi

if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "qq-farm-bot is not running; removing stale PID file."
    rm -f -- "$PID_FILE"
    exit 0
fi

process_dir=""
if [[ -e "/proc/$app_pid/cwd" ]]; then
    process_dir="$(readlink -f "/proc/$app_pid/cwd" 2>/dev/null || true)"
    if [[ -n "$process_dir" && "$process_dir" != "$SCRIPT_DIR" ]]; then
        echo "Refusing to stop PID $app_pid: working directory is $process_dir." >&2
        exit 1
    fi
fi

command_line=""
if [[ -r "/proc/$app_pid/cmdline" ]]; then
    command_line="$(tr '\0' ' ' < "/proc/$app_pid/cmdline" 2>/dev/null || true)"
fi
if [[ "$command_line" != *"core/client.js"* && "$command_line" != *"core/dist"* ]]; then
    echo "Refusing to stop PID $app_pid: it is not a qq-farm-bot process." >&2
    exit 1
fi

process_group="$(ps -o pgid= -p "$app_pid" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$process_group" == "$app_pid" ]]; then
    kill -TERM -- "-$app_pid" 2>/dev/null || true
else
    kill -TERM "$app_pid" 2>/dev/null || true
fi

for _ in {1..30}; do
    if ! kill -0 "$app_pid" 2>/dev/null; then
        rm -f -- "$PID_FILE"
        echo "Stopped qq-farm-bot."
        exit 0
    fi
    sleep 0.5
done

echo "Graceful shutdown timed out; forcing qq-farm-bot to stop." >&2
if [[ "$process_group" == "$app_pid" ]]; then
    kill -KILL -- "-$app_pid" 2>/dev/null || true
else
    kill -KILL "$app_pid" 2>/dev/null || true
fi

rm -f -- "$PID_FILE"
echo "Stopped qq-farm-bot."
