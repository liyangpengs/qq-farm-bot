#!/usr/bin/env bash
# Fast-forward the deployed checkout to upstream and rebuild the container.
# - Does nothing (and sends no notification) when already up to date.
# - Keeps the previous image as qq-farm-bot:rollback and reverts on failure.
# - Sends a Bark message on success and on every failed update.
# Requires REPO to be a clean git checkout tracking UPSTREAM_BRANCH.
set -Eeuo pipefail

REPO=${REPO:-/opt/qq-farm-bot}
OPS=${OPS:-/opt/qq-farm-bot-ops}
STATE=${STATE:-$OPS/state}
LOG=${LOG:-/var/log/qq-farm-bot-update.log}
IMAGE=${IMAGE:-qq-farm-bot:latest}
ROLLBACK=${ROLLBACK:-qq-farm-bot:rollback}
CONTAINER=${CONTAINER:-qq-farm-bot}
NOTIFY=${NOTIFY:-$OPS/notify.py}
UPSTREAM_BRANCH=${UPSTREAM_BRANCH:-master}
EXPECTED_BRANCH=${EXPECTED_BRANCH:-}
HEALTH_WAIT_SECONDS=${HEALTH_WAIT_SECONDS:-150}
FAILED_SHA_FILE=$STATE/failed-sha
LOCK=${LOCK:-/run/qq-farm-bot-update.lock}

COMPOSE=(docker compose -f "$REPO/docker-compose.yml")
[ -f "$REPO/docker-compose.override.yml" ] && COMPOSE+=(-f "$REPO/docker-compose.override.yml")

mkdir -p "$STATE"
exec 9>"$LOCK"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }
notify() {
    [ -f "$NOTIFY" ] || return 0
    local rc=0
    python3 "$NOTIFY" "$1" "$2" >>"$LOG" 2>&1 || rc=$?
    # 2 = no Bark settings in the panel; notification is optional.
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then
        log "bark notify failed: $1 / $2"
    fi
}
set_status() { python3 "$OPS/update-status.py" "$@" >>"$LOG" 2>&1 || true; }

health_status() {
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing
}

wait_healthy() {
    local i status
    for i in $(seq 1 $((HEALTH_WAIT_SECONDS / 5))); do
        status=$(health_status)
        # "running" covers deployments without a healthcheck; when one is
        # defined the template returns healthy/starting/unhealthy instead.
        [ "$status" = "healthy" ] && return 0
        [ "$status" = "running" ] && return 0
        sleep 5
    done
    return 1
}

rollback() {
    local reason=$1
    log "rolling back: $reason"
    docker tag "$ROLLBACK" "$IMAGE" >>"$LOG" 2>&1 || true
    "${COMPOSE[@]}" up -d >>"$LOG" 2>&1 || true
    if wait_healthy; then
        log "rollback healthy"
    else
        log "rollback did not become healthy"
    fi
    git -C "$REPO" reset --hard "$PREV" >>"$LOG" 2>&1 || true
}

if [ "${1:-}" = "--test-notify" ]; then
    python3 "$NOTIFY" "QQ农场自动更新" "通知链路测试：脚本已启用，之后仅在更新成功或失败时推送。"
    exit $?
fi

cd "$REPO"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ -n "$EXPECTED_BRANCH" ] && [ "$BRANCH" != "$EXPECTED_BRANCH" ]; then
    log "current branch is $BRANCH, expected $EXPECTED_BRANCH; refusing to update"
    notify "QQ农场自动更新失败" "部署目录当前分支是 ${BRANCH},不是 ${EXPECTED_BRANCH},已拒绝更新。"
    exit 1
fi

if ! git fetch --quiet origin "$UPSTREAM_BRANCH" >>"$LOG" 2>&1; then
    log "git fetch failed, skip this round"
    exit 1
fi

PREV=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$UPSTREAM_BRANCH")

if git merge-base --is-ancestor "$REMOTE" HEAD; then
    log "no update (origin/$UPSTREAM_BRANCH ${REMOTE:0:7} already included)"
    set_status --state idle --step done --has-update false --checked-at "$(date +%s%3N)" --message "已是最新版本"
    exit 0
fi

if [ -f "$FAILED_SHA_FILE" ] && [ "$(cat "$FAILED_SHA_FILE" 2>/dev/null)" = "$REMOTE" ]; then
    log "commit ${REMOTE:0:7} previously failed, waiting for a newer upstream commit"
    exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "tracked files modified locally, refusing to update"
    notify "QQ农场自动更新失败" "本地有未提交改动，已跳过 ${REMOTE:0:7}，请登录服务器处理。"
    exit 1
fi

log "update ${PREV:0:7} -> ${REMOTE:0:7}"
set_status --state running --step prepare --message "准备更新到 ${REMOTE:0:7}"
docker tag "$IMAGE" "$ROLLBACK" >>"$LOG" 2>&1 || log "no previous image to tag"

if ! git merge --ff-only "$REMOTE" >>"$LOG" 2>&1; then
    log "fast-forward merge failed (local commits or diverged history?)"
    git reset --hard "$PREV" >>"$LOG" 2>&1 || true
    echo "$REMOTE" >"$FAILED_SHA_FILE"
    notify "QQ农场自动更新失败" "部署目录无法快进到上游，已保持旧版本运行。commit ${REMOTE:0:7}"
    set_status --state failed --step prepare --message "部署目录与上游分叉，无法快进更新"
    exit 1
fi

set_status --state running --step build --message "正在构建 ${REMOTE:0:7}"
if ! "${COMPOSE[@]}" build >>"$LOG" 2>&1; then
    log "image build failed"
    git reset --hard "$PREV" >>"$LOG" 2>&1 || true
    echo "$REMOTE" >"$FAILED_SHA_FILE"
    notify "QQ农场自动更新失败" "镜像构建失败，已保持旧版本运行。commit ${REMOTE:0:7}"
    set_status --state failed --step build --message "镜像构建失败，已保持旧版本"
    exit 1
fi

set_status --state running --step restart --message "正在重启容器"
if ! "${COMPOSE[@]}" up -d >>"$LOG" 2>&1; then
    rollback "docker compose up failed"
    echo "$REMOTE" >"$FAILED_SHA_FILE"
    notify "QQ农场自动更新失败" "容器启动失败，已回滚旧版本。commit ${REMOTE:0:7}"
    set_status --state failed --step restart --message "容器启动失败，已回滚旧版本"
    exit 1
fi

set_status --state running --step health --message "等待健康检查"
if ! wait_healthy; then
    rollback "health check timeout"
    echo "$REMOTE" >"$FAILED_SHA_FILE"
    notify "QQ农场自动更新失败" "新版本健康检查未通过，已回滚旧版本。commit ${REMOTE:0:7}"
    set_status --state failed --step health --message "健康检查未通过，已回滚旧版本"
    exit 1
fi

rm -f "$FAILED_SHA_FILE"
DEPLOYED=$(git rev-parse HEAD)
echo "$DEPLOYED" >"$STATE/deployed-sha"
set_status --state success --step done --deployed "$DEPLOYED" --deployed-short "${DEPLOYED:0:7}" \
    --latest "$REMOTE" --latest-short "${REMOTE:0:7}" --behind 0 --has-update false \
    --checked-at "$(date +%s%3N)" --message "已更新到 ${REMOTE:0:7}"
docker image prune -f >>"$LOG" 2>&1 || true
SUM=$(git log -1 --format='%h %ad %s' --date=short)
log "update ok: $SUM"
notify "QQ农场已自动更新" "版本 ${REMOTE:0:7} 已上线并运行正常。$SUM"
exit 0
