# QQ 农场全局调度重构方案（Kimi 评估稿）

> 状态：架构设计稿，评估并综合 `architecture-claude.md` 与 `architecture-codex.md`
> 编写日期：2026-08-27
> 代码基线：`origin/master` @ `4ac2e78b2fdb2978e3e684a96b3c73f68e236619`（当前 HEAD）
> 目标：**多账号、多任务并发下"临危不乱"** —— 任何功能入口、任何账号数量下，
> 业务事务不交叉、状态不丢失、故障可降级、问题可观测
> 代码事实均在当前 HEAD 工作树复核（`git status` 干净，HEAD == origin/master）

---

## 0. 本文的定位

前两份文档各自回答了一半问题：

- `architecture-codex.md`（下称 **Codex 稿**）把问题定位在**调度与并发治理**，
  设计了 AccountTaskRunner + 全局准入的完整模型，诊断严谨，但方案偏重，
  且把调度当作了问题的全部。
- `architecture-claude.md`（下称 **Claude 稿**）按"改动放大系数"重新排序，
  正确指出**无契约的六层管道**才是维护成本的最大来源，调度只排第四，
  但其调度设计本身（§2.4 只有 4 个能力）不足以回应"多账号竞态"这个核心关切。

本文做三件事：

1. 在当前 HEAD 上**复核**两份文档的代码事实（§1）——两份文档的基线 `85e99e8`
   已不再是当前 master 的祖先（master 经历过 rebase），所有行号已重新核实；
2. 给出**独立评估**：各自的价值、不足、共识与分歧（§2）；
3. 给出**本文方案**：一个以"统一意图入口 + 账号执行器 + 全局仲裁"为骨架、
   以契约层为演进方向的全局调度架构（§3–§8），以及迁移路线与验收标准（§9–§11）。

---

## 1. 代码事实复核（当前 HEAD @ 4ac2e78）

两份文档的核心论断在当前代码上**全部仍然成立**，行号有漂移：

| 事实 | 文档所述（基线 85e99e8） | 当前 HEAD 复核 |
|---|---|---|
| worker API 分发是巨型 switch | 70 个 case，`worker.ts:706-960` | **71 个 case**，`core/src/core/worker.ts:706` 起，文件共 1093 行 |
| `api_call` 未 await、不入队 | `worker.ts:452` | 仍然成立：`worker.ts:453` `handleApiCall(msg);` 裸调用 |
| 主进程 68 个透传方法 | `data-provider.ts:115-183` | `data-provider.ts` 443 行，`callWorkerApi` 调用点 **73 处** |
| admin 路由约 110 条 | — | `core/src/controllers/` 合计 **113 条**；其中 `activity-center-routes.ts:136` 已有**表驱动生成**的雏形 |
| 多账号同时启动 | `runtime-engine.ts:146-151` forEach | 仍然成立：`runtime-engine.ts:150` `accounts.forEach(startWorker)` |
| 网络在途上限 | normal=2, queue=100 | `network.ts:98-103`：normal=2, high=2, low=1, 队列上限 100 |
| `sendMsgAsync` 散布 | 26 个 service 文件 | 仍然成立：**26 个文件** |
| 局部并发锁 7 处 | 3 标志 + 4 Promise tail | 仍然成立：`worker.ts:102/104/111`（farmTaskRunning / friendTaskRunning / harvestSellRunning）+ `activity-center.ts:1418`、`commerce.ts:122`、`friend-interaction-items.ts:692`、`weather-activity.ts:643` 四条 tail |
| **worker 共享写 bug** | Claude 稿确认，Codex 稿称"无直接证据" | **Claude 稿正确，当前仍存在**：`gid-manager.ts:138,187,234` 在 `postToMaster()` 失败时回退 `applyConfigSnapshot({ persist: true })`，经 `account-config.ts:45,49,276` 触达 `saveGlobalConfig()` **全量覆写全局配置文件**（内含全部账号配置），构成跨 worker 丢失更新路径 |
| `rate-limiter.ts` 死代码 | 357 行零引用 | 仍然成立：生产代码零引用 |
| 无 shared 契约目录 | core/web 不共享类型 | 仍然成立：仓库无 `shared/` |
| 测试数量 | 10 个 | 当前 **8 个** `core/tests/*.test.js` |
| 活动硬编码 | activity-center 2020 行 | 仍有 1701 行 + weather-activity 957 行；活动 ID 常量仍是日期 |
| 模块级 `let` 散落 | friend/scheduler 9 处等 | friend/scheduler 8 处、mall 7 处、farm/scheduler 6 处、warehouse 3 处 |
| 账号内启动错峰 | 2/8/45/60 秒固定节奏 | 仍然成立：`worker.ts:316-335`，**所有账号同一节奏**，跨账号波峰依旧 |
| 推送入口 | landsChanged 等 | 仍然成立：`farm/scheduler.ts:359`、`friend/scheduler.ts:582` 等，独立于统一 tick |

