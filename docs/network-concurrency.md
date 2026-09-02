# 网络并发模型：请求班次与优先级分层

Gateway 是一条 WebSocket 长连接，所有业务共用它。这份文档说明请求怎么排队、谁能插队、谁必须让路。

实现分三块：

- `core/src/utils/request-priority.ts` — 纯策略：班次定义、容量上限、调度选择函数。可单测，不碰任何运行时状态。
- `core/src/utils/request-context.ts` — `AsyncLocalStorage`：给「任务入口」打班次标记，任务内部发的请求自动继承。
- `core/src/utils/network.ts` — 排队与发送：`sendMsgAsync()` 解析班次、`takeDispatchableRequest()` 委托策略函数选下一个请求。

## 为什么要分层

以前只有 `low` / `normal` / `high` 三档，心跳和 ACE 是 `high`，其余全是 `normal`。问题是「其余」里既有用户在面板上点的操作，也有农场定时任务、好友巡查、宠物同步：

- 后台任务一开跑就把 `normal` 的 2 个并发槽占满，用户点一下要等好几秒；
- 好友巡查一轮几百个 `Enter`/`Leave` 全排在同一个队列里，队列和 `pending` 双双拉满；
- 服务端一旦变慢（请求挂十几秒不回包），队列只会越堆越长，最后连心跳都排不上，三次漏心跳直接下线。

## 五个班次

优先级从高到低：

| 班次 | 用途 | 在途上限 | 排队上限 |
| --- | --- | --- | --- |
| `critical` | 心跳、ACE AntiData | 2（两条通道各留 1 个专属槽位） | 8 |
| `foreground` | 用户在面板上的前台操作 | 3 | 60 |
| `farm` | 自己农场的后台定时任务 | 2 | 40 |
| `friend` | 好友农场的后台定时任务 | 1 | 30 |
| `background` | 宠物同步等补数据任务 | 1（且只在连接彻底空闲时） | 10 |

额外约束：

- 业务班次（`foreground` / `farm` / `friend`）总在途不超过 `MAX_BUSINESS_IN_FLIGHT = 3`；
- 其中非前台业务不超过 `MAX_NON_FOREGROUND_BUSINESS_IN_FLIGHT = 2`，所以**前台操作永远有至少一个槽位**，后台定时任务再忙也抢不走；
- `critical` 的两条通道各有一个专属槽位，ACE 挤不掉心跳，反之亦然；
- `background` 只在「没有任何在途请求、且队列里没有别的班次」时才发送——它是补数据，不是业务；
- 排队上限按班次独立计算：后台把自己的 10 个名额排满，也不影响心跳和前台的名额。

所以任何时刻最多 5 个业务/保命请求在飞（2 critical + 3 business），加上空闲时可能有的 1 个 background。

## 防饿死

严格按班次排序会让低优先班次在高优先班次不断到来时永远排不上。`selectDispatchIndex()` 的做法是：排队超过 `CLASS_STARVATION_MS = 4000` 的业务请求会被提升到队首（在同样满足容量约束的候选里挑等待最久的那个）。

## 班次是怎么定下来的

`resolveRequestClass(options, ambientClass)` 的判定顺序：

1. `criticalLane`（`heartbeat` / `ace`）或 `priority: 'high'` → `critical`；
2. 显式 `requestClass` → 用它；
3. `priority: 'low'` → `background`（兼容旧调用）；
4. `AsyncLocalStorage` 里的环境班次 → 用它；
5. 都没有 → `foreground`。

**`priority: 'normal'` 被视为「调用方没表态」，走第 4 步。** 这一点很关键：项目里大量 API 封装（`friend/api.ts`、`friend/gid-manager.ts`、`services/interact.ts` 等）默认传 `'normal'`，如果把它当成明确的前台声明，后台定时任务发的请求就会全部伪装成前台流量，分层等于没做。

环境班次由 `services/scheduler.ts` 注入：`createScheduler(namespace)` 创建的定时器，任务体整体跑在 `classForSchedulerNamespace(namespace)` 里。

| 调度器命名空间 | 班次 |
| --- | --- |
| `network` / `ace` / `worker_manager` | 不注入（这些请求自己声明 `criticalLane`） |
| `friend-pet-sync` | `background` |
| 其它 `friend*`（`friend`、`friend-pet-cache`） | `friend` |
| 其它（`worker`、`farm`、`task`） | `farm` |

`worker` 命名空间的统一 tick 同时驱动农场和好友两种任务，所以三个真正的入口各自再显式包一层：

