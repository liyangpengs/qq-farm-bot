# QQ 农场多账号调度架构建议

> 状态：架构评估稿，不包含实现变更
> 评估日期：2026-08-27
> 评估范围：`qq-farm-bot` 整体任务调度、并发治理、账号隔离、请求背压与持久化边界
> 唯一代码基线：fork 的 `origin/master`，提交 `85e99e8caeb70a8fab48edadde09a5df0224b0b7`
> 排除范围：当前检出分支、其他本地或远程分支，以及工作树中的全部未提交改动

审计时本地 `master` 指针为 `522c186`，落后 `origin/master` 33 个提交。本文所称“master”特指上述 fork 最新 master 提交，不使用这个过期的本地指针。后续评审若分支继续前进，应先记录新的 master 提交哈希，再重新核对代码事实。

## 1. 文档目的

本文只根据上述 master 提交的 Git tree 提出调度架构建议，不依赖任何外部讨论、截图、其他分支或未提交代码。所有“当前代码”结论均通过 `git show origin/master:<path>`、`git grep ... origin/master` 核实，而不是读取工作树中的同名文件。目标是交给其他 Agent 独立评估以下问题：

- 建议是否与当前协议和运行模型匹配；
- 是否真正降低多账号、多功能并发时的竞态风险；
- 是否存在过度设计；
- 是否有更低成本但同样可靠的实现方式；
- 迁移顺序是否足够安全、可测试和可回滚。

本文不讨论具体功能是否应该启用，也不提出登录后全量同步好友天气、宠物等业务策略。

交给其他 Agent 时，请要求评审者：

- 先确认能够解析提交 `85e99e8caeb70a8fab48edadde09a5df0224b0b7`；
- 使用该提交的 tree 或基于该提交创建干净 worktree，不直接读取当前工作树；
- 所有反驳或补充尽量给出该提交下的 `文件:行号`；
- 如果改用更新后的 master，必须写出新提交哈希，并把结论标记为“新基线复评”，不能与本文证据混用。

## 2. 结论摘要

建议采用分层调度：

1. 保留“一账号一 worker”的隔离边界；
2. 每个账号增加唯一的 `AccountTaskRunner`，串行执行会访问或修改游戏状态的完整业务事务；
3. 现有 Gateway 队列继续负责单个协议请求、心跳和 ACE 等传输层优先级；
4. 批量任务拆成可让步的小切片，避免一个长任务阻塞整个账号；
5. 主进程先增加轻量的启动准入与全局压力额度；只有实测需要时，再扩展为完整的 `GlobalCoordinator` 公平调度；
6. 明确持久化所有权：保留已按账号隔离的文件，仅让真正的跨账号共享状态遵守主进程单写者原则。

核心原则：

> 每账号保证业务事务顺序，全局负责公平与容量；长任务切片，重复任务合并，异常时主动降级。

## 3. master 代码的调度事实

### 3.1 已经存在的良好边界

- 每个账号拥有独立 worker thread 或 child process：`core/src/runtime/worker-manager.ts:48-91`。
- 每个账号 worker 加载独立的网络模块，因此拥有独立 WebSocket、协议序号、pending map 和 request queue：`core/src/utils/network.ts:92-108`。
- `runUnifiedTick()` 已按顺序执行农场 tick 和好友 tick；农场 tick 还串行包含任务、邮件和化肥礼包检查：`core/src/core/worker.ts:202-258`。
- 每个账号内部已经把启动任务错开到登录后约 2、8、45、60 秒：`core/src/core/worker.ts:312-337`。
- 网络层已经具备优先级、并发槽、队列上限、请求超时和压力日志：`core/src/utils/network.ts:94-107,137-165,377-410`。
- scheduler 可以登记、取消和观测 timer，并默认阻止同一个 interval 自身重叠：`core/src/services/scheduler.ts:143-240`。
- 好友天气页已限制为每页 4 人，并用 generation guard 处理断线失效：`core/src/services/weather-friend-page.ts:5-6,27-44,80-97`。
- worker 已存在 `runtimeGeneration`，但目前主要保护登录启动流程：`core/src/core/worker.ts:116,475,530-531,652`。

这些能力应保留并作为迁移基础，不需要推倒重写。

### 3.2 当前主要缺口

#### 缺口 A：统一调度只覆盖部分自动任务