结论：**两份文档的诊断基础可靠，Claude 稿在 gid-manager 共享写这一事实上更准确。**
以下评估与方案建立在当前 HEAD 的事实之上。

---

## 2. 对两份文档的评估

### 2.1 共识（两份文档一致正确、本文直接继承的部分）

1. **保留"一账号一 worker"隔离边界**，不做全局 FIFO（跨账号队头阻塞）；
2. **账号内需要唯一业务执行入口**，`Enter → 操作 → Leave` 必须是不可穿插的原子事务；
3. **推送风暴必须去重合并**（100 次 landsChanged → 1 次巡田）；
4. **generation 机制**从只保护登录流程推广到全部任务与缓存，断线整队作废；
5. **批量任务必须切片让步**（单好友为一片），长任务不阻塞账号；
6. **bootstrap 需要节流** + 基于 `hash(accountId)` 的确定性 jitter；
7. **持久化单写者**，已按账号隔离的文件不动，不引入 Redis/BullMQ；
8. **增量迁移**，每阶段独立可回滚，拒绝大爆炸重写。

这些共识构成本文方案的骨架，不再重复论证。

### 2.2 Codex 稿的价值与不足

**价值：**
- 缺口 A–F 的诊断精确且可验证，尤其是缺口 A（"自动任务内部串行 ≠ 账号所有业务串行"）
  和缺口 B（"请求级排队保不住多请求事务"）——这是竞态问题的两个根；
- 去重合并语义表（§7）、非幂等重试策略（§12.3）、批量切片规则（§8.2）
  是可直接落地的设计细节；
- "不推荐的替代方案"（§19）排除了六条弯路，每一条都正确。

**不足：**
1. **过度设计倾向**：12+ 字段的 TaskDescriptor、7 态生命周期、
   `waiting-admission` 状态、deficit round-robin——对一个单机多 worker 项目，
   这些是"为未知负载预留的架构"。Codex 稿自己也承认"master 目前尚无数据证明
   需要复杂全局调度"，但仍把完整模型写了出来；
2. **阶段 0 成本过高**：要求先建 fake clock + fake Gateway + 全套并发测试再动手，
   在只有 8 个测试文件的现状下，这一阶段本身就足以让重构流产；
3. **视野局限于调度**：没有回答"新增一个功能为什么要改 6 层"——
   调度改得再好，71 个 case 的 switch 和 73 处透传仍然在那里增长；
4. **读路径未定型**：§20.3 把"哪些查询可以绕过执行器"留作开放问题，
   但这恰恰是 UI 响应性能的关键决策，不能留给实现者。

### 2.3 Claude 稿的价值与不足

**价值：**
- "改动放大系数"排序抓住了全局：**契约层（P1）> 协议边界（P2）> 活动数据化（P3）>
  调度（P4）> 状态（P5）**。其中 P3（活动内容硬编码）是唯一**随时间**恶化的成本项，
  Codex 稿完全未触及；
- 指出 `farm/api.ts`、`friend/api.ts` 已是协议层的正确样板，
  以及"业务规则无法脱网单测 → 测试只有个位数"的因果链——诊断深刻；
- 确认了 gid-manager 共享写 bug（Codex 稿在此事实上判断失误）；
- "明确不做 + 重新评估触发条件"的写法（§6）比留在待办清单里更诚实。

**不足：**
1. **调度设计太薄**：§2.4 只有"分级并发 / 去重 / 优先级 / 取消"四句话，
   没有回答：dedupe key 怎么定义？批量任务怎么切片？跨账号公平怎么做？
   非幂等操作怎么重试？——这些正是"临危不乱"的核心；
2. **契约代码生成的前期投入被低估**：生成器要覆盖 71 个方法 + 113 条路由 +
   web client，本身就是一个子项目。"第一步立骨架约 1 周"偏乐观；
