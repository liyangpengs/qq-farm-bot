#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# This command is intentionally destructive. Verify the project marker so an
# accidental invocation cannot remove an arbitrary directory.
if [[ "$SCRIPT_DIR" == "/" || ! -f "$SCRIPT_DIR/package.json" ]] \
    || ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"qq-farm-bot-ui"' "$SCRIPT_DIR/package.json"; then
    echo "Refusing to clean: $SCRIPT_DIR is not the qq-farm-bot project root." >&2
    exit 1
fi

if [[ -f "$SCRIPT_DIR/app_dev.pid" ]]; then
    if [[ ! -f "$SCRIPT_DIR/stop.sh" ]]; then
        echo "Refusing to clean: app_dev.pid exists but stop.sh is missing." >&2
        exit 1
    fi
    echo "Stopping qq-farm-bot before cleaning..."
    bash "$SCRIPT_DIR/stop.sh"
fi

echo "Removing everything in $SCRIPT_DIR except .git ..."

# Only direct children are selected. .git is explicitly excluded and the
# worktree directory itself is never passed to rm.
find "$SCRIPT_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf -- {} +

echo "Clean complete. The .git entry was preserved when present."
