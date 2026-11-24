# QQ 机器人单聊推送

把「重要农场动态」和「账号掉线」两类消息，通过 QQ 机器人（QQ 开放平台 C2C 单聊消息）发到自己的 QQ。
它与「系统设置 → 通知设置」里的 pushoo 渠道是两套独立实现，可以同时开启，互不影响。

## 适用场景

- 想要**即时、结构化**的动态：出售、收获、好友照顾、农场/牧场任务、神秘商人自动购买。
- 想在 QQ 里直接看到**物品真实图标**和**好友头像**，而不是一行纯文本。
- 账号掉线（被踢、断线、持续离线）时，希望第一时间在 QQ 里收到提醒，微信账号还能一键重新登录。

## 开关位置

QQ 机器人推送是「推送渠道」里的一项，**默认关闭**：

1. 设置 → 系统设置 → 通知设置 → 点推送渠道区域（「暂未配置推送渠道」那张卡）
2. 「推送渠道」弹窗里第一行就是 **QQ 机器人推送**，打开开关
3. 关闭这个开关后，下面那张 QQ 机器人推送设置卡片会隐藏，服务也停止（不再入队、不再发消息）

`channelEnabled` 就是这个总开关，存在 `store.json` 的 `qqBotPush.channelEnabled`；
卡片里的「开启」是第二个开关（`enabled`），只有两个都开才会真正连网关发消息。

## 前置条件

1. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，拿到 `AppID` 与 `AppSecret`。
2. 机器人需具备**单聊（C2C）消息**权限，并把要接收消息的 QQ 号加入可用范围（沙箱/正式环境按平台规则）。
3. 打开面板「设置 → 系统设置 → QQ 机器人推送」，填入 `AppID` / `AppSecret` 并开启。

## 首次绑定 openid

平台不提供「用 QQ 号换 openid」的接口，只能由用户主动给机器人发一条消息后，从网关事件里读到 `user_openid`。

1. 保存配置并开启开关（服务会用 `AppID`/`AppSecret` 换取 `access_token`，再连 `wss://api.bot.qq.com/websocket/`）。
2. 面板点「监听网关」，或者直接等网关连上。
3. 用要接收消息的 QQ 给机器人发任意一条私聊消息。
4. 面板「接收用户」列表会出现该用户；首个发消息的人会自动成为默认接收用户，也可以手动选择或为不同账号指定不同接收人（`accountRoutes`）。

网关 intents：`1<<25`（`C2C_MESSAGE_CREATE`）+ `1<<26`（`INTERACTION_CREATE`，用于消息按钮回调）。

## 消息形态

- 聚合窗口（默认 60s）内的日志按「接收用户 × 农场账号」分组，每个组合单独一条 Markdown 消息，避免多账号串台。
- 事件行：`- **事件名** ![图标 #20px #20px](url) ×次数 · 🦟×n 💩×n · ![头像 #28px #28px](url)好友名`。
- 清理好友牧场：仓库里没有蚊子/污物的游戏素材图，所以用 emoji 标签表示清掉的数量
  （`hazardMosquito` / `hazardDirt` 由 `ranch/friends.ts` 统计、`ranch/automation.ts` 写进日志 meta），
  奖励物品本身仍然走素材库真图。
- 物品图标：优先用日志 `meta.itemId` 查 `gameConfig` 的物品图，其次按 `itemName`/`plantName`/`name` 查名字表，最后从消息文本里解析「出售 X」「获得 X」。
- 好友头像：按 `meta.friendGid` 或 `friendName` 匹配好友列表缓存里的 `avatarUrl`（公网 https 图片，平台会自动转存）。

元数据由 worker 侧的 `enrichPushMeta()` 补齐（`core/src/core/worker.ts`），出售日志额外带 `itemId`/`itemName`（`core/src/services/warehouse.ts`）；
牧场好友互动（偷取、清理、助产、抚摸、放蚊子）日志带 `friendGid`/`friendName`（`core/src/services/ranch/automation.ts`），
所以 `ranch_steal`、`ranch_cleanFriend` 推出去会带好友头像。

## 事件从哪来

| 开关 | 日志来源 | meta.event |
| --- | --- | --- |
| 出售成功 / 仓库出售 | `services/warehouse.ts` 出售汇总 | `sell_success` / `sell_done` |
| 照顾好友 | `services/friend/visit-strategy.ts` | `照顾好友` |
| 农场任务 | 每日任务领取 | `领取任务` |
| 牧场任务 | `services/ranch/daily.ts` | `ranch_task_claim` |
| 偷取好友牧场 | `services/ranch/automation.ts`（`ranch_${outcome.action}`） | `ranch_steal` |
| 清理好友牧场 | 同上 | `ranch_cleanFriend` |
| 收获作物 | `services/farm/scheduler.ts` | `收获作物` |
| 神秘商人 | `services/mystery-shop-auto.ts` | `神秘商人自动购买` |