3. **把契约层放在调度之前落地，顺序值得商榷**：先建契约生成器，
   竞态问题在过渡期原封不动；而用户的痛点（多账号竞态）是正确性问题，
   正确性应优先于可维护性；
4. 全局协调只有一句"bootstrap 信号量"，多账号维度的设计基本缺席。

### 2.4 本文的取舍

| 议题 | 取舍 |
|---|---|
| 第一优先级 | **账号执行器（正确性）先于契约层（可维护性）**。竞态是正确性缺陷，契约是成本缺陷；先止血，再治病 |
| 任务模型 | 取 Codex 的语义（dedupe/切片/重试分级），砍其字段数量与状态机规模 |
| 全局协调 | 取两稿共识的最小集：bootstrap 信号量 + bulk lease + 确定性 jitter，**不做** DRR/公平算法，但把扩展点钉死 |
| 契约层 | 保留 Claude 的方向，但降级为**第二阶段演进**：先"声明式注册表"（手写、有类型），验证收益后再谈代码生成 |
| 活动数据化 | 认可方向，独立成第三阶段，不与调度重构耦合 |
| 读路径 | 本文给出明确设计（§4.3 读取三分法），不留开放问题 |
| gid-manager bug | 列为 **P0**，独立于重构立即修 |

---

## 3. 全局问题定义：三层竞态模型

"多账号、任何功能都可能有竞态"可以精确分解为三层，每层的机制与解法不同：

```
┌─────────────────────────────────────────────────────────────┐
│ R3 持久化层竞态（跨进程）                                     │
│    worker × N → 同一文件 read-modify-write                   │
│    实例：gid-manager.ts:138,187,234 → saveGlobalConfig()     │
│    解法：单写者原则 + 写入所有权清单（§6）                     │
├─────────────────────────────────────────────────────────────┤
│ R2 跨账号资源竞态（主进程）                                   │
│    启动波峰（同一 2/8/45/60s 节奏）、批量访问压测网关、        │
│    全局配置读写                                               │
│    解法：全局仲裁器 GlobalArbiter（§5）                        │
├─────────────────────────────────────────────────────────────┤
│ R1 账号内业务竞态（worker 内）                                │
│    4 类入口（UI api_call 未 await / 统一 tick / 独立 timer /  │
│    服务端推送）× 7 处互不知情的局部锁                          │
│    解法：账号执行器 AccountExecutor（§4）                      │
└─────────────────────────────────────────────────────────────┘
```

关键判断：**R1 是竞态的主战场**（每一层局部锁都只保护自己的模块），
R2 是规模问题（账号数 × 功能数的乘积效应），R3 目前只有一个确认的 bug 但要防复发。
三层共用一套任务抽象，但并发策略各自独立。

### 3.1 当前真实的资源冲突矩阵

把散落各模块的隐式冲突显式化（这是今天每加一个功能都要重推一遍的东西）：

| 资源 | 竞争者 | 当前保护 | 冲突后果 |
|---|---|---|---|
| 好友访问上下文（Enter/Leave 之间） | 好友 tick、天气好友页、互动道具、手动 doFriendOp | **无跨模块保护** | Enter(B) 穿插进 A 的访问事务，操作打到错误的 farms |
| 自己农场土地状态 | 巡田 tick、landsChanged 推送、手动种植/施肥/收获、收售流程 | farmTaskRunning / harvestSellRunning 只管自己 | 读到过期土地 → 重复播种、收获判定错误 |
| 背包 / 金币 / 钻石 | 商城购买、仓库出售、道具使用、神秘商店 | commerce.purchaseTail 只管购买 | 余额校验与扣款之间被穿插 → 超卖或购买失败 |
| 活动可变更状态 | 活动中心、天气、互动道具各自的 mutationTail | 各自 tail，互不知晓 | 两个活动同时改共享道具/积分 |
| 账号配置（内存+磁盘） | gid-manager、UI 设置、账号热更 | 无 | R3 层：worker 全量覆写全局配置 → 其他账号配置丢失 |
| 登录/连接生命周期 | 以上全部 | runtimeGeneration 只保护登录 | 断线后旧任务继续跑、旧回包写脏新会话 |

这张矩阵就是调度器的"需求文档"：**任何新功能只需要声明自己触碰哪一行资源，
冲突由执行器保证，而不是由开发者推演。**

---

## 4. R1：账号执行器 AccountExecutor

