# 面板内更新（可选）

面板自带「检测上游新版本 + 一键更新」的界面，但容器内不做 git / docker 操作：真正拉取代码、构建镜像、重启容器的是宿主机上的更新器 `tools/updater`。不安装更新器时，面板只会提示「尚未检测到宿主机更新器」，其他功能不受影响。

## 架构

```
┌─ 面板容器 ────────────────────────────┐
│ GET  /api/update/status  读 update-status.json      │
│ POST /api/update/check   写 update-check-request     │
│ POST /api/update/apply   写 update-request.json      │
└───────────────┬───────────────────────┘
                │ 共享数据卷 qq-farm-data
┌───────────────┴───────────────────────┐
│ 宿主机更新器                                    │
│ update-check.sh  定时 fetch + 写状态 + Bark 通知  │
│ update-agent.sh  由 .path/.timer 触发，消费请求     │
│ update-apply.sh  快进合并 + 构建 + 重启 + 健康检查  │
└───────────────────────────────────────┘
```

- 状态文件与请求文件都放在容器数据卷里（默认 `/var/lib/docker/volumes/qq-farm-data/_data/`），面板与宿主机通过文件协作。
- 检测结果写入 `update-status.json`（当前版本 / 最新版本 / 落后提交数 / 提交摘要 / 检查时间）。
- 面板「检查更新」写 `update-check-request`，「立即更新」写 `update-request.json`；`qq-farm-bot-update-agent.path` 约 1 秒内触发 `update-agent.sh`，`.timer` 每分钟兜底。

## 前置条件

- 部署目录是 **git checkout** 并跟踪上游（`git clone https://github.com/liyangpengs/qq-farm-bot.git` 或手动 clone 到 `/opt/qq-farm-bot`）。
- 容器名 `qq-farm-bot`、数据卷 `qq-farm-data`（默认 compose 配置即如此）。
- 宿主机有 `python3`、`git`、`docker compose`，并以 root 运行 systemd 单元。

## 安装

```bash
# 1. 复制脚本到宿主机（不要放进容器）
install -d /opt/qq-farm-bot-ops
install -m 755 tools/updater/update-check.sh \
               tools/updater/update-apply.sh \
               tools/updater/update-agent.sh \
               /opt/qq-farm-bot-ops/
install -m 755 tools/updater/update-status.py tools/updater/notify.py /opt/qq-farm-bot-ops/

# 2. 先手动跑一次检查，确认权限与路径正确
/opt/qq-farm-bot-ops/update-check.sh
cat /var/lib/docker/volumes/qq-farm-data/_data/update-status.json

# 3. 安装 systemd 单元
install -m 644 tools/updater/systemd/*.service \
               tools/updater/systemd/*.timer \
               tools/updater/systemd/*.path /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qq-farm-bot-update.timer \
                     qq-farm-bot-update-agent.timer \
                     qq-farm-bot-update-agent.path
```

完成后刷新面板：侧栏版本行在检测到新提交时出现「新版本 xxxxxxx」徽标（折叠态为带绿点的下载图标，移动端为设置项绿点），点开即可查看提交摘要并一键更新。

## 配置

所有脚本都读环境变量，systemd 单元会加载 `/etc/qq-farm-bot-updater.env`（可选）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REPO` | `/opt/qq-farm-bot` | 部署目录（git checkout） |
| `OPS` | `/opt/qq-farm-bot-ops` | 更新器脚本目录 |
| `DATA` | `/var/lib/docker/volumes/qq-farm-data/_data` | 容器数据卷在宿主机上的路径 |
| `UPSTREAM_BRANCH` | `master` | 跟踪的上游分支 |
| `AUTO_APPLY` | `0` | 设为 `1` 时，`update-check.sh` 检测到新提交会自动执行 `update-apply.sh` |
| `EXPECTED_BRANCH` | 空 | 设置后要求部署目录处于该分支，否则拒绝更新 |
| `IMAGE` / `ROLLBACK` / `CONTAINER` | `qq-farm-bot:latest` / `qq-farm-bot:rollback` / `qq-farm-bot` | 镜像与容器名 |
| `HEALTH_WAIT_SECONDS` | `150` | 重启后等待健康检查的时长 |
| `MAX_LINES` | `12` | 通知里最多列出的提交数 |
| `NOTIFY_GROUP` | `qq-farm-bot` | Bark 通知分组 |

数据卷路径不同的部署，除了设置 `DATA`，还要同步修改 `qq-farm-bot-update-agent.path` 里的两个 `PathExists=`。

## 通知

默认复用面板「设置 → 下线提醒」里已经配置好的 Bark token（从 `store.json` 读取，不需要额外保存密钥）；未配置 Bark 时静默跳过。`update-check.sh --test-notify` 和 `update-apply.sh --test-notify` 可以手动测试通知链路。

`AUTO_APPLY` 默认关闭：更新会重建容器并短暂中断服务，而微信扫码换来的登录 Code 是一次性的（见 [wechat-connection.md](wechat-connection.md)），更新后通常需要重新扫码。把更新时机留给用户更稳妥；确实需要无人值守时再打开。

## 失败与回滚

`update-apply.sh` 在每一步失败时都会保持旧版本并推送 Bark：

- `git merge --ff-only` 失败（部署目录有本地提交或历史分叉）→ 不改动代码。
- 镜像构建失败 → `git reset --hard` 回退源码。
- 容器启动失败或健康检查超时 → 把上一版镜像重新打回 `IMAGE` 标签并 `docker compose up -d`，然后回退源码。

同一上游提交失败一次后会记录在 `state/failed-sha`，不会每小时重复尝试；上游出现新提交后自动重试。

## 排障

- 日志：`/var/log/qq-farm-bot-update.log`。
- 手动检查：`systemctl start qq-farm-bot-update.service`。
- 手动更新：`/opt/qq-farm-bot-ops/update-apply.sh`。
- 面板一直显示「尚未检测到宿主机更新器」：状态文件不存在或路径不对，先手动跑一次 `update-check.sh` 并检查 `DATA`。
- 面板显示「已是最新版本」但上游明明有新提交：确认 `REPO` 指向的目录确实执行过 `git fetch`，且 `state/deployed-sha` 没有过期（删掉该文件会以当前 HEAD 重新初始化）。

## 安全说明

- 脚本以 root 运行，只执行 `git fetch/merge/reset` 与 `docker compose build/up`；不执行上游代码里的任意新命令。
- 面板侧的三个接口都在管理员鉴权之后；请求文件只被宿主机 agent 消费，写入内容固定为时间戳。
- 通知只读取面板自己的 Bark 配置，不额外保存任何密钥。