`runUnifiedTick()` 只串行化农场 tick 与好友 tick。以下已确认入口仍可独立启动异步业务：

- UI 发起的 worker API 调用；
- 土地变化等服务端推送；
- 独立的每日例行 timer 与神秘商店 timer；
- 狗技能礼包等网络事件回调；
- 活动中心、天气、互动道具和商城等模块自己的 singleflight、Promise tail 或运行标志。

`onMasterMessage()` 收到 `api_call` 后直接调用异步的 `handleApiCall(msg)`，既不 `await`，也没有进入账号级统一任务队列：`core/src/core/worker.ts:445-454`。这意味着同一账号可以同时存在自动 tick、timer、推送回调和一个或多个手动 API 流程。

因此“自动任务内部串行”不等于“账号所有业务串行”。

#### 缺口 B：网络队列只保护单个 RPC

网络层排队的是单个请求，而业务往往由多个请求组成，例如：

```text
Enter(friend A)
读取状态
执行帮助/偷取/道具操作
Leave(friend A)
```

如果另一条业务在中间执行 `Enter(friend B)`，即使所有 RPC 都经过网络队列，完整业务仍然可能交叉。

master 的网络层允许 2 个普通请求在途；心跳和 ACE 各有 1 个高优先级保留槽；低优先级最多 1 个，且只在没有高/普通流量时派发；普通等待队列上限为 100：`core/src/utils/network.ts:94-103,137-157,377-406`。这些规则能保护传输层，但“请求级排队无法保证多请求业务事务不交叉”的问题不受具体并发数影响。

#### 缺口 C：多账号同时启动

`startAllAccounts()` 使用 `forEach(startWorker)` 同时启动全部账号：`core/src/runtime/runtime-engine.ts:146-151`。

虽然单个 worker 内已经做了 2/8/45/60 秒分阶段启动，但所有账号使用相同节奏，因此多个账号仍可能在相近时间执行同一阶段，形成跨账号波峰。

#### 缺口 D：并发控制分散在各模块

当前存在多种互不感知的机制：

- `farmTaskRunning`、`friendTaskRunning` 和 `harvestSellRunning`；
- worker、农场、好友等多套 scheduler；
- 活动中心、天气、互动道具各自的 `mutationTail`，商城的 `purchaseTail`；
- 背包、宠物、狗技能礼包等模块各自的 pending Promise；
- 网络 request queue；
- `services/rate-limiter.ts` 中另一套请求队列；在该 master 提交内，仓库搜索未发现其他生产文件引用它。

这些机制只能保护各自模块，无法表达跨模块资源冲突，也提高了新增功能的维护成本。

#### 缺口 E：持久化所有权存在惯例，但缺少统一契约

master 当前并没有显示出“所有 worker 争写同一个文件”的直接证据，不能把它当成已确认故障：

- 账号列表与全局配置由主进程 store 写入；
- 好友 GID 正常通过 `known_friend_gids_sync` 发回主进程持久化：`core/src/runtime/worker-manager.ts:425-439`；
- 统计、好友捣乱每日状态和活动中心状态均使用账号 ID 或其哈希隔离文件：`core/src/services/stats.ts:5-7`、`core/src/services/friend/scheduler.ts:79-83`、`core/src/services/activity-center-state.ts:148-159`；
- 活动中心的读改写还位于本 worker 的 `mutationTail` 内：`core/src/services/activity-center-state.ts:189-202`。

真正的缺口是这些边界依赖开发者约定，没有统一列出“谁可写什么”。`writeJsonFileAtomic()` 只能保证文件替换原子性，不能自动解决未来两个执行单元对同一路径做“读取 → 修改 → 覆盖”的丢失更新。因此应先做写入清单和所有权测试；只有确认存在共享写路径时，才需要迁移到主进程 `StorageActor`。

#### 缺口 F：关键并发路径缺少系统测试

该 master 提交只有 10 个 `core/tests/*.test.js` 文件，覆盖了部分网络保活、天气分页和业务规则，但没有发现以下系统级验证：

- 自动任务与手动 API 同时触发；
- 两个访问好友流程是否会交叉；
- 多账号同时启动时的全局请求上限；
- 重复推送是否合并；
- 断线是否取消全部排队和运行中业务任务；
- 多 worker 是否可能同时写同一持久化对象。

## 4. 建议的总体模型

