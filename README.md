# QQ 农场多账号挂机 + Web 面板

基于 Node.js 的 QQ 农场自动化工具，提供多账号挂机、农场与好友自动化、作物与超变图鉴、活动中心、商城、数据分析和 Web 控制面板。当前项目版本为 `20260901`，游戏协议版本为 `1.13.3.16_20260826`。

> [!IMPORTANT]
> 首次启动会创建默认管理员 `admin` / `admin`，Web 面板默认端口为 `3007`。对外部署后请立即修改密码，并避免将未加防护的管理端口直接暴露到公网。

## 项目截图
|  |  |
| --- | --- |
| ![项目截图 1](https://free.picui.cn/free/2026/08/21/6a87f4e28ce59.jpg) | ![项目截图 2](https://free.picui.cn/free/2026/08/21/6a87f4e2e5557.jpg) |
| ![项目截图 3](https://free.picui.cn/free/2026/08/21/6a87f4e3780bb.jpg) | ![项目截图 4](https://free.picui.cn/free/2026/08/21/6a87f4e398c30.jpg) |
| ![项目截图 5](https://free.picui.cn/free/2026/08/21/6a87f4e8bbbce.jpg) | ![项目截图 6](https://free.picui.cn/free/2026/08/21/6a87f4e90d06c.jpg) |
| ![项目截图 7](https://free.picui.cn/free/2026/08/21/6a87f4e95678d.jpg) | ![项目截图 8](https://free.picui.cn/free/2026/08/21/6a87f4e958eae.jpg) |
| ![项目截图 9](https://free.picui.cn/free/2026/08/21/6a87f4e91bccb.jpg) | ![项目截图 10](https://free.picui.cn/free/2026/08/21/6a87f4e355da8.jpg) |

## 功能概览

### 账号与登录

- 游戏账号可无限添加并独立运行，每个账号可单独配置种植、好友、自动化和执行间隔策略
- 支持抓包 Code 登录和微信小程序扫码登录
- 支持账号启停、状态监控、实时日志和离线提醒
- Web 面板只保留一个超级管理员，不提供注册、普通用户和租户隔离

### 农场自动化

- 自动收获、种植、浇水、除草、除虫、铲除和土地升级
- 自动施肥、多季作物补肥、指定土地类型施肥和化肥自动购买
- 支持一键务农、一键种植、一键收获、一键铲除和一键全收等面板操作
- 支持多种种植策略、背包种子优先级、作物黑名单和执行间隔配置
- 汇总任务、免费礼包、分享奖励、会员礼包、月卡礼包和图鉴奖励等每日状态，并按天自动处理支持的领取项

### 图鉴

- 在“个人 → 图鉴”中查看作物图鉴和超变图鉴的等级、进度及果实收藏状态
- 作物图鉴按游戏配置排序展示作物，收藏奖励统一放在详情弹窗中查看
- 超变图鉴依据 `Illustrated.json` 的 `param` 和 `type` 字段区分黄金果实、活动果实与装扮果实，不依赖果实名或协议奖励分类字段推断
- 超变属性弹窗顶部汇总当前生效加成，等级列表展示属性名称、触发概率或数量，以及已达成状态或所需进度
- 移动端图鉴使用四列果实布局，等级进度和弹窗样式与现有面板保持一致

### 好友互动

- 自动访问好友、偷菜、帮忙浇水、除草除虫及放草放虫
- 支持好友黑名单、安静时段和互动经验上限
- 支持已知好友 GID 的批量维护、同步参数和互动记录查询
- 好友巡查合并为单次访问：每位好友只进一次农场，一次做完帮忙（除草/除虫/浇水）、偷菜和捣乱（放草/放虫）
- 好友上场宠物按天缓存：进好友农场时顺手记录，另有后台分批的每日补齐，“护主犬经验满仍帮忙”不再每轮逐个进农场试探
- 面板可对指定好友执行单次访问或农场操作

### 背包与交易

- 查看背包，使用、出售或批量出售物品
- 根据游戏配置判断活动区间外、活动结束后和道具过期后的物品可售状态
- 查看神秘商人活动商品及购买状态
- 浏览游戏商城商品、价格、折扣和限购信息，并执行购买
- 查询种子、果实、道具和作物收益数据

### 活动中心

- 通过活动列表协议统一展示当前活动和已结束活动；未实现详情页的活动仍会显示，但不可进入玩法页面
- 千星游记：查看赛季与通行证进度，领取可用奖励
- 观星礼录：查看星座进度、点亮星座并领取奖励
- 星砂商店：查看星砂余额和活动商品，执行兑换
- 节令活动：查看当前节令并领取开放奖励
- 鹊桥寄情：查看筑桥阶段、领取鹊桥奖励，并向好友赠送鹊羽香囊
- 雨落成诗：查看雷雨剩余时间和闪电变异配置，兑换或使用天气瓶，并推进气象研究节点
- 活动快照请求采用串行和重复请求合并，避免登录或切换账号时占满游戏网关请求队列
- 青梅酿酒活动已下线，前端不再提供入口；相关协议和实现暂时保留用于兼容

### Web 控制面板

- 概览、个人、活动、好友、分析、神秘商人、游戏商城和设置页面
- Socket.IO 实时状态与日志，全局使用单一暖白液态玻璃界面
- PC 端使用固定侧栏，移动端使用顶部栏和底部导航，并针对常用操作完成响应式适配
- 作物收益分析、策略预览、批量维护作物黑名单
- 设置页统一管理游戏账号、自动化策略、运行环境、管理员密码和下线提醒
- 基于 `pushoo` 的实例级事件推送，可配置通知渠道和离线自动清理时间

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 后端 | Node.js 20、Express 4、Socket.IO 4、TypeScript 5.9 |
| 前端 | Vue 3.5、Naive UI 2、Vue Router 5、Pinia 3、Vite 7、UnoCSS 66 |
| 工程 | pnpm 10.30.2、ESLint 9、Docker Compose |
| 协议 | WebSocket、Protocol Buffers、TSDK WASM |

## 快速开始

### 环境要求

| 运行方式 | 要求 |
| --- | --- |
| 源码运行 | Node.js 20.19+、pnpm 10+ |
| Docker | Docker 20+、Docker Compose 2+、Node 20.19.6（镜像内置） |
| 二进制发布版 | 无需安装 Node.js |

推荐通过 Corepack 启用项目指定版本的 pnpm：

```bash
corepack enable
pnpm --version
```

### 源码运行

Windows、Linux 和 macOS 均可使用以下方式：

```bash
git clone https://github.com/liyangpengs/qq-farm-bot.git
cd qq-farm-bot
pnpm install
pnpm dev
```

`pnpm dev` 会先构建前端，再启动后端服务。启动后访问：

- 本机：`http://localhost:3007`
- 局域网：`http://<服务器 IP>:3007`

如需分别启动开发服务：

```bash
# 终端 1：Vite 前端开发服务
pnpm dev:web

# 终端 2：后端开发服务
pnpm dev:core
```

只运行 `pnpm dev:core` 并由后端托管页面时，应先执行一次 `pnpm build:web`。

### Linux 后台脚本

```bash
git clone https://github.com/liyangpengs/qq-farm-bot.git
cd qq-farm-bot
corepack enable
bash ./start.sh

# 拉取代码后如需忽略缓存并完整重建
bash ./start.sh --rebuild

# 查看日志
tail -f app_dev.log

# 停止服务
bash ./stop.sh
```

`start.sh` 会在依赖缺失或依赖清单变化时执行 `pnpm install --frozen-lockfile`，并按文件更新时间分别判断 Web、Core 是否需要重建。源码和依赖均未变化时会直接复用现有产物；`--rebuild` 可强制完整重建。脚本随后以生产模式后台运行 `node core/client.js`，日志写入 `app_dev.log`，进程号记录在 `app_dev.pid`。`stop.sh` 会校验 PID 对应的工作目录和启动命令，再停止整个服务进程组。

前端类型检查已与生产构建拆分，需要单独检查时执行 `pnpm typecheck:web`。

### Docker Compose

```bash
git clone https://github.com/liyangpengs/qq-farm-bot.git
cd qq-farm-bot
docker compose up -d --build

# 仅重启现有容器，不触发镜像构建
docker compose restart qq-farm-bot

# 查看状态和日志
docker compose ps
docker compose logs -f

# 检查 Compose 配置展开结果
docker compose config

# 停止并移除容器
docker compose down
```

默认访问 `http://<服务器 IP>:3007`。修改根目录 `.env` 中的 `PORT` 后，可调整宿主机映射端口：

```dotenv
PORT=3008
TZ=Asia/Shanghai
```

Docker 数据保存在 `qq-farm-data` 和 `qq-farm-logs` 命名卷中。执行 `docker compose down` 不会删除这些卷；不要使用 `docker compose down -v`，除非确认要删除运行数据。

Compose 使用根目录作为构建上下文，Dockerfile 位于 `core/Dockerfile`。镜像构建阶段固定使用 Node `20.19.6` 和 pnpm `10.30.2`，通过 BuildKit 缓存 pnpm store，并在相互独立的阶段构建 Web、Core 和生产依赖；仅修改一侧源码时可直接复用另一侧缓存。运行阶段只保留生产依赖、编译产物、协议定义、游戏配置和 TSDK WASM。容器内部固定监听 `3007`，根目录 `.env` 中的 `PORT` 只用于宿主机端口映射。

依赖源默认使用 npm 官方源；网络受限时可以在根目录 `.env` 中覆盖构建参数后重新构建：

```dotenv
NPM_REGISTRY=https://registry.npmmirror.com/
```

如需显式指定基础镜像或 pnpm 版本，也可以配置 `NODE_IMAGE` 和 `PNPM_VERSION`。修改构建参数或排查旧缓存问题时请执行 `docker compose build --pull --no-cache`，确保重新拉取基础镜像并安装依赖。

### 二进制发布版

可从 [Releases](https://github.com/liyangpengs/qq-farm-bot/releases) 下载对应平台文件，也可以自行构建：

```bash
pnpm install
pnpm package:release
```

Windows x64、Linux x64、macOS Intel 和 macOS Apple Silicon 产物生成在 `core/dist/bin/`。运行后，程序会在可执行文件同级创建 `data/` 目录。

Linux 和 macOS 首次运行可能需要添加执行权限：

```bash
chmod +x ./qq-farm-bot
./qq-farm-bot
```

## 首次使用

1. 打开 Web 面板，使用 `admin` / `admin` 登录。
2. 进入“设置 → 系统设置”修改管理员密码。
3. 在设置页添加游戏账号，可使用有效 Code 或扫码登录。
4. 为账号配置种植、自动化和好友策略，并按需设置实例级下线提醒。
5. 启动账号，在概览页确认连接状态、农场数据和实时日志。

Code 具有时效性；登录失败时应先重新获取 Code 或重新扫码。QQ 客户端被挤下线后，官方“重新登录”会签发新的 Code；可启动 QQFarmCodeHelper 的标准获取模式并开启自动同步，再点击官方“重新登录”，Helper 会更新匹配账号的 Code 并重新启动远程账号。协议监听模式只落盘抓包，永远不会自动上传 Code。

## 配置说明

### 环境变量

| 变量 | 默认值 | 适用范围 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_PORT` | `3007` | 源码、二进制 | Web 面板监听端口；Compose 容器内固定为 `3007` |
| `PORT` | `3007` | Docker Compose | 宿主机映射端口，从根目录 `.env` 读取 |
| `TZ` | `Asia/Shanghai` | Docker Compose | 容器时区 |
| `NODE_ENV` | `production` | Docker | Compose 当前固定为生产环境 |
| `LOG_LEVEL` | `info` | 后端 | 服务端日志级别 |

管理员账号不通过环境变量初始化。首次运行会自动创建 `admin` / `admin`，之后的管理员凭据保存在数据目录的 `admin.json` 中。项目不提供注册或新增管理员功能。

### 种植策略

| 策略值 | 面板名称 | 行为 |
| --- | --- | --- |
| `preferred` | 优先种植种子 | 优先使用指定种子，不可用时自动回退 |
| `level` | 最高等级作物 | 优先选择当前可种植的高等级作物 |
| `max_exp` | 最大经验/时 | 按单位时间经验选择，默认策略 |
| `max_fert_exp` | 最大普通肥经验/时 | 按普通肥条件下的单位时间经验选择 |
| `max_profit` | 最大净利润/时 | 按单位时间净利润选择 |
| `max_fert_profit` | 最大普通肥净利润/时 | 按普通肥条件下的单位时间净利润选择 |
| `bag_priority` | 背包种子优先 | 先按优先级消耗背包种子，再使用回退策略 |

### 施肥模式

| 模式值 | 面板名称 | 行为 |
| --- | --- | --- |
| `smart` | 普通 + 快成熟有机 | 默认模式，按成熟时间智能选择有机肥 |
| `both` | 普通 + 有机 | 同时使用普通肥和有机肥 |
| `normal` | 仅普通化肥 | 只使用普通化肥 |
| `organic` | 仅有机化肥 | 只使用有机化肥 |
| `none` | 不施肥 | 关闭自动施肥 |

`smart` 模式施加有机肥后会重新检查一次自有土地，并立即收获本轮因施肥进入成熟状态的作物；该追收最多执行一次，不会形成循环请求。

### 图鉴配置

图鉴使用 `core/src/gameConfig/Illustrated.json` 和 `core/src/gameConfig/BuffCfg.json` 两份游戏配置：

| 配置 | 字段 | 说明 |
| --- | --- | --- |
| `Illustrated.json` | `param` | 与图鉴协议返回的果实 ID 对应 |
| `Illustrated.json` | `type` | 果实分类，包括普通果实、黄金果实、活动果实和装扮果实 |
| `Illustrated.json` | `illustrated_type` | 区分普通图鉴和超变图鉴 |
| `Illustrated.json` | `sort` | 图鉴中的展示顺序 |
| `BuffCfg.json` | `source_type` | 超变图鉴只展示 `超变升级`，隐藏 `活动加成` |
| `BuffCfg.json` | `source_param` | 触发该属性加成的图鉴等级 |
| `BuffCfg.json` | `attr_id` | 属性加成名称 |
| `BuffCfg.json` | `attr_value` | 大于 `10` 时为触发概率，小于 `10` 时为数量 |

概率值按千分值转换为百分比展示，例如 `100` 显示为 `10%`、`500` 显示为 `50%`；数量值直接展示，例如 `2` 显示为 `数量 +2`。当前加成会按属性名称取当前等级已生效的最新配置。

## 数据与备份

| 运行方式 | 数据位置 |
| --- | --- |
| 源码运行 | `core/data/` |
| 二进制运行 | 可执行文件同级的 `data/` |
| Docker | `/app/core/data`，映射到 `qq-farm-data` 命名卷 |

管理员凭据、游戏账号、配置、活动状态和日志都属于运行数据。升级、迁移或重新部署前，建议先停止服务并备份整个数据目录或 Docker 命名卷，而不是只复制单个 JSON 文件。

游戏账号属于当前实例，不带用户归属字段，也没有数量上限。下线提醒同样是实例级配置，对当前实例内的所有游戏账号生效。

## 项目结构

```text
qq-farm-bot/
├── core/                  # Node.js 后端、账号 Worker 与协议实现
│   ├── src/
│   │   ├── controllers/   # Web API 与鉴权路由
│   │   ├── core/          # 单账号 Worker 与任务调度
│   │   ├── runtime/       # 多账号运行时和状态同步
│   │   ├── services/      # 农场、好友、图鉴、活动、商城、微信登录等业务
│   │   ├── proto/         # Protocol Buffers 定义
│   │   ├── gameConfig/    # 作物、道具、等级、图鉴与属性加成等游戏配置
│   │   └── models/        # 超级管理员、游戏账号与配置持久化
│   └── data/              # 源码模式运行数据
├── web/                   # Vue 3 Web 面板
│   ├── src/components/    # 农场、图鉴、背包、任务、活动与基础组件
│   ├── src/stores/        # Pinia 状态管理
│   ├── src/views/         # 各功能页面
│   └── dist/              # 前端构建产物
├── docs/                  # 项目专题文档
├── tools/                 # 配置下载、图片下载与协议分析工具
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 构建前端并启动后端开发服务 |
| `pnpm dev:web` | 启动 Vite 前端开发服务 |
| `pnpm dev:core` | 使用 `tsx` 启动后端 |
| `pnpm lint` | 检查并自动修复前后端代码风格 |
| `pnpm -C core typecheck` | 执行后端 TypeScript 类型检查 |
| `pnpm typecheck:web` | 执行前端 TypeScript 类型检查（不参与生产启动） |
| `pnpm build:web` | 构建 Web 面板到 `web/dist/` |
| `pnpm -C web build:compressed` | 构建 Web 并额外生成预压缩 `.gz` 文件 |
| `pnpm -C web build:analyze` | 构建 Web 并生成 bundle 分析报告 |
| `pnpm build:core` | 编译后端 TypeScript |
| `pnpm build` | 依次构建前端和后端 |
| `pnpm package:release` | 构建四个平台的独立二进制文件 |
| `pnpm -C core test` | 编译 Core 并运行抓包协议、活动和请求并发测试 |

### 清理构建产物

```bash
# Linux/macOS
bash ./clean.sh

# Windows
clean-for-pack.bat

# 保留 core/data 运行数据
clean-for-pack.bat --keep-data
```

`clean.sh` 会停止当前服务，然后删除项目根目录下除 `.git` 以外的全部文件和目录，包括源码、依赖、构建产物、运行数据以及脚本自身。该操作不可撤销，只应用于准备通过 Git 重新检出工作区的场景。

Windows 的 `clean-for-pack.bat` 会清理依赖、构建产物、覆盖率文件、日志以及 `core/data` 运行数据，适合生成不包含账号和凭据的发布目录。如需保留 `core/data`，必须显式传入 `--keep-data`。

### 抓包协议分析

```bash
# 解码指定抓包目录中的协议帧
pnpm -C core exec tsx ../tools/decode-latest-protocols.js <capture-dir>

# 检查抓包 RPC 与本地 Protobuf 定义的兼容性
pnpm -C core exec tsx ../tools/audit-capture-compatibility.js <capture-dir>
```

## 项目文档

专题说明统一收录在 [`docs/`](docs/README.md)：

- [工具脚本](docs/tools.md)
- [网络并发模型](docs/network-concurrency.md)
- [TSDK Node.js 运行约定](docs/tsdk-runtime.md)
- [雨落成诗活动协议与实现](docs/weather-activity.md)
- [神秘商人、游戏商城与购买协议](docs/shop-protocols.md)
- [好友宠物缓存与每日同步](docs/friend-pet-cache.md)

## 免责声明

本项目仅供学习与研究用途。使用本工具可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。

<div align="center">
  <p>如果觉得项目有用，欢迎点一个 Star。</p>
</div>
