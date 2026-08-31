# QQ 农场架构重构方案

> 状态：架构设计，替代 `docs/scheduling-architecture-proposal.md`
> 编写日期：2026-08-27
> 代码基线：`origin/master` @ `85e99e8caeb70a8fab48edadde09a5df0224b0b7`
> 目标：**显著降低长期维护成本**，其次改善多账号负载与性能
> 代码事实均通过 `git show origin/master:<path>` / `git grep ... origin/master` 核实

---

## 0. 为什么要重新划分架构，而不只是修调度

`scheduling-architecture-proposal.md` 把问题定位在调度层。调度确实有问题（本文 §2.4），
但按"改一个功能要动多少地方"来度量，调度只排第四。

以新增一个用户可见操作 `buyWeatherBottle` 为例，实际需要改动 **6 个层次**：

| # | 层 | 文件 |
|---|---|---|
| 1 | 业务实现 | `core/src/services/activity-center.ts:830` |
| 2 | worker 分发 | `core/src/core/worker.ts:876-877`（switch case） |
| 3 | 主进程代理 | `core/src/runtime/data-provider.ts:177` |
| 4 | HTTP 路由 | `core/src/controllers/admin/activity-center-routes.ts:193` |
| 5 | 前端 store | `web/src/stores/activity-center.ts:455,1552,1584,1816-1817,1900`（**5 处**） |
| 6 | 前端视图 | `web/src/views/ActivityCenter.vue:244-245,529,534` |

方法名 `'buyWeatherBottle'` 这个字符串在 core 与 web 中重复出现 **10 次以上**，
没有任何编译期约束；`web/` 与 `core/` **不共享任何类型定义**（仓库中无 shared 目录）。

这条管道当前承载 **约 70 个方法**：`worker.ts` 有 70 个 switch case，
`data-provider.ts` 有 68 个透传方法，admin 路由约 110 条。
**这才是维护成本的主要来源**，且它随功能数线性增长。

因此本文按"改动放大系数"重新排序问题，并据此划分架构边界。

---

## 1. 按维护成本排序的架构缺陷

| 优先级 | 缺陷 | 改动放大 | 增长趋势 |
|---|---|---|---|
| **P1** | 无契约的六层管道，方法名字符串重复，core/web 无共享类型 | 1 个操作 → 6 层 10+ 处 | 随功能数线性增长 |
| **P2** | 无协议层边界：26 个 service 文件直接调 `sendMsgAsync`，业务规则与 protobuf 编解码混写 | 业务规则无法脱离网络单测 | 随协议面增长 |
| **P3** | 活动内容硬编码为代码：`activity-center.ts` 2020 行混装 5 个活动，活动 ID 是日期常量 | 每个季节性活动 +几百行永久代码 | **随时间无限增长** |
| **P4** | 无统一执行模型：账号内 4 个业务入口 + 7 处局部并发锁 | 每个新功能需重推冲突矩阵 | 随模块数平方增长 |
| **P5** | 状态所有权隐式：模块级 `let` 散落，缓存无统一结构/TTL/失效 | 断线、跨账号问题反复复发 | 缓慢增长 |

### P1：无契约的六层管道

见 §0。补充事实：

- `worker.ts:706-960` 的 `handleApiCall` 是一个约 250 行、**70 个 case** 的 switch，
  内部大量 `require('../services/xxx')` 动态引入，静态分析无法追踪依赖。
- `data-provider.ts:115-183` 是 68 行几乎完全同构的透传：
  `(accountRef, ...args) => callWorkerApi(resolveAccountRefId(accountRef), '<name>', ...args)`。
  这 68 行没有承载任何逻辑，纯粹是手写的样板。
- 参数类型在跨 worker 边界时退化为 `args[0]`、`args[1]`（`worker.ts:877` 等），
  类型信息全部丢失。

### P2：无协议层边界