```text
                         ┌──────────────────────────────┐
UI / API ───────────────▶│ 主进程 AdmissionController  │
                         │ 启动节流 / 公平 / 全局额度   │
                         └──────────────┬───────────────┘
                                        │ typed command / lease
                  ┌─────────────────────┼─────────────────────┐
                  ▼                     ▼                     ▼
        ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
        │ Account A worker│   │ Account B worker│   │ Account C worker│
推送 ──▶│ AccountTaskRunner│  │ AccountTaskRunner│  │ AccountTaskRunner│
定时 ──▶│ 业务事务执行器   │   │ 业务事务执行器   │   │ 业务事务执行器   │
        └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
                 ▼                     ▼                     ▼
        Domain task handler   Domain task handler   Domain task handler
                 ▼                     ▼                     ▼
        Gateway dispatcher    Gateway dispatcher    Gateway dispatcher
                 ▼                     ▼                     ▼
              QQ Gateway            QQ Gateway            QQ Gateway

账号私有状态 ─────────────────────────────────────────────▶ 账号隔离文件
共享状态 / checkpoint ────────▶ 主进程持久化门面 ────────▶ JSON（必要时 SQLite）
```

### 4.1 为什么不是一个全局 FIFO 队列

所有账号共用一个串行 FIFO 会产生明显的队头阻塞：

- 一个账号请求超时会拖住其他账号；
- 好友多的账号可能占用较长时间；
- 独立账号之间本可安全并行，却被无谓串行；
- 主进程会变成业务执行瓶颈。

因此正确边界是：

- 账号内部严格保证事务顺序；
- 账号之间允许受控并行；
- 全局只限制高压力任务和总容量。

### 4.2 为什么不是继续增加模块锁

每个功能维护自己的 `isRunning` 或 Promise tail，会出现以下问题：

- 无法阻止另一个模块访问相同资源；
- 无法统一优先级、超时、取消和任务状态；
- 新功能必须重新判断与所有旧功能的冲突关系；
- 发生死等或队头阻塞时缺乏全局观测。

账号级执行器用一个明确入口代替不断增长的模块锁集合。

## 5. AccountTaskRunner 设计

### 5.1 调度单位是业务事务

初始版本建议每账号只允许一个会访问 Gateway 的普通业务事务运行。心跳和 ACE 继续走网络层保留通道。

建议保持原子的事务包括：

- `Enter → 操作 → Leave`；
- `读土地 → 分析 → 收获 → 播种 → 施肥`；
- `读商城 → 校验余额 → 购买 → 刷新背包`；
- `读背包 → 选择物品 → 使用 → 校验结果`。

用户手动任务可以获得更高优先级，但不能在事务中间强制抢占；它只能成为下一个执行任务。

### 5.2 建议的任务描述

以下仅为概念接口，具体字段可精简：

```ts
type TaskPriority = 'critical' | 'interactive' | 'event' | 'scheduled' | 'maintenance'

interface AccountTaskDescriptor<TPayload = unknown> {
  id: string
  accountId: string
  type: string
  source: 'api' | 'timer' | 'push' | 'startup' | 'continuation'
  priority: TaskPriority
  payload: TPayload

  // 队列语义
  dedupeKey?: string
  notBefore?: number
  deadline?: number
  maxRuntimeMs?: number
  generation: number

  // 失败语义
  retryPolicy?: 'none' | 'safe-read' | 'verify-before-retry'
  attempt?: number

  // 观测
  parentTaskId?: string
  correlationId: string
}
```

worker 内使用 handler registry 将任务类型映射到业务处理器，逐步替换 `handleApiCall()` 中不断增长的巨大 `switch`：

```ts
taskHandlers.register('farm.check', runFarmCheck)
taskHandlers.register('friend.visit', runFriendVisit)
taskHandlers.register('weather.inspect-friend', inspectWeatherFriend)
```

### 5.3 任务状态

建议统一状态机：

```text
queued
  → waiting-admission
  → running
  → succeeded | failed | cancelled | deferred | expired
```

至少记录：

- 入队时间和等待时间；
- 实际开始与结束时间；
- 当前处理步骤；
- 请求数量；
- 失败原因和是否重试；
- 父任务、子任务及完成进度。

## 6. 优先级与公平性

建议的优先级顺序：

