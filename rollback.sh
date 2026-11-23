#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

command -v node >/dev/null 2>&1 || {
    echo "rollback.sh: node is required." >&2
    exit 1
}

if [[ ! -f "$SCRIPT_DIR/packages/session-contract/dist/index.js" ]]; then
    echo "rollback.sh: packages/session-contract/dist/index.js not built." >&2
    exit 1
fi

exec node "$SCRIPT_DIR/tools/service-control.mjs" rollback "$@"
