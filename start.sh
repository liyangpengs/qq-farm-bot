#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

command -v node >/dev/null 2>&1 || {
    echo "start.sh: node is required." >&2
    exit 1
}

exec node "$SCRIPT_DIR/tools/service-control.mjs" start "$@"