1. `critical`：心跳、ACE、连接关闭处理；
2. `interactive`：用户手动操作和显式刷新；
3. `event`：服务端推送触发的检查；
4. `scheduled`：农场、好友等周期任务；
5. `maintenance`：天气、缓存刷新、护主犬探测等后台任务。

规则：

- `critical` 由传输层保留通道处理，不进入普通业务队列；
- 运行中的原子事务不被抢占；
- 高优先级任务选择下一个执行机会；
- 增加 aging，避免低优先级任务永久饥饿；
- 已过 deadline 的任务直接过期，不再执行陈旧操作。

## 7. 去重、合并与背压

任务不能只依赖“队列最大长度”。必须为不同任务定义合并语义。

| 任务类型 | 建议策略 |
|---|---|
| `farm.check` | 队列中已有则合并；多个土地推送只保留一次检查 |
| `friend.scan` | 同类型重复任务合并；手动触发可提升已有任务优先级 |
| 配置同步 | latest-wins，只保留最高 revision |
| 页面查询 | singleflight，共享同一个进行中 Promise |
| 缓存刷新 | 同 scope + key 只允许一个 in-flight |
| 购买/使用物品 | 默认不合并；使用请求幂等 ID，禁止盲目重试 |
| 批量好友任务 | 父任务合并，已生成的子任务按 GID 去重 |

队列压力过高时：

- 优先丢弃过期 maintenance 任务；
- 合并重复 scheduled/event 任务；
- interactive 任务保留，但仍受账号健康和原子事务约束；
- 不允许低优先级任务无限积压后集中执行。

## 8. 批量任务必须切片

单一串行执行器仍可能被长任务阻塞，因此批量任务必须采用协作式让步。

### 8.1 好友任务示例

```text
friend.scan-parent
  1. 获取一次好友摘要
  2. 生成候选 GID 列表
  3. 提交 friend.visit(gid-1)
  4. 单个好友事务结束后回到调度器
  5. 提交或恢复 friend.visit(gid-2)
```

一个 `friend.visit` 内部仍保持：

```text
Enter → 读取 → 操作 → Leave（finally）
```

这样可以在两位好友之间响应用户操作、切换账号公平额度或暂停批次，但不会破坏好友访问上下文。

### 8.2 切片规则

- 每个切片最多处理一个好友，或限定一个较小时间预算；
- 每个切片结束后检查 `AbortSignal`、账号 generation 和 deadline；
- 父任务维护游标、成功数、失败数和剩余数量；
- 断线、功能关闭或用户取消后不再创建后续切片；
- 连续失败触发退避或暂停整个父任务。

## 9. 定时任务模型

不建议每个功能各自长期使用 `setInterval` 执行业务。建议 timer 只生成任务意图：

```text
任务完成
  → 根据结果和配置计算 nextRunAt
  → 加入统一到期队列
  → 使用一个 one-shot timer 唤醒最近到期任务
```

优势：

- 长任务不会与下一次 interval 重叠；
- 可以统一取消和调整配置；
- 可以增加随机抖动和多账号错峰；
- 失败后可以指数退避；
- UI 可以准确展示下一次运行时间；
- 调度器可以跳过已过期的陈旧任务。

随机错峰应基于 `accountId + taskType` 使用确定性 jitter，避免每次重启都重新碰撞，也避免所有账号使用相同固定延迟。

## 10. 主进程全局协调设计

全局协调逻辑位于主进程，只管理准入、额度和必要的公平性，不执行具体协议逻辑。master 目前尚无数据证明一定需要复杂的全局调度算法，因此建议从“启动 semaphore + 少量资源 lease”开始；只有观测到账号饥饿或长期争用，再抽象为完整的 `GlobalCoordinator`。

### 10.1 建议管理的全局资源

- `bootstrap`：同时进行登录初始化的账号数；
- `bulk-friend-visit`：天气、好友探测等批量访问；
- `normal-account-work`：同时高强度运行普通业务的账号数；
- `storage-write`：持久化单写者；
- 未来可增加特定服务或活动的全局额度。

用于压测的保守初始值可考虑：

- 同时 bootstrap：1–2 个账号；
- 每账号普通业务事务：1 个；
- 全局批量好友访问：1 个账号；
- 心跳与 ACE：不占普通业务额度。

这些不是生产环境结论。具体数值必须通过延迟和掉线数据调整，也应支持关闭全局限制用于对照测试。