### 4.1 核心模型：意图与执行分离

```
timer / push / UI api_call / tick / startup
        │
        ▼  只提交"意图"（Intent），不直接执行业务
┌──────────────────────────────┐
│ IntentQueue（每账号一个）      │
│  dedupe · 优先级+aging ·      │
│  deadline · generation 校验   │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ AccountExecutor（每账号一个）  │
│  mutate/transaction 串行槽 ×1 │
│  read 并发放行（§4.3）         │
│  AbortController 绑定代际      │
└──────────────┬───────────────┘
               ▼
     handler registry（替代 71 个 case 的 switch）
               ▼
     现有 service 函数（第一阶段原样包裹，不改协议行为）
```

**关键转变**：`worker.ts:453` 的 `handleApiCall(msg)`、`worker.ts:142/316-365`
的 timer、`farm/scheduler.ts:359` 的推送回调，全部改为 `executor.submit(intent)`。
`runUnifiedTick()` 不再是"业务执行者"，只是周期性的意图生产者。
`services/scheduler.ts` 保留管 timer 生命周期，但回调体只剩一行 submit。

### 4.2 Intent 定义（字段从 Codex 稿裁剪到 8 个）

```ts
interface Intent {
  type: string                    // 'farm.check' | 'friend.visit' | 'api:getLands' | ...
  source: 'api' | 'timer' | 'push' | 'tick' | 'startup'
  priority: 'interactive' | 'event' | 'scheduled' | 'maintenance'
  effect: 'read' | 'mutate' | 'transaction'   // 决定并发策略，见 §4.3
  dedupeKey?: string              // 命中即合并（§4.4）
  deadline?: number               // 过期不执行陈旧操作
  generation: number              // 断线整队作废
  run: (signal: AbortSignal) => Promise<unknown>
}
```

砍掉 Codex 稿的：`waiting-admission` 状态、lease 字段、parentTaskId/任务树、
retryPolicy 枚举（重试策略收进 §7 的统一表，不挂在每个任务上）、correlationId
（保留，但作为日志 context 而非调度字段）。

状态机只要四态：`queued → running → succeeded | failed | cancelled | expired`
（后四者为终态，合并记录）。7 态生命周期留给账号（READY/DEGRADED/OFFLINE 三态沿用现状，
出现真实需求再扩），不叠加在任务上。

### 4.3 读取三分法（补上 Codex 稿留下的开放问题）

71 个 API 方法中纯读占比很高，一刀切串行会让 UI 被后台巡田卡死。
但"read 不占串行槽"（Claude 稿）还不够细，读取必须分三类：

| 类别 | 语义 | 路径 | 例子 |
|---|---|---|---|
| `read-snapshot` | 读内存快照，**不发 RPC** | 完全绕过执行器与网络队列 | UI 刷新土地/背包展示、状态轮询 |
| `read-fresh` | 必须发 RPC 拿最新，但**不改服务器状态** | 走 IntentQueue，不占串行槽，可并发；受 singleflight 合并 | 手动点"刷新"、进入好友页首次加载 |
| `mutate` / `transaction` | 改服务器状态 | 占串行槽，严格排队 | 种植、收获、购买、Enter→操作→Leave |

配套规则：
- 每个 `read-fresh` 完成后把结果写入快照，`read-snapshot` 永远有数据可读；
- 串行槽只服务写路径，配合 `MAX_NORMAL_IN_FLIGHT_REQUESTS = 2`（`network.ts:98`），
  写路径在途请求恒为 1，读请求用另一个槽——**UI 响应不被后台任务阻塞**，
  这是性能设计的关键，两稿对此结论一致，本文将其落实为分类规则；
- `transaction` 与 `mutate` 共享同一串行槽，但 transaction 持有期间
  **不允许任何其他 intent 穿插**（包括 read-fresh 针对同一资源时降级为读快照）。

### 4.4 去重合并矩阵（落到当前真实功能）

| Intent | dedupeKey | 合并策略 |
|---|---|---|
| `farm.check`（巡田） | 常量 | 队列已有则合并；100 次 landsChanged 推送 → 1 次 |
| `friend.scan` / `friend.visit:{gid}` | 类型 / 类型+gid | 同 gid 合并；手动触发提升已在队任务的优先级 |
| `weather.inspect:{gid}` | 类型+gid | 与 friend.visit 同 gid 时**挂到同一事务后**，不重复 Enter |
| `api:getXxx`（read-fresh） | 方法+参数哈希 | singleflight，共享进行中 Promise |
| 配置同步 | 常量 | latest-wins，只留最新快照 |
| 购买 / 领取 / 使用道具 | **无 dedupeKey，默认不合并** | 见 §7 非幂等策略 |
| 每日例行 / 神秘商店 | 类型 | 过期（deadline）直接丢弃，不补跑 |