`sendMsgAsync` 的调用分布在 **26 个 service 文件**中：

```
activity-center.ts    18 处
farm/api.ts           14 处   ← 正确：这是协议层
friend/api.ts         13 处   ← 正确：这是协议层
weather-activity.ts    7 处
warehouse.ts           6 处
task.ts / share.ts / pets.ts / email.ts   各 5 处
... 另外 17 个文件各 1-4 处
```

**项目里已经存在正确答案**：`farm/api.ts` 和 `friend/api.ts` 把
`encode → sendMsgAsync → decode` 完整封装，业务层只见普通对象
（例如 `friend/api.ts:117-124` 的 `enterFriendFarm`）。
问题是 30 个领域里只有 2 个这么做。

后果：业务规则（"什么时候该偷菜"）与传输细节（"VisitEnterRequest 的 reason 字段是 2"）
写在同一个函数里，导致业务规则无法脱离网络单独测试——
这直接解释了为什么 `core/tests/` 只有 10 个测试文件。

### P3：活动内容被硬编码成代码（增长最快的一项）

`activity-center.ts` 2020 行，`weather-activity.ts` 932 行，
`activity-center-state.ts` 256 行，`activity-gameplay-registry.ts` 159 行。

其中 `activity-center.ts:28-72` 是 **45 行连续的硬编码常量**：

```ts
const QINGMEI_DAILY_ACTIVITY_ID = '2026081201';   // 青梅活动
const QIXI_GROUP_ID = '2026081800';               // 七夕活动
const WEATHER_GROUP_ID = '2026070300';            // 天气活动
const CONSTELLATION_ACTIVITY_TYPE = '13';         // 星座
const EXCHANGE_SHOP_OPERATE_TYPE = 1;             // 星沙商店
...
```

**活动 ID 是日期。** 这些是会过期的运营内容，却被写成了永久代码。
`activity-gameplay-registry.ts:29-80` 里同样硬编码了 `'2026072700'`、`'2026081800'` 等。

一个文件同时承载星座、七夕、青梅、天气、星沙商店五套彼此无关的玩法，
每套都有自己的 `OPERATE_TYPE` 常量、DTO 转换、错误码。
下一个季节活动来时，这个文件会变成 2500 行，且没有任何机制阻止它。

### P4：无统一执行模型

账号内**同时存在 4 类互不知情的业务入口**：

| 入口 | 位置 |
|---|---|
| UI / API | `worker.ts:452` — `handleApiCall(msg)` **未 await** |
| 统一 tick | `worker.ts:247-258` |
| 独立 timer | `worker.ts:142`(daily)、`worker.ts:362,365`(神秘商店)、`worker.ts:413`(施肥) |
| 服务端推送 | `farm/scheduler.ts:359-360`、`friend/scheduler.ts:577`、`task.ts:338`、`weather-activity.ts:904-911` |

并发保护分散在 **7 处**，互不感知：

```
worker.ts:102,104,111                      farmTaskRunning / friendTaskRunning / harvestSellRunning
activity-center.ts:107,1737-1738           mutationTail
commerce.ts:8,121-122                      purchaseTail
friend-interaction-items.ts:688,691-692    mutationTail
weather-activity.ts:523,602-603            mutationTail
```

网络层（`network.ts:96-101,141-157`）排队的是**单个 RPC**，
保不住 `enterFriendFarm → 操作 → leaveFriendFarm`（`friend/api.ts:117,126`）
这种多请求事务。

### P5：状态所有权隐式

- 模块级可变状态散落：`friend/scheduler.ts` 9 处顶层 `let`、`mall.ts` 7 处、
  `farm/scheduler.ts` 6 处、`warehouse.ts` 5 处。
- 缓存没有统一结构：全仓库只有 `security.ts`、`friend/visit-strategy.ts`、
  `activity-windows.ts`、`weather-activity.ts` 4 个文件出现 TTL 相关字段，
  各写各的，无法区分"确认没有"与"查询失败"。