### 10.2 公平算法

如果简单 semaphore 已经出现账号饥饿，再使用轮转；只有任务权重差异确实明显时才考虑 deficit round-robin：

- 一个账号完成一个任务切片后重新竞争全局额度；
- 好友多的账号不能一次占用完整批次；
- interactive 任务可以提高账号下一次获准概率；
- 单账号故障不能阻塞其他账号。

### 10.3 Lease 而不是全局锁

高压力任务开始前向主进程申请带 TTL 的 lease：

```text
worker → acquireLease(accountId, resource, taskId)
main   → granted / deferred
worker → execute one slice
worker → releaseLease(...)
```

worker 异常退出后 lease 自动到期，避免永久占用。

普通账号内部任务不必每次都经过主进程；只有需要全局额度的任务申请 lease，以免主进程成为热点。

实现时必须固定资源获取顺序，并禁止 handler 在执行器内部“提交另一个账号任务后同步等待它”。全局准入应在业务切片开始前完成，释放动作放在 `finally`，避免账号执行器与全局 lease 形成循环等待。

## 11. 账号生命周期和降级

建议明确账号运行状态：

```text
STARTING
  → AUTHENTICATING
  → BOOTSTRAPPING
  → READY
  → DEGRADED
  → DRAINING
  → OFFLINE
```

说明：

- `BOOTSTRAPPING` 只进行账号正常运行所需的最小初始化；
- `READY` 后才接收普通自动任务；
- `DEGRADED` 暂停 maintenance 和大部分 scheduled 任务；
- `DRAINING` 不接收新任务，等待原子事务结束或超时；
- generation 每次重连或重启递增，旧 generation 的任务和回包全部作废。

触发 `DEGRADED` 的信号可以包括：

- 连续请求超时；
- 心跳延迟上升；
- pending/queued 长期超过阈值；
- 连续 Gateway 错误；
- 入站数据长时间静默。

恢复时应逐步放开后台任务，避免立即重放积压队列。

## 12. 取消、超时与重试

### 12.1 取消

每个账号执行器维护 `AbortController`：

- 账号停止或断线：取消所有 queued 和 running 任务；
- 功能关闭：取消相应未运行任务，运行中任务在安全边界退出；
- 用户取消批量任务：停止后续切片；
- generation 变化：旧任务结果不再写入缓存或状态。

### 12.2 超时

应区分：

- queue deadline：任务最晚何时仍有执行价值；
- execution timeout：业务流程允许运行多久；
- RPC timeout：单个协议请求等待多久。

只设置 RPC timeout 不能避免任务在队列中等待过久后执行陈旧操作。

### 12.3 重试

- 只读查询：可指数退避并增加 jitter；
- 明确幂等的设置操作：可有限重试；
- 购买、领取、使用物品：不能在结果未知时盲目重试；
- 非幂等操作应先读取或验证后置状态，再决定是否补偿；
- 达到 retry budget 后进入 deferred/failed，不能无限循环。

## 13. 缓存和持久化边界

### 13.1 单写者原则

- 账号 worker：拥有本账号会话内存状态；
- 账号 worker：可以继续写该账号独占且路径可证明隔离的状态文件；
- 主进程：拥有全局配置、跨账号缓存和所有共享文件；
- Web 前端：只能提交命令和读取快照；
- worker 不直接读改写跨账号共享文件。

这里的“单写者”按资源划分，不等于“所有磁盘 I/O 都搬到主进程”。master 现有账号隔离文件没有必要为架构整齐而迁移。

### 13.2 缓存结构

建议缓存项统一包含：

```ts
interface CacheEntry<T> {
  scope: 'account' | 'global'
  key: string
  value: T
  observedAt: number
  expiresAt: number
  revision: number
  source: string
}
```

必须区分：

- 已确认没有；
- 尚未确认；
- 曾经确认但已经过期；
- 查询失败，状态未知。

缓存刷新采用 singleflight 和 stale-while-revalidate，不能因为一批数据同时过期就立即全量刷新。

### 13.3 持久化技术

短期继续使用 JSON。先形成持久化清单，至少记录路径模式、owner、scope、写入入口、是否读改写、损坏恢复和并发测试。对确认由多个执行单元共享的对象，才增加主进程持久化门面或 `StorageActor` 串行写入。