队列满时的背压顺序：先丢过期 maintenance → 合并 scheduled/event →
interactive 永远保留但受 generation 约束。**不允许低优先级任务无限积压后集中补跑。**

### 4.5 批量任务切片

好友扫描、天气扫描这类长任务采用父子结构（比 Codex 稿的任务树简化为一层）：

```
friend.scan（父）
  1. 拉一次好友摘要，生成候选 gid 列表与游标
  2. 每轮 submit 一个 friend.visit:{gid}（子），然后让出串行槽
  3. 子事务结束 → 父收到回调 → 提交下一个
```

切片规则：
- 每片最多一个好友；片间 interactive 意图可以插入（用户点了一下施肥不用等 200 个好友偷完）；
- 每片结束检查 `AbortSignal` + generation + deadline；
- 连续失败 N 次（建议 3）父任务整体退避/暂停；
- 父任务只需内存态（游标、成功/失败数），**不持久化**——重启后由配置重新生成，
  这是与 Codex 稿"游标持久化"有意的分歧：当前没有断点续跑的真实需求。

### 4.6 取消与代际

- 一个 `AbortController` per generation，绑定 `runtimeGeneration`（`worker.ts:116` 已有）；
- 断线/停止：generation 递增 → 整队作废 + 运行中任务在安全边界退出
  （transaction 做完当前 RPC 后退出，Leave 必须在 finally 里发出）；
- 旧 generation 的回包一律不写入缓存与状态——这条要有测试断言。

---

## 5. R2：全局仲裁器 GlobalArbiter（主进程，刻意做小）

主进程不执行任何业务，只管三样东西。**先把扩展点钉死，但不提前实现算法。**

### 5.1 bootstrap 准入（立即做，约 30 行）

`runtime-engine.ts:150` 的 `accounts.forEach(startWorker)` 改为：

- 并发 **2** 的信号量；
- 每个账号内部现有的 2/8/45/60s 节奏（`worker.ts:316-335`）整体叠加
  `hash(accountId + taskType) % jitterWindow` 的**确定性** jitter——
  消除"所有账号同一秒做同一件事"的跨账号波峰，且重启后可复现（不用 Math.random）。

### 5.2 高压力任务 lease（第二阶段做）

- 资源清单：`bulk-friend-visit`（全局同时只允许 1 个账号做批量好友访问）；
- worker → 主进程 `acquireLease(resource, accountId, taskId, ttl)` → granted/deferred；
- 释放放 `finally`；worker 崩溃 lease 随 TTL 自动过期；
- **普通账号内任务不过主进程**——lease 只覆盖实测高压力任务，主进程绝不成热点；
- 死锁防护：全局准入在切片开始前完成；禁止 handler 持有串行槽时同步等待 lease
  （先申请后占槽，固定获取顺序）。

### 5.3 全局观测口（与 5.1 同期）

主进程聚合各 worker 的队列快照：每账号 queued/running、当前任务与时长、
DEGRADED 状态。这是日后判断"要不要上公平算法"的唯一依据——
**没有观测数据就不做 DRR，有数据时加在 Arbiter 里，业务层零改动。**

### 5.4 账号健康与降级

沿用现有 READY/DEGRADED/OFFLINE 三态，补充 DEGRADED 的进入信号
（连续超时、心跳延迟上升、queue 长期超限）与行为约定：
DEGRADED 停 maintenance 与大部分 scheduled，保心跳与 interactive；
恢复时逐步放开，**不瞬间重放积压队列**（过期任务已按 §4.4 丢弃，天然满足）。

---

## 6. R3：持久化所有权

### 6.1 P0：立即修 gid-manager 共享写（独立于重构，半天）

`gid-manager.ts:138,187,234` 的 `postToMaster()` 失败回退路径
`applyConfigSnapshot({ persist: true })` 会让 **worker 全量覆写全局配置文件**
（`account-config.ts:276` → `saveGlobalConfig()`），多账号并发时互相覆盖。

