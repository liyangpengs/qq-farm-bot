# 好友宠物缓存与每日同步

## 背景

好友帮忙有两个相关开关：`friend_help_exp_limit`（帮忙经验满就不再帮）和 `friend_help_protect_dog_ignore_exp_limit`（挂着护主犬的好友即使经验满也继续帮，为的是「同气连枝」礼包）。护主犬是 `dog_id = 90021`。

护主犬只能从 `VisitService.Enter` 回包的 `brief_dog_info.dog_id`（`visitpb.proto` 的 field 3）读到，没有单独的「好友宠物列表」协议。所以早期实现里，帮忙经验一满，每轮好友巡检（20~25 秒一轮）都会把全部待帮好友逐个 `Enter` + `Leave` 试探一遍，而且和农场主流程抢同一批并发槽位，会实打实挤压主流程。现在这些结论落到缓存里，每天只确认一轮，探测请求也降到最低的 `background` 班次。

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

`core/src/services/friend/pet-sync.ts` 负责补齐当天仍是 `unknown` 的好友，是唯一为了拿宠物信息而额外发 RPC 的地方。探测请求走 `background` 班次（配对的 `Leave` 提到 `friend` 班次，见下）。

固定不变的是**瞬时速率**：批内每两位好友之间硬等 2 秒，一位好友两个 RPC，约 0.9 RPC/s。会变的是**轮次配额和轮间间隔**，跟着连接状态自适应（见下一节）。

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `SYNC_MAX_PER_ROUND_BASE` | `10` | 轮次配额基线，每天从这里起步 |
| `SYNC_MAX_PER_ROUND_STEP` | `5` | 干净跑完一轮后配额的上调步长 |
| `SYNC_MAX_PER_ROUND_CAP` | `25` | 配额封顶 |
| `SYNC_BATCH_SIZE` | `5` | 每批 5 位好友 |
| `SYNC_GAP_MS` | `2000` | 批内每两位好友之间等 2 秒（瞬时速率的安全线，不参与自适应） |
| `SYNC_BATCH_GAP_MS` | `3000` | 批与批之间再等 3 秒 |
| `SYNC_CHECK_INTERVAL_MS` | `10 * 60 * 1000` | 基线间隔：当天没活、开关关着、跨日等情况下的巡检节奏 |
| `SYNC_FAST_INTERVAL_MS` | `3 * 60 * 1000` | 干净跑完一轮但好友还没探完时的间隔 |
| `SYNC_CONTENTION_RETRY_MS` | `60 * 1000` | 只是抢不到空闲窗口时的短退避 |
| `SYNC_BUSY_COOLDOWN_MS` | `30 * 60 * 1000` | 服务端静默后冷却 30 分钟再试 |
| `SYNC_STARTUP_DELAY_MS` | `90 * 1000` | 启动错峰 90 秒后才跑第一轮 |
| `FRIEND_TASK_WAIT_MAX_MS` | `10000` | 进每位好友前给好友巡检让路的最长等待 |
| `FRIEND_TASK_POLL_MS` | `250` | 让路等待的轮询间隔 |
| `GATEWAY_IDLE_WAIT_MAX_MS` | `8000` | 进每位好友前等网关空闲的最长等待，等不到就整轮让路 |

满配额一轮是 25 位好友 × (`Enter` + `Leave`)、约 70 秒，加上 3 分钟轮间间隔，平均 0.2 RPC/s——和早期「每 10 分钟 10 位」的平均速率同一量级，但占空比高得多：健康连接上 200 位好友半小时左右补齐，而不是磨几个小时。

### 轮次节奏怎么自适应

`planNextSyncPacing()`（纯函数，有单测）根据本轮结果决定下一轮什么时候来、探几位：