- `core/src/core/worker.ts` 的 `runFarmTick()` → `runWithRequestClass('farm', ...)`
- `core/src/core/worker.ts` 的 `runFriendTick()` → `runWithRequestClass('friend', ...)`
- `core/src/services/friend/pet-sync.ts` 的 `runFriendPetSync()` → `runWithRequestClass('background', ...)`

面板 HTTP 请求和 Socket.IO 事件不经过调度器，没有环境班次，因此天然落到 `foreground`——那边确实有人在等结果。

## 后台任务的两道闸门

协议层的 `background` 槽位只保证「不抢先」，不保证「不叠加」。所以后台任务自己还要主动让路：

- `waitForGatewayIdle(maxWaitMs)`（`utils/network.ts`）——发请求之前先观察网关，等不到空闲就整轮让路。只观察不排队，等待期间一点压力都不加。判定口径在 `utils/low-priority-gate.ts` 的 `isGatewayIdleForLowPriority()`：队列里有非 `background` 请求、有业务请求在飞、已经有 `background` 在飞、心跳漏过一次、或有在途请求卡了 5 秒以上，都算「不空闲」。
- 队列等待上限——`background` 请求在队列里最多等 `LOW_PRIORITY_QUEUE_WAIT_MS = 8000`，之后抛 `GatewayBusyError`（`isGatewayYieldError()` 能识别），让调用方把剩下的活留给下一轮，而不是一路熬到请求超时刷一屏日志。

## 定时任务的健康度退避

服务端静默时的形态是：请求全部 `stage=pending` 挂十几秒、心跳开始漏拍，最后 3/3 心跳失败掉线。这种时候客户端再按 3~5s / 12~15s 的固定间隔发定时任务，只会把 pending 拉满、把心跳一起挤到超时。

所以 `runFarmTick()` / `runFriendTick()`（`core/src/core/worker.ts`）在入口检查 `isGatewayHealthyForBusiness()`：

- 判据只有两条——`heartbeatMisses > 0`，或有在途请求超过 `GATEWAY_STALL_PENDING_MS = 5000` 没回包。比后台闸门宽松得多，队列里有活、有业务请求在飞都不算不健康，定时任务本来就该和前台操作正常竞争槽位。
- 不健康就跳过本轮，并把 `nextFarmRunAt` / `nextFriendRunAt` 指数退避：首次 30 秒，之后翻倍封顶 60 秒（`nextBusinessBackoffMs()`）。farm 和 friend 各自记账，互不影响。
- 网关一恢复退避立即清零，回到正常间隔。日志只在进入退避（`网关无回包，农场定时任务退避 30s (...)`）和恢复（`网关已恢复，...回到正常间隔`）时各打一次，不刷屏。

退避期间连接上只剩心跳和 ACE 上报——它们有独立保留槽位，能安静地把连接救回来。

## 压力日志

`Gateway 请求压力: ...` 只在队列里有**非 `background`** 请求时才打（`utils/request-pressure.ts`）。队列里只剩后台补数据是正常运行，不算拥塞。

`queuedMethods` 里的前缀标记：`!H:` 心跳、`!A:` ACE、无前缀前台、`#` 自己农场、`&` 好友农场、`~` 后台补数据。

## 登录后的启动序列

`core/src/core/worker.ts` 的 `runStartupSequence()`。以前是四个错峰定时器（农场 2s / 好友 8s / 每日领取 45s / 神秘商店 60s），每日礼包要等一分钟才领，而那时农场和好友循环已经在跑，几件事叠在一起反而把连接打满。

现在登录动作一结束就串行跑完：挂上农场/好友循环 → `await runDailyRoutines(true)`（邮件 / 每日分享 / 月卡 / 免费礼包 / VIP）→ `await checkAndClaimTasks()` → `await runMysteryShopTick()` → 才挂上后续的周期性定时器。串行意味着同一时刻只有一个业务请求在飞，既领得及时，也不会和心跳抢连接。

## 相关文件

- `core/src/utils/request-priority.ts` — 班次、容量、调度选择（纯函数）
- `core/src/utils/request-context.ts` — 环境班次（`AsyncLocalStorage`）
- `core/src/utils/network.ts` — 排队、发送、`getGatewayLoad()`、`waitForGatewayIdle()`
- `core/src/utils/low-priority-gate.ts` — 后台任务的空闲判定、定时任务的健康度退避、让路错误分类
- `core/src/utils/request-pressure.ts` — 压力日志节流
- `core/tests/request-priority.test.js` — 分层与容量的契约测试
- `core/tests/low-priority-gate.test.js` — 让路闸门与定时任务退避的契约测试
- `core/tests/low-priority-gate.test.js` — 空闲判定与让路错误分类