修法（Claude 稿方向，本文确认）：**worker 永不做 persist 回退**。
`postToMaster` 失败 → 仅保留内存态（`persist: false`）并记录日志，
下一轮同步自然重试；持久化只走 `known_friend_gids_sync` 由主进程写。
同时给 `applyConfigSnapshot` 加一条防线：worker 进程内调用 `persist: true`
直接 throw（开发期即暴露，而非等数据丢失）。

### 6.2 写入所有权清单

形成一份显式清单（路径模式 → owner → scope → 是否 read-modify-write），
并加测试断言"worker 进程 import 不到 `saveGlobalConfig` 的写路径"。
已按账号隔离的文件（`stats.ts:5-7`、`friend/scheduler.ts:79-83`、
`activity-center-state.ts:148-159`）**保持不动**。
不做 StorageActor、不迁 SQLite——触发条件：出现第二条共享写路径，或单文件 >10MB。

### 6.3 缓存统一（随执行器落地顺带做）

模块级 `let`（friend/scheduler 8 处、mall 7 处、farm/scheduler 6 处等）迁入
`AccountState`，由 executor 持有，generation 变化整体重建——
不再依赖每个模块自己记得清理。缓存项统一带
`status: confirmed | stale | unknown | failed`（区分"确认没有"与"查询失败"）
与 `expiresAt`、`generation`。删除死代码 `rate-limiter.ts`。

---

## 7. 非幂等操作与重试（"临危不乱"的另一半）

竞态治理保证"不交叉"，重试治理保证"出错时不雪上加霜"。统一策略表：

| 操作类别 | 例子 | 策略 |
|---|---|---|
| 只读 | getLands / getBag / getFriends | 指数退避 + jitter，可多重试 |
| 幂等设置 | 配置同步、标记已读 | 有限重试（≤3） |
| **非幂等变更** | 购买、领取奖励、使用道具、兑换 | **结果未知时禁止盲目重试**；先读/验后置状态再决定补偿；协议允许处带幂等键 |
| 事务型 | Enter→操作→Leave | 中途失败：Leave 必须发出（finally），事务整体标记 failed，不部分重放 |

所有非幂等 intent 默认 `deadline` 较短（如 30s）——
排队过久的购买请求宁可过期也不执行陈旧操作。

---

## 8. 契约层：从注册表到生成（第二阶段演进，不与调度耦合）

认可 Claude 稿 P1 的判断（六层管道是最大的维护成本），但分两小步降风险：

**第一步（随 §4 落地）：handler 注册表替代巨型 switch。**
`worker.ts:706` 的 71 个 case 改为 `handlers.register('getLands', fn)` 的挂载表，
每条带 `effect` 声明（供 §4.3 使用）。`data-provider.ts` 的 73 处透传
用一个按名转发的 Proxy 收敛。这一步**手写、类型可查、无生成器**，
已消灭"方法名字符串重复 10+ 处"和最易错的参数位置传参。

**第二步（验证收益后再做）：单一契约 + 生成。**
把注册表升格为 `shared/contract/`（core/web 共享类型），
路由与 web client 由契约生成。依据：`activity-center-routes.ts:136`
已经存在表驱动生成的雏形，说明这条路在代码库里已被局部验证。
若第一步后改动成本已可接受，第二步可以无限期推迟——**生成器是优化项，不是正确性前提。**

