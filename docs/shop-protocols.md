# 神秘商人、游戏商城与购买协议

神秘商人样本复核于 2026-08-14；商城字段与购买条件已按 2026-09-24 官方客户端和完整回包重新核对。抓包目录由解码脚本参数传入。网关外层统一是
`gatepb.Message`：`meta` 描述 service/method，`body` 是业务 protobuf。客户端
请求 body 使用 `core/src/utils/tsdk.wasm` 的 TSDK `ba` 变换，服务端响应在抓包中
已经是明文 protobuf；不要对响应再次调用 TSDK 解密。

## 神秘商人

`gamepb.mysteryshoppb.MysteryShopService.GetActiveNPC`

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `is_active` | bool | 当前是否存在有效神秘商人（抓包为 `true`）。 |
| `npc` | ActiveNPC | 当前商人的一条活动商品/配置。 |
| `active_time` | int64 | 活动开始 Unix 秒；抓包为 `2026-08-05 16:27:15`（东八区）。 |
| `expire_time` | int64 | 活动结束 Unix 秒；抓包为次日同一时刻。 |

`ActiveNPC` 的 `npc_id` 和 `reward_item_id` 分别对应商人实例与出售物品。字段 3 的
真实含义尚未确认，暂命名为 `unknown_field_3`，不能作为商品数量使用；字段 4
`reward_count` 才是本次交易获得的商品总量。`currency_item_id` 是货币物品 ID，
`price` 和 `original_price` 分别是折后单价与原始单价，整批价格需要乘以
`reward_count`。`discount_percent` 是价格百分比，例如 60 表示 6 折。字段 8 在协议中
保留，不能发送。

2026-08-14 的样本为艾草种子：字段 3 为 2、`reward_count` 为 8、折后单价 6000、
原始单价 10000、`discount_percent` 为 60。对应游戏展示为 `x8`、原价 80000、
6 折、优惠价 48000，确认字段 4 才是数量字段。

## 游戏商城列表

`GetMallListBySlotTypeRequest` 的 `slot_type` 是商城槽位，field 2 是布尔值 `is_manual_open`，不是子槽位；
普通商城 slot 为 1，SVIP 商城 slot 为 4。响应的 `goods_list` 是重复的 `MallGoods` 消息（不是 bytes），
`refresh_countdown` 是刷新倒计时秒数；抓包值 27076 与 16:28:43 到当天 24:00
的剩余时间一致。

2026-11-02 官方请求同时携带 field 3 `global_scene_id=1`（农场）；限时商店 slot 为 5。新增藏品礼包 1047（金豆豆 300，奖励物品 101619）和 1048（钻石 40，奖励物品 101618）均由实时目录读取，不静态推断售价或限购。商品 field 21/22 为 `bg_pic` / `color`，已保留；购买请求仍为商品 ID 与数量。

两种藏品礼包各实购一次：`Purchase` 的数量均为 1、成功标志为 true、每周限购已购数为 1/50。金豆豆通过 `ItemNotify` 确认扣除 300；钻石通过 `RechargeInfoNotify.info.balance` 确认 302→262。该通知的 field 1 是嵌套的 `RechargeInfo`，已纠正原先按交易号字符串解码的定义。

“立即使用”在购买后另发 `ItemService.Use`。本次钻石礼包实际产出 101622 ×1、桃米 700005 ×1、金币 100000，结果取使用回包，不从礼包描述推算。`UseReply` field 100 的 `random_pack` 返回各奖池剩余数量，已补齐协议；既有 `used_items` / `items` 字段名保留兼容调用方。

## 道具商店

游戏“商店 → 道具”使用 `gamepb.shoppb.ShopService.ShopInfo(shop_id=4)`，与 MallService 的 SVIP slot 4 是两套接口。`BuyGoodsRequest` 为商品 ID、购买数量及实际单价；回复包含 `goods`、`get_items` 和 `cost_items`。

`GoodsInfo` field 9–14 分别为 `is_display_countdown`、`end_time`、`discount_price`、`discount_start_time`、`discount_end_time`、`show_conds`（字符串 `type` / `params`）。有效促销期内 `discount_price=0` 会被 proto3 省略，不能因此回退为基础价格。日期为空或为负的默认时间值不构成促销。

11 月 2 日真实交易确认：商品 20001 青野农家小屋的基础价格是 5400，促销成交价为 0，获得 201007 ×1、无扣费；商品 20003 青野农家街道成交价为 2250，获得 207007 ×1，扣除金豆豆 1005 ×2250。两笔购买均更新已拥有与限购状态。


