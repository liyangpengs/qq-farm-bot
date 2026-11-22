#!/usr/bin/env bash
# Check the deployed checkout against the upstream repository and publish the
# result for the panel (see docs/updater.md). Never pulls, builds or restarts.
# Sends one Bark message per new batch of upstream commits, using the token the
# panel already stores for offline reminders.
# Set AUTO_APPLY=1 to run update-apply.sh when a new commit appears.
set -Eeuo pipefail

REPO=${REPO:-/opt/qq-farm-bot}
OPS=${OPS:-/opt/qq-farm-bot-ops}
STATE=${STATE:-$OPS/state}
LOG=${LOG:-/var/log/qq-farm-bot-update.log}
NOTIFY=${NOTIFY:-$OPS/notify.py}
SEEN_FILE=$STATE/last-notified-sha
LOCK=${LOCK:-/run/qq-farm-bot-update.lock}
UPSTREAM_BRANCH=${UPSTREAM_BRANCH:-master}
MAX_LINES=${MAX_LINES:-12}
AUTO_APPLY=${AUTO_APPLY:-0}

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
        log "bark notify failed: $1"
    fi
}

if [ "${1:-}" = "--test-notify" ]; then
    python3 "$NOTIFY" "QQ农场更新检查" "通知链路测试：仅在检测到上游新提交时推送。"
    exit $?
fi

cd "$REPO"
if ! git fetch --quiet origin "$UPSTREAM_BRANCH" >>"$LOG" 2>&1; then
    log "git fetch failed, skip this round"
    exit 1
fi

REMOTE=$(git rev-parse "origin/$UPSTREAM_BRANCH")

# Keep the panel's status file current even when nothing is notified.
DEPLOYED=$(cat "$STATE/deployed-sha" 2>/dev/null || true)
if [ -z "$DEPLOYED" ]; then
    DEPLOYED=$(git rev-parse HEAD)
    echo "$DEPLOYED" >"$STATE/deployed-sha"
fi
BEHIND=0
COMMITS_FILE=$(mktemp)
if git cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null; then
    BEHIND=$(git rev-list --count "$DEPLOYED..$REMOTE" 2>/dev/null || echo 0)
    git log --no-merges --format='%s' "$DEPLOYED..$REMOTE" 2>/dev/null | cut -c1-160 >"$COMMITS_FILE"
fi
HAS_UPDATE=false
[ "$BEHIND" -gt 0 ] && HAS_UPDATE=true
python3 "$OPS/update-status.py" \
    --checked-at "$(date +%s%3N)" \
    --deployed "$DEPLOYED" --deployed-short "${DEPLOYED:0:7}" \
    --latest "$REMOTE" --latest-short "${REMOTE:0:7}" \
    --behind "$BEHIND" --has-update "$HAS_UPDATE" \
    --commits-file "$COMMITS_FILE" >>"$LOG" 2>&1 || log "failed to write update status"
rm -f "$COMMITS_FILE"

if [ "$HAS_UPDATE" = true ] && [ "$AUTO_APPLY" = "1" ]; then
    log "AUTO_APPLY=1, applying ${REMOTE:0:7}"
    "$OPS/update-apply.sh" >>"$LOG" 2>&1 || log "auto apply failed"
    exit 0
fi

if [ ! -f "$SEEN_FILE" ]; then
    echo "$REMOTE" >"$SEEN_FILE"
    log "initialized last-notified to ${REMOTE:0:7}"
    exit 0
fi

LAST=$(cat "$SEEN_FILE" 2>/dev/null || true)
if [ "$LAST" = "$REMOTE" ]; then
    log "no new upstream commit (${REMOTE:0:7})"
    exit 0
fi

if [ -n "$LAST" ] && git merge-base --is-ancestor "$LAST" "$REMOTE" 2>/dev/null; then
    COUNT=$(git rev-list --count "$LAST..$REMOTE")
    SUBJECTS=$(git log --no-merges --format='• %s' "$LAST..$REMOTE" | cut -c1-120 | head -n "$MAX_LINES")
    SUFFIX=""
    if [ "$COUNT" -gt "$MAX_LINES" ]; then
        SUFFIX=$(printf '\n…其余 %s 个提交未列出' "$((COUNT - MAX_LINES))")
    fi
else
    COUNT=0
    SUBJECTS=$(git log --no-merges --format='• %s' -n "$MAX_LINES" "$REMOTE" | cut -c1-120)
    SUFFIX=$'\n(上游历史被重写,仅列最近 10 条)'
fi

TITLE="QQ农场上游有更新"
[ "$COUNT" -gt 0 ] && TITLE="QQ农场上游有更新（${COUNT} 个提交）"
BODY=$(printf '变更摘要：\n%s%s\n\n可在面板中一键更新（会重建容器，微信账号需要重新扫码）。' "$SUBJECTS" "$SUFFIX")
notify "$TITLE" "$BODY"
echo "$REMOTE" >"$SEEN_FILE"
log "notified upstream update ${LAST:0:7}..${REMOTE:0:7} (${COUNT} commits)"