| 本轮结果 | 下一轮间隔 | 配额 |
| --- | --- | --- |
| `deferred / round_quota`（干净跑完，好友没探完） | `SYNC_FAST_INTERVAL_MS` | `+STEP`，封顶 `CAP` |
| `deferred / gateway_contention`（抢不到空闲窗口） | `SYNC_CONTENTION_RETRY_MS` | 回基线，并锁死当天的上调 |
| `deferred / friend_task_busy`（好友巡查占用） | `SYNC_CONTENTION_RETRY_MS` | 回基线，并锁死当天的上调 |
| `deferred / gateway_busy`（服务端静默） | `SYNC_CHECK_INTERVAL_MS`（且已进 30 分钟冷却） | 回基线，并锁死当天的上调 |
| `synced` / `fresh` / `skipped` / `error` | `SYNC_CHECK_INTERVAL_MS` | 不变 |

「锁死上调」意味着当天只往上探一次限制，撞到之后就老实按基线跑，跨日（`getSystemDateKey()` 变化）才重新开始爬。轮次链是自我续期的一次性定时器（`scheduleNextSyncRound()`）而不是固定 `interval`，间隔才能跟着状态变；`stopFriendPetSyncTimer()` 会同时清掉配额、锁和冷却，重连后从基线重新开始。

### 为什么必须这么慢

早期版本一轮就把当天所有未确认好友（60~200 位）连着探完，约 3 RPC/s。生产上出现两次同一形态的掉线：同步跑到 60~75 位之后，服务端对**所有**请求彻底静默——`AllLands` / `Bag` / `AntiData` / `Heartbeat` 全部挂在 `stage=pending` 十几秒、连接再没有任何入站数据，最后心跳三连失败、账号下线。

```
好友宠物同步完成：确认 75，失败 0，待补 129（让路原因：网关繁忙）
AntiData 上报失败: 请求超时: AntiData (stage=pending, pending=3, queued=0, active=AllLands#251:18136ms,Bag#252:12134ms,Heartbeat#253:10191ms)
心跳未响应 (miss=3/3, heartbeat=95s, inbound=78s...)
```

注意静默是**服务端**给的：请求已经发出去（`stage=pending`、`queued=0`），只是没有回包。所以这不是客户端排队能解决的问题，只能把进出好友农场的突发量压下去。没有抓包能证明具体是哪条限制（速率、配额还是反外挂判定），因此瞬时速率取的是保守值，配额上调也设计成「当天只探一次上限，撞到就退回基线」；如果还出现同形态掉线，下一步就是降 `SYNC_MAX_PER_ROUND_CAP` / 拉长 `SYNC_FAST_INTERVAL_MS`，或者干脆关掉 `friend_help_protect_dog_ignore_exp_limit`（同步随之停发所有额外 RPC）。

启动延迟 90 秒是为了让登录启动序列（每日礼包 → 任务 → 神秘商店，串行执行，见 [网络并发模型](network-concurrency.md)）先跑完。基线间隔的巡检同时兼顾四种情况——开关中途打开、让路后补扫、配额分轮推进、跨日重新开始。这些常量以 `FRIEND_PET_SYNC_TUNING` 导出，便于测试和排查时读取。

## 让路门控

好友任务的优先级高于宠物同步，门控是单向的：同步让位好友巡检，好友巡检不会等同步。

进入每一位好友之前，`waitForFriendTaskIdle()` 会轮询 `scheduler.isFriendCheckRunning()`（对应 `isCheckingFriends`），最多等 `FRIEND_TASK_WAIT_MAX_MS = 10000` 毫秒、每 `FRIEND_TASK_POLL_MS = 250` 毫秒一次。等不到空闲就立刻中断本轮，把剩下的好友计入 `deferred` 留给下一次定时检查，不会逐批硬碰。同一处还会重新核对开关，运行中被关掉也会当场停下。

### 网关空闲门控

`background` 槽位只保证「不抢先」，不保证「不叠加」：请求照样能排进 `requestQueue` 慢慢熬，几百位好友一路硬排会把队列和 `pending` 拉满，`Enter` / `Leave` 全部熬到 `stage=queued` 超时刷一屏日志，业务请求跟着变慢，极端情况下连心跳都会被挤到掉线。所以除了好友巡检，宠物同步还要给**所有**请求让位：

