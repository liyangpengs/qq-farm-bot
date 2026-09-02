#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PID_FILE="$SCRIPT_DIR/app_dev.pid"
LOG_FILE="$SCRIPT_DIR/app_dev.log"
INSTALL_STAMP="$SCRIPT_DIR/node_modules/.qq-farm-install-stamp"
WEB_OUTPUT="$SCRIPT_DIR/web/dist/index.html"
CORE_OUTPUT="$SCRIPT_DIR/core/client.js"
CORE_RUNTIME_OUTPUT="$SCRIPT_DIR/core/dist/runtime/runtime-engine.js"
FORCE_BUILD=0

cd "$SCRIPT_DIR"

die() {
    echo "start.sh: $*" >&2
    exit 1
}

usage() {
    echo "Usage: bash start.sh [--rebuild]"
    echo "  --rebuild  Force a full Web and Core rebuild before starting."
}

run_pnpm() {
    if command -v corepack >/dev/null 2>&1; then
        corepack pnpm "$@"
    elif command -v pnpm >/dev/null 2>&1; then
        pnpm "$@"
    else
        die "pnpm or corepack is required."
    fi
}

has_newer_input() {
    local output="$1"
    shift
    local input=""

    [[ -e "$output" ]] || return 0
    for input in "$@"; do
        [[ -e "$input" ]] || continue
        if find "$input" -type f -newer "$output" -print -quit 2>/dev/null | grep -q .; then
            return 0
        fi
    done
    return 1
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

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rebuild|--force-build)
            FORCE_BUILD=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "unknown option: $1"
            ;;
    esac
    shift
done

if [[ -f "$PID_FILE" ]]; then
    existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && is_our_process "$existing_pid"; then
        echo "qq-farm-bot is already running with PID $existing_pid."
        exit 0
    fi
    rm -f -- "$PID_FILE"
fi

command -v node >/dev/null 2>&1 || die "node is required."

dependency_inputs=(
    "$SCRIPT_DIR/package.json"
    "$SCRIPT_DIR/pnpm-lock.yaml"
    "$SCRIPT_DIR/pnpm-workspace.yaml"
    "$SCRIPT_DIR/core/package.json"
    "$SCRIPT_DIR/web/package.json"
)

if [[ ! -d "$SCRIPT_DIR/core/node_modules" \
    || ! -d "$SCRIPT_DIR/web/node_modules" \
    || ! -f "$INSTALL_STAMP" ]] \
    || has_newer_input "$INSTALL_STAMP" "${dependency_inputs[@]}"; then
    echo "Installing workspace dependencies..."
    run_pnpm install --frozen-lockfile
    touch "$INSTALL_STAMP"
fi

web_inputs=(
    "$SCRIPT_DIR/web/src"
    "$SCRIPT_DIR/web/public"
    "$SCRIPT_DIR/web/index.html"
    "$SCRIPT_DIR/web/package.json"
    "$SCRIPT_DIR/web/tsconfig.json"
    "$SCRIPT_DIR/web/tsconfig.app.json"
    "$SCRIPT_DIR/web/tsconfig.node.json"
    "$SCRIPT_DIR/web/uno.config.ts"
    "$SCRIPT_DIR/web/vite.config.ts"
    "$SCRIPT_DIR/core/package.json"
    "$SCRIPT_DIR/package.json"
    "$SCRIPT_DIR/pnpm-lock.yaml"
    "$SCRIPT_DIR/pnpm-workspace.yaml"
)

core_inputs=(
    "$SCRIPT_DIR/core/src"
    "$SCRIPT_DIR/core/client.ts"
    "$SCRIPT_DIR/core/package.json"
    "$SCRIPT_DIR/core/tsconfig.json"
    "$SCRIPT_DIR/core/tsconfig.client.json"
    "$SCRIPT_DIR/package.json"
    "$SCRIPT_DIR/pnpm-lock.yaml"
    "$SCRIPT_DIR/pnpm-workspace.yaml"
)

build_web=0
build_core=0

if [[ "$FORCE_BUILD" -eq 1 ]] || has_newer_input "$WEB_OUTPUT" "${web_inputs[@]}"; then
    build_web=1
fi
if [[ "$FORCE_BUILD" -eq 1 \
    || ! -f "$CORE_RUNTIME_OUTPUT" ]] \
    || has_newer_input "$CORE_OUTPUT" "${core_inputs[@]}"; then
    build_core=1
fi

if [[ "$build_web" -eq 1 ]]; then
    echo "Building Web..."
    run_pnpm -C "$SCRIPT_DIR/web" run build
else
    echo "Web build is up to date; skipping."
fi

if [[ "$build_core" -eq 1 ]]; then
    echo "Building Core..."
    run_pnpm -C "$SCRIPT_DIR/core" run build:ts
else
    echo "Core build is up to date; skipping."
fi

if [[ ! -f "$CORE_OUTPUT" ]]; then
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