长期如果缓存、任务历史和每日状态继续增加，建议考虑 SQLite：

- 有事务和 schema；
- 不会跨文件部分成功；
- 更容易清理过期数据；
- 支持按账号、GID、任务类型查询；
- 适合单机应用，不需要 Redis 或外部队列服务。

普通周期任务不建议完整持久化。重启后可以从配置重新生成；只持久化必要的幂等键、长任务游标、业务 checkpoint 和有限任务历史。

## 14. UI/API 交互建议

短任务可以继续等待 worker 返回结果。

长任务应改成异步 job：

```text
POST /operation
  → 返回 jobId

GET /jobs/:jobId
  → queued / running / progress / failed / succeeded
```

或者通过现有 WebSocket 推送任务进度。

这样可以避免：

- HTTP/API 10 秒超时但 worker 仍在执行；
- 用户重复点击导致重复业务；
- 页面刷新后丢失批量操作进度；
- 将长任务误判为 worker 卡死。

## 15. 可观测性

建议把 `taskId` 和 `correlationId` 贯穿：

```text
API → AdmissionController/GlobalCoordinator → AccountTaskRunner → Domain handler → Gateway request → log
```

最少提供以下指标：

- 每账号 queued/running 数；
- 当前任务、已运行时长和当前步骤；
- 按优先级的等待时间；
- 合并、丢弃、过期、取消次数；
- 每任务产生的 RPC 数；
- Gateway pending、queue、超时和延迟分位数；
- 全局 lease 使用情况；
- 账号进入 DEGRADED 的原因和持续时间。

现有 scheduler snapshot 可以继续保留，但需要增加业务任务队列 snapshot；timer 状态不能代表业务执行状态。

## 16. 建议的迁移顺序

### 阶段 0：测试和观测，不改变业务行为

- 为日志和 Gateway 请求增加 task/correlation ID；
- 建立 fake clock 和 fake Gateway；
- 增加自动任务与手动 API 并发测试；
- 增加访问好友事务顺序测试；
- 增加断线取消测试；
- 记录当前请求量、延迟、排队和掉线基线。

### 阶段 1：AccountTaskRunner

- 新增账号级任务执行器；
- 先保持普通业务并发为 1；
- 将 `runFarmTick`、帮助/偷菜 tick、UI `api_call`、推送触发统一提交到执行器；
- 现有 service 函数不重写，只在外层包裹；
- 心跳与 ACE 保持网络层关键通道。

该阶段预计能消除大部分跨模块竞态，是收益最高的第一步。

### 阶段 2：批量切片

- 好友扫描拆成 parent + 单好友 child；
- 天气扫描复用相同批量框架；
- 增加取消、进度、连续失败暂停；
- 手动任务可以在切片之间优先执行。

### 阶段 3：主进程全局准入

- 多账号启动先改为 semaphore + 确定性 jitter 的受控 bootstrap；
- 增加全局高压力任务 lease；
- 先观测账号等待时间；有饥饿证据时再增加账号间公平调度；
- 加入全局 DEGRADED/backpressure 策略。

### 阶段 4：持久化所有权与缓存规范

- 清点所有主进程和 worker 文件写入，记录 owner 与 scope；
- 保留已按账号隔离的写入，仅将确认共享的状态迁移到主进程；
- 统一缓存结构、TTL、singleflight 和 revision；
- 根据数据规模决定是否迁移 SQLite。

### 阶段 5：模块清理

- 将 `handleApiCall` 大型 switch 改为 handler registry；
- 删除已被账号执行器覆盖的局部 Promise tail 和 `isRunning`；
- 合并或删除重复的 rate limiter；
- 将 1000–2000 行模块按领域边界拆分。

不建议在阶段 1 之前先做大规模文件拆分，因为这不会解决竞态，反而扩大回归范围。

## 17. 必须增加的测试场景

### 17.1 账号内部顺序

- 自动好友任务运行时用户打开好友土地；
- 自动巡田运行时用户手动施肥；
- 天气检查与普通好友访问同时触发；
- 商城购买与背包使用同时触发；
- 断言业务事务不会交叉。

### 17.2 去重和背压

- 100 次土地变化推送只产生一次有效巡田；
- 连续点击刷新复用同一查询；
- 队列满时 maintenance 被丢弃或合并；
- 过期任务不会在几十秒后补执行。