- 取好友列表之前、进每位好友之前，先 `waitForGatewayIdle(GATEWAY_IDLE_WAIT_MAX_MS)`（`core/src/utils/network.ts`）。判定口径在 `core/src/utils/low-priority-gate.ts` 的 `isGatewayIdleForLowPriority()`：队列里有任何非 `background` 请求、有业务请求在飞、已经有别的 `background` 在飞、心跳漏过一次，都算「不空闲」。心跳与 ACE 有独立保留槽位，不参与判定。
- 判定里还包含「有在途请求卡了 `GATEWAY_STALL_PENDING_MS = 5000` 毫秒以上」：服务端静默的时候主流程请求会挂十几秒，这时候后台探测必须立刻停手。
- 这个等待只观察不排队，等待期间一点压力都不加给网关；8 秒等不到空闲窗口就整轮让路，剩下的好友计入 `deferred`。让路的代价按 `classifyGatewayDefer()` 分两档：网关健康、只是被前台操作和农场巡检占着 → `gateway_contention`，1 分钟后再来；心跳漏拍或有在途请求卡住不回包 → `gateway_busy`，进 `SYNC_BUSY_COOLDOWN_MS = 30` 分钟冷却（冷却期内返回 `skipped / gateway_cooldown`；重连时 `stopFriendPetSyncTimer()` 会清掉冷却）。早期版本两种情况都按 30 分钟算，自家 farm tick 挡一下路就白等半小时，是同步慢的主因。
- `background` 请求在队列里最多等 `LOW_PRIORITY_QUEUE_WAIT_MS = 8000` 毫秒（`sendMsgAsync` 里为 `background` 单独挂的计时器），超过就以 `GatewayBusyError`（`网关繁忙，后台请求已让路`）结束，而不是熬到 20 秒请求超时。
- `isGatewayYieldError()` 把让路、`stage=queued` 超时、队列已满、连接断开 / 未登录归成一类：`probeFriendDog()` 返回 `yield`，本轮立刻收尾，既不走 `handleFriendEnterError()` 的封禁加黑判定，也不逐个刷「进入好友农场失败」的告警。掉线时不会再出现几十条同步告警尾随。

结束日志会带上让路原因：`deferReason` 取 `gateway_busy` / `gateway_contention` / `round_quota` / `friend_task_busy` / `switch_off`，消息里渲染成「（让路原因：连接被主流程占用）」这类文案。

### Enter / Leave 必须配对

`Enter` 成功之后的 `Leave` 提到 `friend` 班次，不走 `background`。`background` 请求在网关忙的时候会被让路丢掉，而 `leaveFriendFarm()` 内部会吞掉错误——一旦 `Leave` 被丢，服务端那边就留着「还在别人农场里」的状态。收尾请求量很小（每位好友一个），换来的是访问状态一定闭合。

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

好友巡查已经合并成「每位好友只进一次农场」（见下），经验满时的过滤发生在**进农场之前**：`visit-plan.ts` 的 `buildFriendVisitPlan()` 只把当天缓存已确认是 `protect` 的好友标上 `wantHelp`，`none` 和 `unknown` 一律不帮；如果这位好友同时也没有可偷、也不是捣乱对象，那这一轮对他一个请求都不发。`visit-strategy.ts` 的 `visitFriend()` 里还有同一道闸门兜底（经验在一轮中途满掉的情况）。被跳过的好友汇总成一条 `protect_dog_cache_filtered` 日志，避免每轮刷几十条跳过日志。

净效果：经验满之后，每轮巡检的好友农场进出次数从「全部待帮好友」降到「当天确认挂着护主犬的好友」，探测成本从每轮一次变成每天一次，且探测走 `background` 班次。

## 好友巡查的单次访问合并