- **一处真实的共享写入 bug**：`friend/gid-manager.ts:135-138,185-188` 在
  `postToMaster()` 失败时回退 `applyConfigSnapshot({ persist: true })`，
  经 `models/store/account-config.ts:276` 触达
  `models/store/global-config.ts:78` 的 `saveGlobalConfig()`，
  即 **worker 直接全量覆写共享全局配置文件**，构成丢失更新路径。

  （其余持久化确实已按账号隔离：`stats.ts:5-7`、
  `friend/scheduler.ts:79-83`、`activity-center-state.ts:148-159`。）

- 死代码：`services/rate-limiter.ts` 357 行，生产代码零引用。

---

## 2. 目标架构

### 2.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│ L5  交付层   web/ + controllers/admin/                       │
│              路由与前端 client 由 L4 契约生成，不手写         │
├─────────────────────────────────────────────────────────────┤
│ L4  契约层   shared/contract/            ★ 新增，单一真源     │
│              方法名 · 入参/返回类型 · 副作用等级 · 优先级      │
├─────────────────────────────────────────────────────────────┤
│ L3  应用层   core/src/app/                                   │
│              AccountRuntime：任务队列 · 生命周期 · generation │
├─────────────────────────────────────────────────────────────┤
│ L2  领域层   core/src/domain/{farm,friend,bag,shop,...}      │
│              纯业务规则，不认识 protobuf，可脱网单测          │
├─────────────────────────────────────────────────────────────┤
│ L1  协议层   core/src/gateway/{plant,visit,friend,...}       │
│              encode/decode + RPC，唯一 sendMsgAsync 出口      │
├─────────────────────────────────────────────────────────────┤
│ L0  传输层   core/src/utils/network.ts                       │
│              连接 · 心跳 · ACE · 请求队列 · 优先级槽位（保留） │
└─────────────────────────────────────────────────────────────┘

     content/activities/*.json   活动 = 数据，不是代码
     core/src/state/             显式所有权 + 统一缓存
```

**依赖方向严格向下**，用 ESLint `no-restricted-imports` 强制：
L2 不得 import `utils/network`，L1 不得 import `domain/`，L5 不得 import `domain/`。

### 2.2 L4 契约层：消灭六层管道（解决 P1）

单一真源，core 与 web 共同引用：

```ts
// shared/contract/farm.ts
export const farmContract = defineContract({
  getLands: {
    input:  z.void(),
    output: LandsSnapshot,
    effect: 'read',              // read | mutate | transaction
    route:  'GET /api/farm/:accountId/lands',
  },
  buyWeatherBottle: {
    input:  z.object({ count: z.number().int().min(1) }),
    output: BottlePurchaseResult,
    effect: 'mutate',
    route:  'POST /api/weather/:accountId/bottle/buy',
  },
})
```

由契约**生成**而非手写：

| 原来手写的 | 改为 |
|---|---|
| `worker.ts` 70 个 switch case | 生成的 dispatch 表，handler 用 `register()` 挂载 |
| `data-provider.ts` 68 个透传方法 | 生成的 Proxy，0 行手写 |
| `controllers/admin/` 约 110 条路由 | 由 `route` 字段生成，仅鉴权/校验是手写中间件 |
| `web/stores/*.ts` 的 5 处重复声明 | 生成的 typed client + `pending` 状态自动派生 |

**收益**：新增一个操作从"改 6 层 10+ 处"变成
"契约加 1 条 + `register()` 挂 1 个 handler"，且参数与返回值全程类型安全。
`effect` 字段同时被 L3 用作调度语义（见 §2.4），不需要第二处声明。

**这是本次重构收益最大的一项。**

### 2.3 L1 协议层：把编解码收归一处（解决 P2）

把 `farm/api.ts`、`friend/api.ts` 已经验证过的模式推广到全部 30 个领域：

```
core/src/gateway/
  client.ts        唯一 import utils/network 的文件
  plant.ts         AllLands / Harvest / Plant / Fertilize ...
  visit.ts         Enter / Leave / HelpWater ...
  activity.ts      各活动的通用 Operate 请求
  bag.ts  shop.ts  pet.ts  task.ts  mail.ts  ...
```

规则：
- **`sendMsgAsync` 只允许出现在 `core/src/gateway/` 下**（ESLint 强制）；
- gateway 函数只做 encode → 发送 → decode → 转成普通对象，**不含业务判断**；
- gateway 返回领域对象而非 protobuf 消息，`toLong`/`int64String` 之类的
  类型转换（`activity-center.ts:119-135` 现在到处都是）在此终结。

**收益**：L2 领域层变成纯函数集合，可用普通对象做输入直接单测——
这才是把测试从 10 个提到有意义覆盖率的前提。P2 不解决，测试就写不动。

### 2.4 L3 应用层：账号内唯一执行入口（解决 P4）

```
core/src/app/
  account-runtime.ts    账号生命周期 + generation（收编 worker.ts 的全局 let）
  task-queue.ts         账号内唯一业务入口
  handlers.ts           契约方法 → 领域函数的挂载表
```

任务队列只保留 4 个能力：

1. **按 `effect` 分级并发**（直接复用契约字段，无需二次声明）：
   - `read` → 不占串行槽，可并发（快照查询、UI 刷新）
   - `mutate` → 串行
   - `transaction` → 串行且不可穿插（`Enter → 操作 → Leave`）
2. **去重合并**：`dedupeKey` 命中则合并（100 次 `landsChanged` 推送 → 1 次巡田）
3. **优先级 + aging**：`interactive > event > scheduled > maintenance`，防饥饿
4. **取消**：`AbortController` 绑定 `runtimeGeneration`（`worker.ts:116` 已有），
   断线时整队作废

**`read` 不占串行槽是性能设计的关键**：串行化叠加
`MAX_NORMAL_IN_FLIGHT_REQUESTS = 2`（`network.ts:96`）会让写路径在途请求降为 1。
把纯读放行后，UI 响应不被后台巡田阻塞，串行代价只落在写路径。
`worker.ts` 现有 70 个 case 中，纯读占比很高（getLands / getBag / 各类 snapshot）。

同批收敛 4 类入口、删除 7 处局部锁、删除 `rate-limiter.ts`。
`services/scheduler.ts` 保留（管 timer 生命周期，职责不重叠），
但 timer 改为只 `submit` 任务意图，不直接执行业务。

### 2.5 content/：活动降级为数据（解决 P3，增长最快的一项）

把活动从代码变成配置 + 少量玩法适配器：

```
content/activities/
  2026070300-weather.json      { groupId, activityIds, itemIds, operateTypes, ui }
  2026081200-qingmei.json
  2026081800-qixi.json
  2026072700-stellar.json
```

```
core/src/domain/activity/
  engine.ts            通用：查询 / 领取 / 兑换 / 点亮 的统一流程
  gameplay/
    exchange-shop.ts   兑换型玩法（星沙商店、天气商店共用）
    daily-claim.ts     每日领取型（青梅每日种子、七夕、节气共用）
    progress-light.ts  进度点亮型（星座、天气研究共用）
    brew.ts            酿造/多阶段型（青梅）
```

活动 JSON 描述 ID、道具、operate type 和 UI 展示；
玩法适配器**按机制而非按活动名**复用。
新增季节活动的常态路径变成"加一个 JSON"，只有出现全新机制时才写新适配器。

配套：JSON 带 `validFrom` / `validUntil`，过期活动自动不加载，
`content/` 可随版本清理而不必改代码。

**收益**：`activity-center.ts` 从 2020 行拆散后，这条增长曲线被压平——
这是唯一一个**随时间**而非随功能数增长的成本项，不处理会持续恶化。

### 2.6 state/：显式所有权与统一缓存（解决 P5）

```ts
// core/src/state/cache.ts
interface CacheEntry<T> {
  value: T
  status: 'confirmed' | 'stale' | 'unknown' | 'failed'   // 区分"确认没有"与"查不到"
  observedAt: number
  expiresAt: number
  generation: number                                      // 断线自动失效
}
```

- 所有模块级 `let` 缓存迁入 `AccountState`，由 `AccountRuntime` 持有，
  generation 变化时整体重建——不再依赖各模块自己记得清理。
- 写入所有权写成一份**显式清单**（路径模式 → owner → scope），并加测试断言。
- 修 `gid-manager.ts:135-138,185-188`：同步失败即丢弃并下轮重试，
  **worker 不得触达 `saveGlobalConfig()`**。
- 已按账号隔离的文件保持不动，**不引入 StorageActor，不迁移 SQLite**。

### 2.7 主进程：只加 bootstrap 节流

`runtime-engine.ts:151-159` 的 `accounts.forEach(startWorker)`
改为并发 2 的信号量 + 基于 `hash(accountId)` 的确定性 jitter（非 `Math.random()`，
便于复现）。约 20 行。

**不做** lease / TTL / round-robin / GlobalCoordinator——
没有账号饥饿的实测证据前不引入；届时加的位置就是这个信号量，
不需要提前预留架构。

---

## 3. 重构前后的维护成本对比

| 场景 | 现在 | 重构后 |
|---|---|---|
| 新增一个 UI 操作 | 改 6 层 10+ 处，方法名字符串重复，无类型检查 | 契约 1 条 + handler 1 个，全程类型安全 |
| 新增一个季节活动 | `activity-center.ts` +几百行永久代码 | `content/` 加 1 个 JSON |
| 新增一个自动化功能 | 需推演与其他 3 类入口、7 处锁的冲突 | 声明 `effect` + 优先级，冲突由队列保证 |
| 给业务规则加测试 | 需要起网络或大量 mock，实际写不动 | 领域层纯函数，普通对象输入直接测 |
| 排查"断线后状态错乱" | 逐个模块找残留 `let` | generation 变化整体重建 |
| 改一个协议字段 | 全仓库搜 `sendMsgAsync` 调用点 | 只改 `gateway/` 下对应文件 |

---

## 4. 迁移策略

这是一次**结构性重构**，但不需要一次性重写全部业务逻辑。
关键是：**先立边界，再逐领域迁入**。领域迁移彼此独立，可并行、可分批发布。

### 第一步：立骨架（不迁业务，约 1 周）

1. 建 `shared/contract/`，把现有 70 个方法**如实**声明进契约（先不改语义）；
2. 生成器落地：worker dispatch、data-provider、admin 路由、web client 改为生成；
3. 建 `core/src/app/`：`task-queue.ts` + `account-runtime.ts`，
   收敛 4 类入口，删 7 处局部锁与 `rate-limiter.ts`；
4. 建 `core/src/gateway/`，`farm/api.ts` 与 `friend/api.ts` **平移**进去当样板；
5. ESLint 依赖方向规则上线（此时只有 gateway 白名单生效）。

这一步之后，P1 和 P4 已经解决，且**新代码被强制走新架构**——
这是止血点，之后即使旧代码不动，成本也不再增长。

### 第二步：逐领域迁入（可并行，按收益排序）

每个领域一个独立 PR，模式固定：抽 gateway → 抽 domain 纯函数 → 挂 handler → 补测试。

建议顺序（按行数 × 变更频率）：

```
1. activity（2020+932+256 行，变更最频繁）→ 同时落地 content/ JSON 化
2. friend（1073+746+334+310 行）
3. farm（1016+998+491+261 行）
4. bag/warehouse（775 行）、mall/commerce（502+219 行）
5. 其余 20 个小文件，可批量处理
```

### 第三步：state 统一（约 3 天）

模块级 `let` 迁入 `AccountState`，缓存统一结构，写入所有权清单 + 断言测试，
修 `gid-manager` 共享写。

### 关键约束

- **每个 PR 独立可回滚**，不存在"改到一半跑不起来"的中间态；
- 第一步内部不发中间版本（局部锁与新队列不得共存，否则出现两层串行）；
- **动手前先跑一轮当前版本记录基线**：每账号请求量、巡田周期、好友一轮耗时。
  这是唯一的强制前置动作，否则性能回归不可发现。

---

## 5. 验收标准

**架构约束（可静态检查）**
1. `sendMsgAsync` 只出现在 `core/src/gateway/` 下；
2. `core/src/domain/` 不 import `utils/network`；
3. 所有对外方法都能在 `shared/contract/` 找到唯一声明；
4. `worker.ts` 不再包含 switch 分发，行数降到 300 行以内；
5. 单文件超过 600 行需在 PR 中说明理由。

**行为正确性（测试断言）**

6. 同账号不存在两个并发 `mutate`/`transaction` 任务；
7. `Enter → 操作 → Leave` 不被另一 GID 穿插；
8. 100 次 `landsChanged` 推送只产生 1 次有效巡田；
9. 断线后队列清空，旧 generation 结果不写入缓存；
10. 20 账号同时启动，并发 bootstrap 不超过 2。

**性能**

11. 重构后每账号请求量、巡田周期、好友一轮耗时相对基线漂移在 ±20% 内；
12. UI 只读请求的 P95 响应时间不因后台任务运行而上升。

---

## 6. 明确不做

| 内容 | 决定 | 重新评估的触发条件 |
|---|---|---|
| GlobalCoordinator / lease / TTL / 公平算法 | 只做 bootstrap 信号量 | 观测到账号间等待时间显著不均 |
| StorageActor / SQLite 迁移 | 不做 | 出现第二条 worker 共享写路径，或单文件 >10MB |
| 完整任务状态机 / 任务历史持久化 | 不做，只保留 `queue.snapshot()` | 有实际排障需求 |
| 异步 job API（jobId + 轮询） | 不做 | UI 出现稳定超过 10s 的长任务 |
| parent/child 批量任务树 + 游标 | 用队列内让步替代 | 单批次 >5 分钟且需断点续跑 |
| 七态账号生命周期 | 沿用 generation + READY/DEGRADED/OFFLINE 三态 | 出现需要区分 BOOTSTRAPPING 的功能 |
| 引入 Redis / BullMQ | 不做 | 需要跨主机调度 |

把这些写成"不做 + 触发条件"而不是留在待办清单里，本身就是维护成本控制的一部分。

---

## 7. 与前一份提案的差异

| 议题 | `scheduling-architecture-proposal.md` | 本文 |
|---|---|---|
| 问题定位 | 调度层竞态 | 六层管道 > 协议边界 > 活动硬编码 > 调度 > 状态 |
| 调度设计 | 12 字段 descriptor + 7 态状态机 + lease + DRR | 复用契约 `effect` 字段，4 个能力 |
| 活动膨胀 | 未提及 | 列为增长最快项，JSON 化 |
| 协议边界 | 未提及 | 列为测试写不动的根因 |
| 契约/代码生成 | 未提及 | 收益最大项 |
| 持久化 | StorageActor + 可能 SQLite | 修 1 个 bug，其余不动 |
| 迁移 | 5 阶段线性 | 立骨架 → 逐领域并行迁入 |

前一份提案对调度缺口的诊断（缺口 A、B、F）成立，本文予以保留并纳入 §1 的 P4。
其缺口 E 的结论需修正：master 存在一条已确认的 worker 共享写路径
（`gid-manager.ts:135-138,185-188`），不是"仅有惯例风险"。
