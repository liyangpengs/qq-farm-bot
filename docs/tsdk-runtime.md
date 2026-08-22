# TSDK Node.js 运行约定

## 版本与来源

项目当前使用 `core/src/utils/tsdk.wasm`，来源为 `D:\wxsource\wx5306c5978fdb76e4-code\tsdk` 中对应微信小程序的 TSDK `v3.9.0.1787056896`，文件大小为 161,002 bytes，SHA-256 为：

```text
1959d2baed17ba3cb28e8fd1c760684e4120a2bde1863551a3c3a7f844627e77
```

运行时固定参数：

- 小程序 App ID：`wx5306c5978fdb76e4`
- TSDK gameId：`3167`
- appKey：`0`

## v3.9.0 升级评估

从 `v3.8.6.1785239995` 升级至 `v3.9.0.1787056896` 前完成了以下静态与离线兼容性核对：

- 配套 `tsdk.js` 的宿主实现除版本字符串外没有变化；
- WASM 仍包含 29 个函数类型、22 个 `a.a` 至 `a.v` 导入、61 个导出和 218 个内部函数；
- 关键导入/导出的名称与函数签名保持不变，现有 Node.js 宿主映射无需调整；
- 初始/最大内存仍为 1,029 页，17 个 mergewasm 数据段的地址和长度保持不变；
- `decrypt_all_data()` 内置的分段参数和密钥仍为现有的 17 段及 `1871261153`，项目继续使用等价的逐段解密流程；
- 文件校验哈希已同步更新，源码运行、TypeScript 编译和 `pkg` 打包仍使用同一资源路径。

因此本次升级的代码影响面限于 WASM 资源、运行时版本/哈希常量和本文档，不涉及网关协议、Token 生成、ACE 调度或业务调用接口。离线初始化与加解密验证不能替代生产网关验证；本次升级后的生产冒烟结果见文末，完整 ACE 非空回灌仍需继续覆盖。

升级后的本地验证结果：

- 新 WASM 哈希校验通过；
- 17 段字符串解密、`x()` 启动和 `G(3167, "0")` 初始化通过；
- `H()` 初始化信息读取通过；
- `ba()`/`ca()` 加解密往返通过；
- `pnpm -C core build:ts`、`pnpm -C core typecheck` 和 `pnpm -C core test` 通过（当前测试目录没有登记测试用例）。

## Node.js 宿主映射

WASM 导入 `a.a` 至 `a.v`。`core/src/utils/tsdk-runtime.ts` 根据官方 `tsdk.js` 提供以下宿主能力：

- 断言、abort 和内存错误；
- 账号隔离的文件读写及 stat；
- JavaScript 调用栈；
- TSDK 版本、App ID、设备信息和运行时固定表；
- wall clock、monotonic clock 和服务端时间校准；
- TQOS HTTPS 上报。

Node.js 无法提供真实的小游戏触摸、陀螺仪、ACEVM 和函数完整性上下文。这些入口返回官方接口允许的空结果，并仅记录一次降级日志。

## 关键 ABI

| 能力 | WASM 导出 |
| --- | --- |
| memory | `w` |
| create buffer | `A` |
| destroy buffer | `B` |
| init runtime | `G` |
| encrypted init info | `H` |
| heartbeat tick | `M` |
| data to server | `N` |
| data from server | `O` |
| process received data | `P` |
| encrypt in place | `ba` |
| decrypt in place | `ca` |
| speed detection | `fa` |

实例化后使用 `__mergewasm_shared____wasm_decrypt_strings` 和固定密钥逐段解密 17 个 mergewasm 数据段，再执行官方启动导出 `x()`，最后调用 `G(3167, appKeyPtr)`。不能直接调用尚未解密的 `decrypt_all_data()`，否则间接函数表尚未恢复，会触发 `table index is out of bounds`。

## 网关 Token

`gatepb.Message` 的 field 3 为 `token`。登录及普通业务请求使用随机 Token：生成 64～127 个字母数字字符并追加 `=`，总长度为 65～128。

官方客户端在初始化阶段还会产生一种不同格式的一次性 TSDK 凭据。2026-08-21 抓包中的该凭据为 152 字符 Base64 风格内容，不适用普通 Token 的 65～128 字符及纯字母数字规则。账号绑定后读取一次 `H()`，并以原子方式优先用于下一条完成编码的请求，随后恢复随机 Token；三次连接中它分别落在初始化业务请求或重连 Login，证明不能按固定 RPC 名称注入。

## ACE 生命周期

登录成功后启动 `core/src/services/ace.ts`：

