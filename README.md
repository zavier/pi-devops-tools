# pi-devops-tools

[pi](https://pi.dev) 的数据库工作区扩展 — 在终端里查询 MySQL 数据库、查看远程日志、管理表关系。

## 功能

- **`/db` 命令** — 交互式数据库工作区，支持多个子命令
- **SQL 查询** — 只读查询（SELECT、SHOW、DESCRIBE、EXPLAIN），结果自动格式化
- **SSH 隧道** — 通过跳板机连接内网数据库
- **表结构缓存** — 本地 SQLite 缓存表结构，秒出结果
- **查询历史** — 所有查询本地记录，支持关键词搜索
- **表关系图** — 注册外键关系，BFS 自动联表查询
- **日志查看** — SSH 到服务器 tail/grep 应用日志
- **状态栏** — 在 pi 底部状态栏显示当前数据库上下文
- **状态持久化** — 工作区状态跨会话保持

## 安装

### 从 GitHub 安装

```bash
pi install git:github.com/你的用户名/pi-devops-tools
```

### 从 npm 安装

```bash
pi install npm:pi-devops-tools
```

### 本地开发

```bash
git clone git@github.com:你的用户名/pi-devops-tools.git
pi install ./pi-devops-tools
```

## 配置

在项目根目录创建 `.pi/config.json`：

```json
{
  "databases": {
    "prod-readonly": {
      "host": "db-prod.internal",
      "port": 3306,
      "user": "readonly",
      "password": "${DB_PASSWORD}",
      "dbs": ["app_db", "user_db", "order_db"]
    },
    "staging": {
      "host": "127.0.0.1",
      "port": 3307,
      "user": "root",
      "password": "${STAGING_DB_PASSWORD}",
      "dbs": ["app_db"]
    }
  },
  "servers": {
    "bastion": {
      "host": "bastion.example.com",
      "port": 22,
      "user": "deploy",
      "keyPath": "~/.ssh/id_rsa"
    },
    "app-server-1": {
      "host": "10.0.1.10",
      "port": 22,
      "user": "deploy",
      "keyPath": "~/.ssh/id_rsa",
      "jumpHost": "bastion"
    }
  },
  "services": {
    "api-gateway": {
      "server": "app-server-1",
      "logPath": "/var/log/api-gateway/app.log",
      "errorLogPath": "/var/log/api-gateway/error.log",
      "accessLogPath": "/var/log/api-gateway/access.log"
    }
  }
}
```

- `password` 支持 `${环境变量}` 替换
- `jumpHost` 通过跳板机建立 SSH 隧道
- `dbs` 列出该集群下可用的数据库

## 命令

### `/db`

显示工作区面板，查看当前连接状态和可用子命令。

```
/db
```

### `/db switch`

交互式流程：选择环境 → 选择连接 → 选择数据库。

```
/db switch
```

### `/db tables`

列出当前数据库中的所有表。

```
/db tables
```

### `/db schema [表名]`

查看表结构（列、索引）。不带参数时显示可搜索的表列表。

```
/db schema users
```

### `/db query [表名]`

交互式查询 — 选表后输入 WHERE 条件，或直接写 SQL。

```
/db query users          → 选表，输入 WHERE 条件
/db query "SELECT * FROM users WHERE status = 'active'"
```

结果自动选择最佳展示格式：
- ≤ 8 列 → 横向表格
- > 8 列且 ≤ 10 行 → 行列转置视图
- 其他 → 每行垂直键值对展示

全 NULL 列、值全相同的列会被折叠并给出摘要提示。

### `/db history [关键词]`

搜索查询历史。不带关键词显示最近 20 条记录。

```
/db history
/db history users
```

### `/db refresh-schema`

从数据库刷新本地表结构缓存。

```
/db refresh-schema
```

## LLM 工具

扩展同时注册了以下工具，LLM 可以直接调用：

### `query_database`

执行只读 SQL 查询，支持基于关系图的自动联表。

| 参数 | 说明 |
|------|------|
| `cluster` | 配置中的集群名称 |
| `database` | 数据库名 |
| `sql` | SELECT 查询语句 |
| `autoJoin` | 是否自动查询关联表（默认 false） |
| `maxDepth` | BFS 深度（默认 2，最大 5） |
| `limit` | 最大返回行数（默认 100，最大 500） |

### `query_logs`

SSH 到服务器 tail/grep 日志文件。

| 参数 | 说明 |
|------|------|
| `service` | 配置中的服务名称 |
| `logType` | 日志类型：`app`（默认）、`error`、`access` |
| `keyword` | 关键词过滤（可选） |
| `tail` | 读取行数（默认 200，最大 1000） |

### `register_relation`

注册表之间的列级关系，用于自动联表。

### `list_relations`

列出所有已注册的表关系。

### `remove_relation`

删除已注册的表关系。

### `sync_foreign_keys`

从数据库同步实际的 MySQL 外键约束到关系图中。

## 数据存储

所有状态存储在 `~/.pi/database/` 下：

| 文件 | 用途 |
|------|------|
| `workspace.json` | 当前环境/数据库选择 |
| `schema-cache.db` | 表结构 SQLite 缓存 |
| `history.db` | 查询历史 SQLite 记录 |
| `connections.yaml` | 连接定义 |

## 环境要求

- **Node.js** ≥ 20
- **pi** ≥ 0.80
- `better-sqlite3`（自动安装）
- `mysql2`（自动安装）
- `ssh2`（自动安装）

使用 `query_logs` 需要目标服务器已配置 SSH 密钥认证。

## License

MIT
