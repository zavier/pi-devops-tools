# pi-devops-tools

[pi](https://pi.dev) 的数据库工作区扩展 — 在终端里查询 MySQL 数据库、管理表关系。

## 功能

- **`/db` 命令** — 交互式数据库工作区，支持多个子命令
- **SQL 查询** — 只读查询（SELECT、SHOW、DESCRIBE、EXPLAIN），结果自动格式化；无 LIMIT 的 SELECT 自动封顶（默认 100，可按连接配置）
- **表结构缓存** — 本地缓存表结构，秒出结果
- **查询历史** — 所有查询本地记录，支持关键词搜索
- **收藏查询** — 保存常用 SQL 模板，一键执行
- **表关系图** — 注册外键关系，BFS 自动联表查询
- **状态栏** — 在 pi 底部状态栏显示当前数据库上下文
- **状态持久化** — 工作区状态跨会话保持

## 安装

### Node.js 环境

pi 扩展运行需要 Node.js ≥ 20。如果你的 pi 尚未安装 Node.js 运行环境，pi 会在首次使用时提示安装。

验证：

```bash
pi node -- --version   # 应输出 v20.x 或更高
```

### 安装扩展

**从 npm 安装（推荐）：**

```bash
pi install npm:pi-devops-tools
```

**从 GitHub 安装：**

```bash
pi install git:github.com/zavier/pi-devops-tools
```

### 本地开发

```bash
git clone git@github.com:zavier/pi-devops-tools.git
pi install ./pi-devops-tools
```

## 配置

在 `~/.pi/database/connections.yaml` 中配置数据库连接（用户级全局配置，跨项目共享）：

```yaml
connections:
  prod-readonly:
    environment: prod
    type: mysql
    host: db-prod.internal
    port: 3306
    username: readonly
    password: ${DB_PASSWORD}
    defaultDatabase: app_db
    queryLimit: 50
  staging:
    environment: staging
    type: mysql
    host: 127.0.0.1
    port: 3307
    username: root
    password: ${STAGING_DB_PASSWORD}
```

- `environment`、`type`、`host` 必填；`type` 目前仅支持 `mysql`
- `port` 默认 `3306`，`username` 默认 `root`
- `password` 支持 `${环境变量}` 替换
- `defaultDatabase` 可选 — 首次 `/db switch` 到该连接时自动选用
- `queryLimit` 可选 — 无 LIMIT 的 SELECT 自动追加的行数上限（默认 `100`）
- `/db switch` 按 `environment` 分组展示连接

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

### `/db query [表名|SQL]`

查询数据。三种方式：

```
/db query                       → 交互选择：选表 + WHERE，或输入完整 SQL
/db query users                 → 选表模式（已知表名），输入 WHERE 条件
/db query SELECT * FROM users WHERE status = 'active'  → 直接执行 SQL
```

参数是表名还是 SQL 由框架自动判断 — 命中已知表名走选表模式，以 `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` 开头则直接执行。

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

### `/db favorite`

管理收藏的 SQL 模板。不带参数列出当前数据库的收藏，支持直接执行、编辑后执行或删除。

```
/db favorite              → 列出当前数据库收藏
/db favorite add          → 交互式添加收藏（名称 + SQL + 描述）
/db favorite add <名称> <SQL>   → 直接添加，省略交互
```

收藏按数据库分组（全局收藏对所有数据库可见）。

### `/db relations`

管理表关联关系。不带参数列出已注册的关系。

```
/db relations             → 列出关系，选择后可删除
/db relations add         → 交互式注册关系：选源表 → 源列 → 目标表 → 目标列 → 类型
/db relations remove      → 选择删除已注册的关系
/db relations discover    → 从 MySQL 外键约束自动发现并导入（可选 AI 分析补充）
/db relations er-diagram [表名]   → 以该表为中心生成 mermaid ER 图
```

注册关系后，`/db query` 的 auto-join 模式会通过 BFS 自动联表查询关联数据。

### `/db refresh-schema`

从数据库刷新本地表结构缓存。

```
/db refresh-schema
```

## 数据存储

所有状态存储在 `~/.pi/database/` 下：

| 文件               | 用途                                    |
| ------------------ | --------------------------------------- |
| `workspace.json`   | 当前环境/数据库选择                     |
| `schema/`          | 表结构 JSON 缓存（按连接/数据库分文件） |
| `history.db`       | 查询历史、收藏、表关系的 SQLite 存储    |
| `connections.yaml` | 连接定义                                |

## 环境要求

- **Node.js** ≥ 20
- **pi** ≥ 0.80
- `better-sqlite3`（自动安装）
- `mysql2`（自动安装）

## License

MIT
