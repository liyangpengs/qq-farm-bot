# 账户管理使用说明

所有账户数据存储在 `core/data/` 目录下的 JSON 文件中，可直接手动编辑。

## 文件说明

| 文件 | 用途 |
|------|------|
| `data/accounts.json` | 农场账户列表 |
| `data/store.json` | 全局配置（含账户上限、各账户配置） |
| `data/admin.json` | 管理员账号 |

## 手动添加账户

编辑 `data/accounts.json`：

```json
{
  "accounts": [
    {
      "id": "1",
      "name": "我的大号",
      "code": "",
      "platform": "qq",
      "uin": "123456789",
      "qq": "123456789",
      "avatar": "",
      "owner": "admin",
      "createdAt": 1690000000000,
      "updatedAt": 1690000000000
    }
  ],
  "nextId": 2
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 唯一数字 ID（字符串），自增 |
| `name` | 否 | 备注名称，默认 `账号{N}` |
| `code` | 否 | 微信登录码，通过扫码登录获取 |
| `platform` | 否 | 平台类型，`qq` 或 `wx`，默认 `qq` |
| `uin` | 是 | QQ 号或用户标识 |
| `qq` | 否 | 同 uin，默认取 uin 值 |
| `avatar` | 否 | 头像 URL |
| `owner` | 是 | 所属管理员用户名，与 `admin.json` 中的 `username` 对应 |
| `nick` | 否 | 用户昵称 |
| `createdAt` | 否 | 创建时间戳（毫秒） |
| `updatedAt` | 否 | 更新时间戳（毫秒） |

> **注意：** `owner` 为必填，用于实现管理员之间的账户隔离；**无 `owner` 的账号会在加载时被自动清除、不再运行**。

> **注意：** 手动添加后需确保 `nextId` > 最大 `id`，否则重启后可能导致 ID 冲突。

## 设置账户数量上限

编辑 `data/store.json`，修改 `maxAccounts` 字段：

```json
{
  "maxAccounts": 3,
  "accountConfigs": {},
  "defaultAccountConfig": { ... },
  "ui": { "theme": "light" },
  "offlineReminder": { ... },
  "systemConfig": null
}
```

| 值 | 含义 |
|----|------|
| `1` | 默认，每个管理员名下最多 1 个账户 |
| `N`（≥ 0） | 每个管理员名下最多 N 个账户 |
| `-1` | 不限制数量 |

> **注意：** `maxAccounts` 是**单个管理员名下**的农场账户上限，按账号的 `owner`（管理员用户名）分别计数，而不是整个系统所有账户的总数。不同管理员各自拥有独立的上限。
>
> 修改后无需重启，下次新增账户时生效。

## 删除账户

从 `data/accounts.json` 的 `accounts` 数组中移除对应条目，同时可在 `data/store.json` 的 `accountConfigs` 中删除对应 `id` 的配置项（可选，系统会自动清理）。

## 修改管理员密码

`data/admin.json` 中存储的是 bcrypt 哈希，无法直接修改明文。如需重置密码，删除 `admin.json` 后重启服务，再运行 `node add-admin.js <用户名> <密码>` 创建新的管理员账号（系统不会再自动创建默认账号）。

## 管理面板多管理员

`data/admin.json` 支持多个管理员账户，格式如下：

```json
{
  "admins": [
    {
      "username": "admin",
      "password": "bcrypt_hash",
      "createdAt": 1690000000000,
      "mustChangePassword": true
    },
    {
      "username": "user2",
      "password": "bcrypt_hash",
      "createdAt": 1690000000000
    }
  ]
}
```

### 添加管理员

在项目根目录运行：

```bash
node add-admin.js <用户名> <密码>
```

示例：

```bash
node add-admin.js user2 mypassword123
```

### 手动添加管理员

在 `admins` 数组中追加一条记录，`password` 字段需要是 bcrypt 哈希值（可用 `node add-admin.js` 脚本生成）。

### 删除管理员

从 `admins` 数组中移除对应条目即可。