- 每 5 秒读取 `N()`，首次读取发生在调度启动约 5 秒后；
- `N()` 非空时发送 `gamepb.acepb.AceService.AntiData`；
- 服务端 `AntiDataReply.result` 非空时传入 `O()`；
- 每 5 秒调用 `P()`；
- 每 25 秒调用 `M()`；
- 每 30 秒执行速度检测；
- 每 150 秒发送 TSDK 状态。

最新 76 帧抓包中，两次非空 `AntiDataRequest.data` 分别为 278 和 186 字节；第二次 `AntiDataReply.result` 为 1081 字节并需要回灌。抓包符合每 5 秒 poll、约每 10 秒产生一次非空上报的行为，但发送间隔由 `N()` 是否返回数据决定，不能硬编码成 10 秒。只有首次成功回灌非空 result 后才记录“AntiData 链路正常”。

同一账号只允许一个 AntiData 请求在途。网络清理、重连和账号停止时会停止 ACE 调度并销毁当前 WASM 实例；下一次连接重新初始化。

## 多账号和资源路径

每个账号运行在独立 Worker 中，因此 CommonJS 模块、WASM 内存和调度器天然隔离。TSDK 可写数据保存到：

```text
core/data/tsdk/<accountId>/
```

WASM 通过 `getResourcePath('utils', 'tsdk.wasm')` 加载，兼容源码运行、TypeScript 编译目录和 `pkg` 资源打包。

## 已知限制与待补证项

- Node.js 无法与微信小游戏的传感器及 JavaScript 完整性环境完全等价。
- 运行时实现以反编译 `tsdk.js`、WASM ABI 和 WSS 抓包为依据。
- 一次性初始化凭据已经按“账号绑定后、下一条完成编码的请求消费一次”实现；并发初始化请求之间不依赖固定方法名。
- `GateMessage.meta.server_seq` 在真实客户端中有时取已知最大值、有时取 0，目前没有足够证据恢复置零规则，代码保持现状。
- 2026-08-21 官方会话覆盖 3 次连接和 12 条业务 Heartbeat；请求间隔稳定在约 25 秒，线上的 protobuf 字段为 `gid`、完整 `client_version` 和显式 `field_3=0`。

## 当前版本生产验证

2026-08-21 使用 Helper v0.2.2 保存完整握手 URL并连续观察官方登录、种地、重新登录、等待和退出：

- 三次握手、Login 和 Heartbeat 的版本均为 `1.13.2.10_20260723`；
- 三次握手除 Code 外完全一致，三个 32 字符 Code 均不同，确认官方“重新登录”获取 fresh Code；
- 共保存 432 条双向消息，其中 12 条 Heartbeat 约每 25 秒发送一次，字段 1、2、3 均实际出现在 wire 中；
- 每条连接只消费一次同一 TSDK 初始化凭据，普通请求继续使用 65～128 字符随机 Token。

抓包中的完整 URL、Code、Token 和账号标识不写入本文档，也不上传。

2026-08-20 使用全新的一次性 Code 对 TSDK `v3.9.0.1787056896` 做了约 38.5 秒的最小化生产冒烟。测试入口没有保存账号，也没有启动农场、好友、出售等自动化，只覆盖登录和安全链路：

- WSS Code 登录成功，服务端接受新版 TSDK 加密的 Login；
- 登录后的背包和用户设置请求成功；
- 25 秒业务 Heartbeat 请求及响应成功；
- TSDK 产生一次 51 字节非空 `AntiDataRequest.data`，服务端正常接受且返回成功响应；
- 该次 `AntiDataReply.result` 为空，因此没有触发回灌，也未达到“AntiData 链路正常”的完整判定条件；
- 测试期间没有协议错误、ACE 错误、踢下线或异常断连，结束时由测试入口主动关闭连接。

这次结果确认新版 TSDK 的生产 Login、普通加密请求、首次 AntiData 上报和 Heartbeat 基础链路可用。由于观察窗口内没有产生第二个非空 AntiData，也没有收到非空 result，仍需后续较长会话继续覆盖非空回灌和回灌后的稳定性。

## 历史生产链路验证

2026-07-28 使用短效登录 Code 对生产网关进行了约 35 秒的实际验证。该记录只适用于旧 TSDK `v3.8.6.1784551013`，不能视为当前 `v3.9.0.1787056896` 已生产实连通过。历史结果如下：

- 旧 WASM 完成数据段解密和初始化；
- WSS 登录成功，服务端接受 TSDK 加密请求和网关 Token；
- 登录后背包和用户设置请求成功；
- 运行期间未出现 WSS 协议错误、ACE 错误或踢下线；
- 验证专用账号目录在结束后已删除。

当前 `v3.9.0.1787056896` 已覆盖 Login、普通请求、首次非空 AntiData 和 25 秒 Heartbeat。后续验证重点为第二个非空 AntiData、非空回灌、回灌后稳定性、Token 时序和服务端主动断线行为。
