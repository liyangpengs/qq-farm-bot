#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CONFIRM_DESTROY=0

for arg in "$@"; do
    case "$arg" in
        --yes-destroy-workspace)
            CONFIRM_DESTROY=1
            ;;
        -h|--help)
            echo "Usage: bash clean.sh --yes-destroy-workspace"
            echo "Removes everything in the project directory except .git."
            echo "Refuses to run when any session-host, backend, or deploy lock/process is active."
            exit 0
            ;;
        *)
            echo "clean.sh: unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

# This command is intentionally destructive. Verify the project marker so an
# accidental invocation cannot remove an arbitrary directory.
if [[ "$SCRIPT_DIR" == "/" || ! -f "$SCRIPT_DIR/package.json" ]] \
    || ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"qq-farm-bot-ui"' "$SCRIPT_DIR/package.json"; then
    echo "Refusing to clean: $SCRIPT_DIR is not the qq-farm-bot project root." >&2
    exit 1
fi

RUNTIME_DIR="${FARM_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOCK_OR_PID_FILES=(
    "$SCRIPT_DIR/app_dev.pid"
    "$RUNTIME_DIR/session-host.lock"
    "$RUNTIME_DIR/backend-writer.lock"
    "$RUNTIME_DIR/deploy-operation.lock"
    "$RUNTIME_DIR/session-host.pid"
    "$RUNTIME_DIR/backend.pid"
)

for marker in "${LOCK_OR_PID_FILES[@]}"; do
    if [[ -e "$marker" ]]; then
        echo "Refusing to clean: active runtime lock or PID marker found ($marker)." >&2
        echo "Stop all services first with \`bash ./stop.sh all\`." >&2
        exit 1
    fi
done

if [[ -f "$RUNTIME_DIR/backend-children.json" ]] && ! node -e \
    'process.exit(require(process.argv[1]).listAliveBackendChildren(process.argv[2]).length ? 1 : 0)' \
    "$SCRIPT_DIR/packages/session-contract/dist/index.js" "$RUNTIME_DIR/backend-children.json"; then
    echo "Refusing to clean: could not confirm that all registered backend workers have stopped." >&2
    exit 1
fi

if command -v node >/dev/null 2>&1 \
    && [[ -f "$SCRIPT_DIR/packages/session-contract/dist/index.js" ]] \
    && node "$SCRIPT_DIR/tools/service-control.mjs" host-healthcheck >/dev/null 2>&1; then
    echo "Refusing to clean: session-host IPC is currently active." >&2
    exit 1
fi

if [[ "$CONFIRM_DESTROY" -ne 1 ]]; then
    echo "Refusing destructive workspace wipe without --yes-destroy-workspace." >&2
    exit 1
fi

echo "Removing everything in $SCRIPT_DIR except .git ..."

# Only direct children are selected. .git is explicitly excluded and the
# worktree directory itself is never passed to rm.
find "$SCRIPT_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf -- {} +

echo "Clean complete. The .git entry was preserved when present."