以前一轮巡查分三段跑：先「只偷菜」一轮、再「只帮忙」一轮、最后「只捣乱」一轮，每段各自 `Enter` / `Leave`。既有可偷又需要帮忙的好友因此被进两次农场，200 位好友一轮能刷出几百个 `Enter` / `Leave`。

现在 `checkFriends()` 先用 `buildFriendVisitPlan()`（`core/src/services/friend/visit-plan.ts`，纯函数）算出每位好友这一轮要做哪几件事，再对每位好友只调一次 `visitFriend()`，在同一次进农场里把 帮助（除草 / 除虫 / 浇水）+ 偷菜 + 捣乱（放草 / 放虫）做完。过滤规则：

- 捣乱额度用完（`getRemainingBadOperationTimes() <= 0` 或 `isBadOperationLimitReached()`）→ 这一轮不捣乱；
- 经验已满且「经验满不帮」开着 → 不帮；
- 经验已满但「护主犬无视经验上限」开着 → 只帮当天缓存已确认是护主犬的好友；
- 宠物还没同步（`unknown`）且经验已满 → 不进农场，交给每日宠物同步补齐；
- 三件事都不做的好友一个请求都不发（`visitFriend()` 在 `Enter` 之前就返回）。

捣乱对象仍然只从「既没可偷也没可帮」的好友里按等级降序取前 `MAX_BAD_ONLY_VISITS_PER_ROUND = 20` 位——不在偷 / 帮的访问里顺手放草放虫，免得每日捣乱额度花在错误的好友身上。

## 观测

- 同步开始：`event: '好友宠物同步', result: 'start'`，带 `pending`
- 同步结束：`result: 'ok' | 'deferred'`，带 `checked` / `failed` / `deferred` / `known` / `protect`
- 批量帮助的缓存过滤：`event: 'protect_dog_cache_filtered'`
- `getFriendPetCacheStats()` 返回 `{ date, known, protect, fullSyncDone }`，排查时可直接读

缓存也直接喂给好友页面：`getFriendsList` / `getFriendsListCacheOnly` 在返回前用 `buildFriendPetView()` 附加 `petState`（`protect` / `other` / `none` / `unknown`）和 `pet: { id, name, image } | null`，名称与图标用本地物品配置查（`getItemById` / `getItemImageById`），零额外 RPC。宠物结论随时会被 `Enter` 回包刷新，所以不写进好友列表缓存，只在返回时附加。前端 `web/src/views/Friends.vue` 把它渲染成一枚徽标：护主犬高亮、其他狗显示宠物名、当天确认没有上场狗显示“无宠物”、当天还没确认显示“宠物待确认”。

## 相关文件

- `core/src/services/friend/pet-cache.ts` — 三态缓存、落盘、跨日作废
- `core/src/services/friend/pet-sync.ts` — 每日分片同步、让路门控、节奏参数
- `core/src/utils/low-priority-gate.ts` — `background` 班次让路策略：空闲判定与让路错误分类
- `core/src/utils/network.ts` — `getGatewayLoad()` / `waitForGatewayIdle()`、`background` 请求的队列等待上限
- `core/src/utils/request-priority.ts` — 请求班次分层与并发上限，详见 [网络并发模型](network-concurrency.md)
- `core/src/services/friend/api.ts` — `enterFriendFarm` 里的 write-through 写入点
- `core/src/services/friend/visit-plan.ts` — 单次访问计划：每位好友这一轮做哪几件事
- `core/src/services/friend/visit-strategy.ts` — `visitFriend()` 一次进农场做完三件事，经验满时按缓存决定是否进农场
- `core/src/services/friend/scheduler.ts` — 巡查主循环、同步定时器挂载与停机 flush
- `core/tests/friend-pet-cache.test.js` — 三态识别、落盘恢复、跨日作废、待同步名单过滤
- `core/tests/friend-visit-plan.test.js` — 单次访问计划的过滤与排序契约
- `core/tests/low-priority-gate.test.js` — 网关空闲判定与让路错误分类
