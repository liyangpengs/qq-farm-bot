# 好友宠物缓存与每日同步

## 背景

好友帮忙有两个相关开关：`friend_help_exp_limit`（帮忙经验满就不再帮）和 `friend_help_protect_dog_ignore_exp_limit`（挂着护主犬的好友即使经验满也继续帮，为的是「同气连枝」礼包）。护主犬是 `dog_id = 90021`。

护主犬只能从 `VisitService.Enter` 回包的 `brief_dog_info.dog_id`（`visitpb.proto` 的 field 3）读到，没有单独的「好友宠物列表」协议。所以早期实现里，帮忙经验一满，每轮好友巡检（20~25 秒一轮）都会把全部待帮好友逐个 `Enter` + `Leave` 试探一遍，而且走的是 `normal` 优先级——网关只给 `normal` 留 2 个并发槽，这会实打实挤压农场主流程。现在这些结论落到缓存里，每天只确认一轮。

## 数据来源与写入点

唯一数据源仍然是 `Enter` 回包。`core/src/services/friend/api.ts` 的 `enterFriendFarm` 在拿到回包后统一调用 `recordFriendDogFromEnterReply()`，这是全仓库唯一的 write-through 入口，因此偷菜、帮忙、捣乱、天气扫描、面板手动操作、互动道具——任何进好友农场的动作都会顺手更新缓存，零额外 RPC。它同时是自愈路径：好友中途换狗或狗粮吃完，下一次进他农场就会纠正。

服务端在好友没有上场狗时不下发 `brief_dog_info`，缺省按 `dogId = 0` 记，这也是一个有效结论。

`GetDogInfo{host_gid}` 只需 1 个 RPC 并且能带回 `skill_usages`，理论上比 `Enter` + `Leave` 更省，但仓库里没有好友维度的抓包证据，所以没有采用；如果以后补到抓包，探测协议可以在 `pet-sync.ts` 的 `probeFriendDog()` 里单点替换。

## 缓存结构与新鲜度

`core/src/services/friend/pet-cache.ts` 维护三态：

- `protect` — 当天确认上场的是护主犬
- `other` — 当天确认上场的是别的狗，或没有上场狗
- `unknown` — 当天还没有确认过

新鲜度按 `getSystemDateKey()` 的系统日期判定，不做小时级 TTL：好友随时可能换狗或狗粮吃完，跨日的记录一律视为未知，由每日同步重新确认。跨日记录在文件加载时和运行期（`dropStaleEntries()`）都会被丢掉，所以文件不会无限增长。

落盘文件是 `core/data/friend-pet-<sha256(accountId)>.json`，按账号隔离，由 worker 进程直接 `writeJsonFileAtomic` 写，不走 IPC——和 `friend-bad-state-<hash>.json` 一个模式。写盘有 2 秒防抖（`FLUSH_DEBOUNCE_MS`），并且只在结论变化或首次确认时才排队，同一天内重复进同一个好友农场不会反复落盘。`stopFriendCheckLoop` 里会 `flushFriendPetCacheNow()`，避免停机丢掉当天已确认的结论。

## 每日同步的节奏参数

`core/src/services/friend/pet-sync.ts` 负责补齐当天仍是 `unknown` 的好友，是唯一为了拿宠物信息而额外发 RPC 的地方。所有请求走 `low` 优先级：`low` 只在队列里没有 `high` / `normal` 时才发出，在协议层就不会挤压主流程。节奏对齐已经在生产验证过的好友天气扫描（见 [雨落成诗活动协议与实现](weather-activity.md) 的「Web 与自动化行为」）：

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `SYNC_BATCH_SIZE` | `5` | 每批 5 位好友 |
| `SYNC_GAP_MS` | `300` | 批内每两位好友之间等 300 毫秒 |
| `SYNC_BATCH_GAP_MS` | `1000` | 批与批之间再等 1 秒 |
| `SYNC_CHECK_INTERVAL_MS` | `10 * 60 * 1000` | 每 10 分钟检查一次当天是否还有未确认的好友 |
| `SYNC_STARTUP_DELAY_MS` | `90 * 1000` | 启动错峰 90 秒后才跑第一轮 |