## 频率与配额

| 限制 | 默认 | 说明 |
| --- | --- | --- |
| `batchWindowSec` | 60 | 聚合窗口，5–600 秒 |
| `minuteLimit` | 8 | 每分钟最多几条消息（平台上限 20） |
| `dailyLimit` | 800 | 每天最多几条消息（平台上限 1000） |

图片走平台「素材库」：`/v2/media-images/prepare` → 预签名 URL PUT → `complete` 拿到 `qqbot-media://` 链接。
单机器人素材上限 100 张，代码留 10 张余量（`MAX_MEDIA_IMAGES = 90`），超出按 LRU 淘汰，淘汰时先删平台素材再删本地缓存，
避免「本地删了但平台配额没释放」导致后续上传 400。素材元数据落在 `data/qq-bot-media/*.json`。

图标上传失败时，这批消息会以 `_iconRetry` 计数重新排队（最多 3 次），超过次数后降级发送，避免死循环卡住整条链路。

## 账号掉线推送

`worker-manager` 判定掉线（`kickout:` / `disconnect:` / `offline_timeout` / `ws_400`）时调用 `triggerOfflineReminder`；
运行时引擎把它包成 `triggerOfflineReminderWithQqBot`，在原有 pushoo 提醒之外再发一条 QQ 机器人消息。

- 微信账号：消息带「🔄 重新登录」按钮。点按钮会回调 `INTERACTION_CREATE`，先尝试用已保存的扫码凭据免扫码换 Code；
  凭据失效则推送登录二维码（`WxLoginService.createQrSession()`），扫码确认后调用 `reloginAccount` 更新账号并重启 worker。
- QQ 账号：只提醒，不带按钮。

按钮回调按 openid 过滤，只有默认接收用户能操作，其他用户点会被回应「无权限」。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings/qq-bot-push` | 读配置 + 运行状态 |
| POST | `/api/settings/qq-bot-push` | 保存配置（会按 `enabled` 启停服务） |
| POST | `/api/settings/qq-bot-push/test` | 发一条测试 Markdown |
| POST | `/api/settings/qq-bot-push/capture` | 重连网关，等待捕获 openid |
| GET | `/api/settings/qq-bot-push/users` | 已发现用户列表 |
| POST | `/api/settings/qq-bot-push/select-user` | 设为默认接收用户 |
| POST | `/api/settings/qq-bot-push/delete-user` | 删除接收用户并清理路由 |
| GET | `/api/settings/qq-bot-push/details` | 推送记录 / 待发队列 / 素材缓存 |
| POST | `/api/settings/qq-bot-push/delete-records` | 按日期删除推送记录 |

配置持久化在 `store.json` 的 `qqBotPush` 字段，归一化逻辑在 `core/src/config/qq-bot-push.ts`
（事件白名单、数值上下限、账号路由），推送记录单独存 `data/qq-bot-records.json`（最多 500 条）。

## 代码结构

| 位置 | 职责 |
| --- | --- |
| `core/src/config/qq-bot-push.ts` | 事件白名单、默认值、配置归一化 |
| `core/src/services/qq-bot-push.ts` | token 缓存、网关长连接、聚合、素材上传、发送、重登会话 |
| `core/src/runtime/runtime-engine.ts` | 创建服务、日志入队、下线提醒合流 |
| `core/src/controllers/admin/account-routes.ts` | 面板接口 |
| `web/src/stores/qqBotPush.ts` | 前端状态与轮询 |
| `web/src/components/settings/QQBotPushSettings.vue` | 设置卡片、接收用户与推送统计 |
| `web/src/components/settings/PushMessageCard.vue` | 推送内容预览（把 `![名字 #20px #20px](url)` 还原成文本 + 图片） |

## 排查

| 现象 | 原因与处理 |
| --- | --- |
| 状态一直「未连接」 | `AppID`/`AppSecret` 错误，或机器人未开通单聊权限；看全局日志里的「QQ机器人」标签 |
| 捕获不到 openid | 网关按钮点了没连上，或机器人不在该 QQ 的可用范围；重新点「监听网关」后再发一条私聊 |
| 消息发不出、报 400 | 素材库配额满或素材被平台删除；面板「素材缓存」里手动清理后重试 |
| 图标缺失 | 物品名没进 `gameConfig` 名字表，或上传被限流；日志会提示「图标上传未成功」并自动重排队 |
| 收不到掉线提醒 | `offlineNotify` 关闭，或该账号在 `accountRoutes` 里没有接收人 |