“开启新田园”是官方 `NEWBIE_OPEN` 新手开园福利（client ID 171），含签到、开园特权、引导奖励，与新地图或蓝晶土地无关。全局活动目录中的 2026092200/2026092201 时间窗不代表当前账号获准参与；官方客户端还检查活动组、个人参与期限和特权期限。此次账号的列表只有全局记录，没有下发该活动组，不能据此构造可领取奖励或写入请求。本工具暂未接入其详情操作。小屋、仓库的来源说明指向该活动，相关商品还带有“2026092201_未参与”的展示条件。

`MallGoods` 中 `reward_items` 是购买得到的物品列表，`price` 是一个 `corepb.Item`
（`id` 为货币 ID、`count` 为单价），`purchase_limit` 保存限购类型/已购数量/上限，
是否限购由 `purchase_limit` 的存在及 `limit_type` 判断；不存在或类型为 0 表示不限购。
`discount_text` 是 UI 文案，`is_discounted` 对应官方倒计时展示标记。
field 8 对应官方 `is_available_purchase`，但普通不限购商品会省略该字段，不能仅凭解码默认 false 禁止购买。

| MallGoods 字段号 | 字段 | 作用 |
| --- | --- | --- |
| 1 | `goods_id` | 购买接口使用的商城商品 ID。 |
| 2 | `name` | 商品展示名称。 |
| 3 | `goods_type` | 商品类别枚举；本批普通商城商品均为 1。 |
| 4 | `reward_items` | 一次购买获得的一个或多个物品及数量。 |
| 5 | `price` | 价格；物品 ID 表示货币，数量表示单价。空消息代表免费。 |
| 6 | `is_free` | 免费商品标记。 |
| 7 | `purchase_limit` | 限购类型、已购数量、限购上限。 |
| 8 | `is_available` | 官方名为 `is_available_purchase`；不限购商品省略时不可据此判为不可购买。 |
| 9 | `discount_text` | 折扣展示文字，例如 `7.4折`。 |
| 10 | `is_discounted` | 官方名为 `is_display_countdown`，控制倒计时展示。 |
| 11 | `discount_end_time` | 折扣结束 Unix 秒。 |
| 12 | `product_type` | 官方名为 `goods_type`，表示商品类型，不是可购买标志。 |

2026-09-24 普通商城原始回包 `session-1790215551955/001343-recv.bin` 中，
1002、1003、1006（点券化肥/狗粮）以及 1007–1017 的单份钻石商品没有限购消息，也没有 field 8。
官方 `RechargeProductModel.isNoLimit` 与 `RechargeGiftBuy.buyGiftHandler` 按限购类型及余额检查这些购买。
后台仅对普通商城的不限购商品采用此规则，仍重新校验余额、报价和广告/分享/已拥有限制；SVIP 仍检查会员资格及商品标志。

相同回包中的免费商品 1001 已领取 1/1，商品 1044 已购满；页面分别显示“已领取”和“售罄”。
“余额不足”“余额未确认”“SVIP 限定”及其他购买限制独立展示，不再统一显示“暂不可购买”。

## 购买商品

`PurchaseRequest`：`goods_id` 为商品 ID，`count` 为购买数量。响应返回商品 ID、
`success`（field 2，不是购买数量）、重复的 `reward_items` 以及更新后的 `purchase_limit`。购买后网关还会推送
`gamepb.itempb.ItemNotify`（背包/货币增量）和 `gamepb.mallpb.NeedNotify`（商城刷新提示）。

抓包中的两次购买分别为：商品 1001 x1，返回化肥 80001 x1；商品 1029 x1，返回
29003 x1、有机化肥 80011 x2、普通化肥 80001 x2，并从点券 1002 扣除 25。
`PurchaseLimit` 的字段 1 是周期类型（本批样本中 1=每日、4=活动期），字段 2 是已购数，
字段 3 是上限。

两条 `ItemNotify` 中的 `corepb.Item.field 100` 是 `ItemShow` 展示元数据，多数为空；
商品 1029 奖励的 29003 带有 `sell_price`（1001=金币，数量 12000）。项目已保留这个
强类型字段，因此通知也可以无损重编码。

可复现解码：

```text
pnpm -C core exec node ../tools/decode-shop-protocols.js "D:\path\to\captures"
```

每行输出中的 `roundtrip: true` 表示“解码后重新编码”的字节与抓包业务 body 完全一致，
可用于确认没有遗漏任何 wire 字段。