整体约 3 RPC/s，58 位好友一轮 40 秒左右，和天气扫描同一量级。启动延迟 90 秒是为了避开登录关键路径上已有的排期：农场 2 秒 / 好友 8 秒 / 每日领取 45 秒 / 神秘商店 60 秒。10 分钟的定时检查同时兼顾开关中途打开、未完成补扫和跨日重新开始。这些常量以 `FRIEND_PET_SYNC_TUNING` 导出，便于测试和排查时读取。

## 账号队列

好友列表读取和每位好友的 `Enter → 探测 → Leave` 都提交到账号任务队列。宠物同步使用 `maintenance` 优先级，好友巡检使用 `scheduled`，界面操作使用 `interactive`；每位好友是一个完整事务，事务之间自然让出执行权，不再维护独立轮询门控。

只有 `deferred === 0`（真正跑完整轮）才 `markFullSyncDone()`，否则下一次定时检查继续补剩下的。已经在当天有结论的好友由 `collectPendingFriends()` 提前过滤掉，黑名单和失效好友（`getInvalidKnownFriendGidSet()`）同样不进名单。进农场失败时复用现成的 `handleFriendEnterError()`，封禁加黑和失效好友清理逻辑不重复实现。

## 开关门控顺序

`runFriendPetSync()` 依次检查，任一不满足就跳过并返回原因：

1. `friend` 自动化未开 → `friend_off`
2. `friend_help` 未开 → `friend_help_off`
3. `friend_help_protect_dog_ignore_exp_limit` 未开 → `protect_dog_bypass_off`
4. 当天已完成整轮 → `done_today`
5. 好友安静时段（`inFriendQuietHours()`）→ `quiet_hours`
6. 未登录 → `not_logged_in`

第 3 条是刻意的：护主犬开关关闭时这份数据没有消费方，一个额外 RPC 都不该花。但 `Enter` 回包的顺手写入不受任何开关影响，所以开关重新打开时已经有一部分结论可用，同步只需补剩下的。

## 帮忙链路的行为变化

`visit-strategy.ts` 的 `visitFriendForHelp()` 在经验满时改查当天缓存，只有 `protect` 才真的进农场，`other` 和 `unknown` 直接返回 `skipped_exp_limit`（不发 RPC）。`scheduler.ts` 的批量帮助循环同样在发请求之前就用缓存过滤，非护主犬好友直接 `continue`——不发 RPC、不 sleep，循环结束后汇总成一条 `protect_dog_cache_filtered` 日志，避免每轮刷几十条跳过日志。

净效果：经验满之后，每轮巡检的好友农场进出次数从「全部待帮好友」降到「当天确认挂着护主犬的好友」，探测成本从每轮一次变成每天一次，且探测走 `low` 优先级。

## 观测

- 同步开始：`event: '好友宠物同步', result: 'start'`，带 `pending`
- 同步结束：`result: 'ok' | 'deferred'`，带 `checked` / `failed` / `deferred` / `known` / `protect`
- 批量帮助的缓存过滤：`event: 'protect_dog_cache_filtered'`
- `getFriendPetCacheStats()` 返回 `{ date, known, protect, fullSyncDone }`，排查时可直接读

缓存也直接喂给好友页面：`getFriendsList` / `getFriendsListCacheOnly` 在返回前用 `buildFriendPetView()` 附加 `petState`（`protect` / `other` / `none` / `unknown`）和 `pet: { id, name, image } | null`，名称与图标用本地物品配置查（`getItemById` / `getItemImageById`），零额外 RPC。宠物结论随时会被 `Enter` 回包刷新，所以不写进好友列表缓存，只在返回时附加。前端 `web/src/views/Friends.vue` 把它渲染成一枚徽标：护主犬高亮、其他狗显示宠物名、当天确认没有上场狗显示“无宠物”、当天还没确认显示“宠物待确认”。

## 相关文件

- `core/src/services/friend/pet-cache.ts` — 三态缓存、落盘、跨日作废
- `core/src/services/friend/pet-sync.ts` — 每日分片同步、账号队列接入、节奏参数
- `core/src/services/friend/api.ts` — `enterFriendFarm` 里的 write-through 写入点
- `core/src/services/friend/visit-strategy.ts` — 经验满时按缓存决定是否进农场
- `core/src/services/friend/scheduler.ts` — 批量帮助的缓存过滤、同步定时器挂载与停机 flush
- `core/tests/friend-pet-cache.test.js` — 三态识别、落盘恢复、跨日作废、待同步名单过滤
