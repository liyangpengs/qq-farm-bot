# 微信连接适配与掉线诊断

## 2026-11-01 游戏与 SDK 复核

QQ、微信的官方 PlayerLogin 和 Heartbeat 均为 `1.16.0.5_20261028`。微信第 77 版官方包使用独立 TSDK `v3.9.0.1793442738`、161,072 bytes 的 `tsdk-wx.wasm`，SHA-256 为 `3d564429885ecb2a73f13860c12eb91f17802f49335cbc2aed9cd01c26257a1c`；QQ 使用 `v3.9.0.1793443245`，两端构建分别更新。

微信宿主 App ID、debug=`2` 和固定表核对一致；同组合成输入下的 119 字节初始化凭据与官方 JS 完全一致。同一实际设备输入下仍有 1 字节差异，保留现有宿主能力缺失状态及 ACEVM 失败返回值，不修改自检结果。协议往返、共享配置和验证边界见 [本次更新记录](collections-20261101.md#微信独立复核)。


## 2026-10-22 版本与资源更新

官方 QQ 与微信的握手、登录及心跳均核对为 `1.15.1.4_20261001`；两端仍独立维护默认值、更新时间、自定义配置和连接快照。

微信采用独立 TSDK `v3.9.0.1792565883`，WASM 大小 161,135 bytes，SHA-256 为 `9c8b1ca061d8e122dd902ff651755d9d2f2006fdf5483765bffd9b9c10aee6ad`。QQ 同步到 `v3.9.0.1792566360`，不共用微信 WASM。

微信设备平台文本按官方格式转成小写，调试枚举仍为 `2`。环境探测接口及 ACEVM 尚未在 Node.js 中完整实现，缺失能力不会报告为通过。资源更新不能据此视为掉线问题已解决。

构建哈希、配置变化与边界详见 [游戏版本与资源对齐](game-update-20261022.md)。以下为历史连接与诊断记录。


## 2026-10-20 微信 1.15 复核

Windows 微信实机的 `platform=wx` 握手、PlayerLoginRequest、HeartbeatRequest 均为 `1.15.0.2_20261001`。微信已采用 `PlayerLogin → PlayerSceneLogin(global_scene_id=1)`；确认农场场景回包完整后才启动自动化。1.14 等历史版本仍使用旧 Login。

QQ 与微信现在分别保存版本：原 `clientVersion` / `clientVersionUpdatedAt` 仅用于 QQ，新增 `wxClientVersion` / `wxClientVersionUpdatedAt` 用于微信。两者目前恰好同为 `1.15.0.2_20261001`，独立维护默认值、更新时间和自定义覆盖。旧配置迁移时不会把 QQ 自定义值复制给微信；旧面板未提交微信字段时保留已保存的微信值。

系统设置提供两个版本输入框。每个账号按自身平台启动 Worker，并独立选择 App ID、设备字段、登录渠道和 WASM；系统的默认平台不会覆盖已登记账号的平台。配置快照传递两个版本及设备设置。连接创建时固定本次版本，握手、登录及心跳复用该值；保存或重置连接设置不再重启在线账号，新的连接参数在取得新 Code 登录时生效。

微信 TSDK 独立更新为 `v3.9.0.1792070005`，大小 161,133 bytes，SHA-256 为 `1a9416db8b328e8957a079c583ffc5fc7e48d6af8c45aa40d9969dd68157beca`。来源为本次微信缓存包内的 `tsdk/tsdk.wasm`，不是 QQ 的 `v3.9.0.1792070537`。磁盘资源加载后记录实际 WASM 路径及 SHA-256，便于核对 Docker、编译版和 pkg 是否加载正确资源。

约 4 分钟官方样本内，Heartbeat 9/9、AntiData 19/19，其中 1 次 AntiData 非空，无 Kickout 或非零网关错误码。新微信 WASM 初始化及 48 条非空请求体解密后重新加密的字节比较通过。样本只用于协议与资源核对，不是机器人长时间在线保证。

微信渠道仍为 `other`，QQ 为 `other-qq`。新登录体包含 `share_key=""`、`game_scene_id=1`；历史 Login 的字段存在性保持原样。微信本次入口 scene_id 为 1005，但它随入口变化，单独 Code 没有启动上下文时继续省略。不得套用 QQ 的 1234567，也不得硬编码某台设备的内存和标识。

微信官方宿主从微信 API 获取 `model;platform;system;brand;`、`wx.env.USER_DATA_PATH` 和 enableDebug；Node 宿主仍有设备、目录等替代实现，本次不冒充已获得这些实际值，不改用 QQ 固定参数。非空 AntiData 在新 WASM 的离线回放仍触发未实现的 ACEVM 调用；返回 0 表示任务执行失败。仅升级版本、登录流程和 WASM 不代表补齐 ACEVM 或修复所有掉线原因。

QQ/微信网络层的心跳无入站时长、请求等待与会话时长使用单调时钟，避免系统校时误判；WebSocket 握手增加 20 秒超时。心跳频率、连续失败阈值和一次性 Code 不重放规则保持不变。

## 2026-09-25 历史样本

Windows 微信真实样本（2026-09-25）确认：客户端为 `1.14.2.13_20260922`，TSDK 为 `v3.9.0.1790237209`，登录渠道为 `other`。约 12 分钟内有 28 组心跳与 43 组 AntiData 往返，没有 Kickout；这不是超过三小时的稳定性结论。

## 平台适配

- 账号为 wx/wechat 时，握手、登录和 Heartbeat 统一选择独立的微信版本；QQ 使用自己的版本。两端各自的自定义覆盖不互相影响，QQ 完整初始化凭据向量保持不变。
- 微信 Login 使用渠道 `other`，从设备配置读取 network、memory 和 device_id。没有小游戏启动上下文时省略 scene_id，不套用本次样本的入口值。
- 微信独立加载 `core/src/utils/tsdk-wx.wasm`，QQ 继续加载 `tsdk.wasm`。两者分别校验 SHA-256，容器与 pkg 资源清单均包含微信 WASM。
- 微信当前 WASM SHA-256 见本页 2026-10-20 复核；QQ 当前构建与校验值见 [TSDK 运行约定](tsdk-runtime.md)。
- ACE 请求按运行实例隔离：停止后到达的旧响应不再进入新实例，也不重置新实例的请求状态。5 秒处理周期、25 秒心跳及各分支调度策略保持原有设计。

## 已知能力边界

QQ 和微信官方包均包含 ACEVM，已捕获的两端动态任务内容相同。真实服务端非空 AntiData 在旧、新 WASM 离线回放时，均触发 `imports.a.e`。正式 Node 宿主仍未执行该任务；返回值 `0` 表示执行失败，不是空 AntiData 回复，也不代表检查通过。升级 WASM 不等于补齐 ACEVM，不能据此宣称微信掉线已修复。

诊断仅记录触发次数、时间和最后一次任务原始字节的 SHA-256；读取上限为 64 KiB。超限、无终止符或无效指针会标记读取失败并清空旧哈希，不影响原有返回状态。任务原文、登录凭据和原始回包不进入诊断日志。哈希相同仅用于识别相同输入，不代表已执行或服务端认可。

官方版本中的 UserCryptoManager 尚未启用；debug 值 2 对应 enableDebug=false。没有证据支持随意修改它们。微信实际设备宿主信息尚未完整验证，不能套用 QQ 的固定宿主参数。

## 定位实际退出

断开与 Kickout 日志在清空队列、销毁 WASM 前保存 diagnostics；主动停止也记录一次 `connection_summary`，通过 source 和 intentionalClose 区分结束原因：

- platform、clientVersion、connectionAgeMs，以及从登录初始化完成起计算的 onlineAgeMs；
- heartbeat.attempts/replies/failures 为本次会话累计结果，attempts 包含排队和发送失败，不等于线上帧数；尚未开始心跳时为 null，旧连接的迟到结果不会计入新连接；
- lastInboundAgeMs、lastHeartbeatAgeMs、heartbeatMissCount；
- pendingRequests、queuedRequests 与请求积压；
- ace 的请求/回复/非空回复/失败次数及最近收发、处理时间；lastFailureStage 区分 collect、encode、request、decode、feed；
- ace.taskFailures、lastTaskFailureAt 和 lastFailedTask 记录本地 TSDK 调用失败；lastProcessFailureAt 仅指处理回包失败，心跳 tick、速度检测和状态上报失败不会覆盖它；尚未在线时 ace 为 null，避免沿用上一会话计数；
- tsdk 的版本、就绪状态、unsupportedAceVmCalls、lastUnsupportedAceVmAt，以及 lastUnsupportedAceVmTaskHash、lastUnsupportedAceVmTaskBytes 和 lastUnsupportedAceVmTaskReadFailed。

踢出数字使用 reasonCode，连接关闭码使用 disconnectCode；仅明确列出的整数诊断码通过日志脱敏，登录 Code、Token 和字符串形式的敏感字段仍会隐藏。普通空 AntiData 回复也计入成功往返，不能当作未收到响应。

每次会话首次解码有效 AntiData 回复（含空 result）记录 `antidata_roundtrip`；首次成功回灌非空 result 另记 `antidata_received`。收到回复、完成回灌和执行 ACEVM 是不同阶段，不能互相替代。replies 统计请求返回次数，解码失败也保留该计数，并通过 lastFailureStage 标识。

## 2026-09-25 单账号长测

master 在独立本地入口中连续在线 3 小时 59 分 59.715 秒（约 4 小时），按计划结束；Heartbeat 与 AntiData 各 575 次请求、575 次回复，无掉线或重连。测试只运行登录、用户设置、心跳和 TSDK，不包含农场、好友或活动自动化。

该入口加载了实验 ACEVM 执行器，但全程非空 AntiData 回复和 ACEVM 执行次数均为 0。因此，本轮未覆盖动态任务，不能把稳定在线归因于执行器，也不能证明此前不到三小时掉线的问题彻底修复。实验执行器和原始采样材料未并入正式代码。

## 后续复现

复现时关闭同账号官方农场与其他机器人实例，用新 Code 登录。先关闭业务自动操作、保留正常心跳和 TSDK，至少测试 4 小时，再逐项恢复业务。保留退出前 10–15 分钟到之后 1 分钟的 combined.log、构建版本、登录方式、设备配置及容器/进程重启情况。不要同时登录官方端干扰踢出原因。

官方微信在本机绕过系统代理。采样需确认真正记录了 platform=wx 的握手与双向消息，不能只看 Helper 处于监听状态。结束采样应恢复临时代理并记录人为停止时间。原始抓包、日志和分析数据库留在本地 output/，不提交公开仓库。

## 仓库中的验证材料

保留可重复执行的协议、会话隔离、诊断脱敏与打包清单回归测试。微信测试使用合成输入，不包含登录 Code、OpenID 或原始 AntiData 样本；真实回包验证仅在本地执行。

历史寻宝测试中的好友 GID 与包含账号前缀的记录 ID 已替换为合成标识，重新编码 Protobuf 后继续验证完整结构。生成的运行日志/性能分析产物不作为源代码提交，也不进入容器构建上下文。