### 17.3 多账号公平

- 10–20 个账号同时启动，bootstrap 不超过额度；
- 一个账号有大量好友时，其他账号仍能执行任务；
- 一个账号超时不会阻塞其他账号；
- 全局 bulk lease 异常退出后能够自动释放。

### 17.4 生命周期

- 断线取消排队和运行任务；
- 旧 generation 的回包不能更新新会话；
- DEGRADED 停止后台任务但保留心跳；
- 恢复后不会瞬间重放全部积压任务。

### 17.5 持久化

- 每个持久化路径都能证明只有一个 owner，或具备并发写保护；
- 多个 worker 同时上报共享状态时不会丢失更新；
- 写入失败保留旧文件/事务；
- 缓存 schema 升级和损坏恢复；
- 同一幂等键不会重复执行非幂等操作。

## 18. 验收标准

建议在认为调度改造完成前满足：

- 所有 Gateway 普通业务都可以追溯到一个 account task；
- 同账号不存在两个并行的普通业务事务；
- `Enter → 操作 → Leave` 不会被另一好友访问穿插；
- 所有 timer、push、API 最终进入统一账号执行器；
- 多账号启动受全局额度和 jitter 控制；实测属于高压力的 bulk 任务受 lease 控制；
- 队列有上限、去重、deadline 和取消；
- 断线后不存在继续写缓存的旧任务；
- worker 只写明确归它所有的账号隔离文件，不直接读改写跨账号共享文件；
- 任务状态、等待时间和失败原因可以从管理端观测；
- 竞态、断线、超时和多账号压力测试稳定通过。

## 19. 不推荐的替代方案

### 19.1 只降低网络并发数

可以降低压力，但不能保证多请求业务事务不交叉，也不能解决模块状态竞态。

### 19.2 所有账号共用一个串行任务表

实现简单，但会造成跨账号队头阻塞，降低可用性和吞吐量。

### 19.3 每个功能增加独立锁

短期有效，长期冲突矩阵会持续增长，新增功能仍然容易绕过旧锁。

### 19.4 登录时全量预热所有好友衍生数据

会将正常运行期间的请求压力集中到多账号启动阶段，尤其不适合需要逐好友 Enter 的数据。

### 19.5 立即引入 Redis/BullMQ

当前是单机、多 worker 模型，外部分布式队列会增加部署和故障面；在需要跨主机调度前没有必要。

### 19.6 一次性重写所有模块

当前关键并发路径测试不足，大爆炸式重写难以验证行为等价。建议先建立任务边界，再逐步迁移。

## 20. 请求其他 Agent 重点评审的问题

请评审者独立检查代码并回答：

1. 一账号一个串行业务执行器是否符合 Gateway/Visit 协议的真实状态模型？
2. 是否存在必须并行、不能串行的普通业务流程？
3. 哪些查询可以安全绕过执行器直接读取内存快照？
4. `Enter → 操作 → Leave` 是否必须视为不可穿插事务？
5. 批量任务按单好友切片是否会引入新的状态失效问题？
6. 哪些资源只需简单 semaphore，哪些确实需要 GlobalCoordinator；哪些限制应留在账号 worker？
7. round-robin、deficit round-robin 或简单 semaphore 中，哪种最符合项目规模？
8. master 当前 worker 写文件的实际范围是否都按账号隔离？是否存在本文漏掉的共享路径？
9. 现阶段是否根本不需要 StorageActor？出现何种共享写入或数据规模后才值得引入它或 SQLite？
10. 当前网络队列与 proposed AccountTaskRunner 的职责是否清晰，是否可能形成双重死锁？
11. 阶段 1 能否只包裹现有函数而不改变协议行为？
12. 是否遗漏了会绕过统一任务入口的 timer、event listener 或 API 路径？
13. 建议是否过度设计；若要缩减，哪些能力可以延后而不损害正确性？
14. 有无更简单的架构可以同时满足多账号公平、事务顺序、取消和背压？

## 21. 建议评审输出格式

为了便于汇总，建议其他 Agent 按以下格式反馈：

```text
总体结论：同意 / 部分同意 / 不同意

必须保留：
- ...

建议修改：
- ...

主要风险：
- ...

更简单的替代方案：
- ...

建议第一阶段范围：
- ...

需要先验证的代码事实：
- 文件:行号 — 说明
```