活动数据化（content/*.json + 玩法适配器）方向正确，
作为**独立第三阶段**处理，不与调度重构互相阻塞。

---

## 9. 迁移路线

每阶段独立可回滚；不存在"改到一半跑不起来"的中间态。

### 阶段 0：止血与基线（1–2 天）

1. **修 gid-manager 共享写**（§6.1），加 worker 禁写全局配置的断言；
2. 记录基线：每账号请求量、巡田周期、好友一轮耗时、UI 只读 P95——
   这是性能回归可发现的唯一前提（两稿共识，本文确认为强制前置）；
3. 给日志加 intent type + generation 标记（不加全套 tracing）。

### 阶段 1：AccountExecutor（核心，约 1 周）

1. 实现 IntentQueue + 串行槽 + 读取三分法 + dedupe + deadline + generation 取消；
2. handler 注册表替代 71-case switch，service 函数**原样包裹，不改协议行为**；
3. 收敛 4 类入口：`api_call`、tick、timer、推送全部改 submit；
4. 删除 7 处局部锁与 `rate-limiter.ts`；
5. 本阶段内不发中间版本（局部锁与新队列不得共存，否则两层串行）。

**完成后 R1 竞态在机制上消除**——这是整个重构收益最大的一步。

### 阶段 2：切片与全局准入（约 3–4 天）

1. 好友/天气批量改父子切片；
2. bootstrap 信号量 + 确定性 jitter；
3. bulk-friend-visit lease；全局观测口。

### 阶段 3：状态与缓存统一（约 3 天）

模块级 `let` 迁 AccountState，缓存统一结构，写入所有权清单 + 断言测试。

### 阶段 4（可选，按收益决定）：契约生成、活动数据化

独立排期，不阻塞上述任何阶段。

### 与两稿迁移策略的分歧说明

- **不同意 Codex 稿的"阶段 0 先建 fake clock/gateway + 全套测试"**：
  改为"阶段 1 的每个能力带自己的单测"（队列语义、dedupe、取消均可脱离网络测），
  fake gateway 推迟到阶段 4 的领域层剥离时才有必要；
- **不同意 Claude 稿的"契约生成器先进第一步"**：生成器降级为阶段 4 可选项，
  第一步的手写注册表已能拿到 80% 收益；
- 两稿共识的"逐领域独立 PR、随时可回滚"完整继承。

---

## 10. 验收标准

**正确性（测试断言）**

1. 同账号任意时刻至多 1 个 mutate/transaction 在执行；
2. `Enter → 操作 → Leave` 不被另一 gid 穿插（构造并发 visit 断言 RPC 序列）；
3. 100 次 landsChanged 推送只产生 1 次有效巡田；
4. 断线后：队列清空、运行中任务取消、旧 generation 回包不写缓存；
5. 非幂等操作在网络超时后**不发生重复执行**（验证后置状态再补偿）；
6. worker 进程调用 `applyConfigSnapshot({persist:true})` 立即抛错；
7. 批量任务执行中插入 interactive 意图，能在 ≤2 个切片内得到执行（防饥饿）。

**性能（对照阶段 0 基线）**

8. 每账号请求量、巡田周期、好友一轮耗时漂移 ≤ ±20%；
9. UI 只读请求 P95 不因后台任务运行而上升（读取三分法生效）；
10. 20 账号同时启动：bootstrap 并发 ≤2，启动错峰可复现。

**架构约束（静态检查）**

11. `worker.ts` 无 switch 分发，行数 < 400；
12. 所有 intent 经注册表挂载，`effect` 声明全覆盖；
13. 推送/timer/api_call 路径上不存在绕过 executor 的业务调用（grep 断言）。

---

## 11. 明确不做（附重新评估触发条件）

| 内容 | 决定 | 触发条件 |
|---|---|---|
| DRR / round-robin 账号间公平 | 只做信号量 + lease | 观测口显示账号等待时间显著不均 |
| 任务树 / 游标持久化 / 断点续跑 | 父子一层 + 内存游标 | 单批次 >5 分钟且用户明确要求续跑 |
| 7 态任务/账号状态机 | 任务四态 + 账号三态 | 出现需要区分 BOOTSTRAPPING 的真实功能 |
| StorageActor / SQLite | 不做 | 第二条共享写路径出现，或单文件 >10MB |
| 契约代码生成器 | 阶段 4 可选 | 手写注册表被证明仍是改动瓶颈 |
| 活动 JSON 化 | 独立阶段 | 下一个季节活动立项时 |
| 异步 job API（jobId 轮询） | 不做，用切片+进度推送 | UI 出现稳定 >10s 的交互任务 |
| Redis / BullMQ | 不做 | 需要跨主机调度 |

---

## 12. 一页总结

```
问题分层：R1 账号内竞态（主战场）/ R2 跨账号规模 / R3 持久化
骨架：    意图与执行分离 → AccountExecutor（串行写槽 + 读取三分法）
          → GlobalArbiter（bootstrap 信号量 + bulk lease + 观测口）
          → 持久化单写者（先修 gid-manager，P0）
演进：    注册表（手写）→ 契约生成（可选）→ 活动数据化（独立）
原则：    新功能只声明"碰什么资源、什么 effect"，
          冲突由执行器保证，不再由开发者推演冲突矩阵。
顺序：    正确性（执行器）→ 规模（全局准入）→ 状态（缓存/持久化）→ 成本（契约/活动）
```
