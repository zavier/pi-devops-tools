# pi-devops-tools

[pi](https://pi.dev) 的数据库工作区扩展 — 在终端里查询 MySQL 数据库、管理表关系。

## 功能

- **`/db` 命令** — 交互式数据库工作区，支持多个子命令
- **SQL 查询** — 只读查询（SELECT、SHOW、DESCRIBE、EXPLAIN），结果自动格式化；无 LIMIT 的 SELECT 自动封顶（默认 100，可按连接配置）
- **AI 写操作** — `db_mutate` 工具支持 INSERT/UPDATE/DELETE/REPLACE，每次需人工在 TUI 弹窗中确认
- **实时表结构** — 直接查询 `information_schema`，始终最新
- **查询历史** — 所有查询本地记录，支持关键词搜索
- **收藏查询** — 保存常用 SQL 模板，一键执行
- **表关系图** — 注册外键关系，BFS 自动联表查询
- **跨库查询** — 同一 MySQL 实例上的库可直接 `db.table` JOIN，无需切换
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

显示工作区面板，查看当前连接状态、可用连接和子命令。

```
/db
```

### `/db add`

交互式 wizard 添加新数据库连接：选择环境 → 连接名 → host/port → 用户名/密码 → 默认数据库。
写入 `connections.yaml` 后自动 hot-reload，无需重启。

```
/db add
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

查看表结构（列、索引）。结果以 markdown 表格形式渲染并持久展示在聊天中。不带参数时显示可搜索的表列表。

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

结果根据终端宽度自适应选择最佳展示格式（水平表格 → 转置 → 垂直键值对），`ctrl+o` 可展开查看全部行。

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

注册关系后，AI 会通过 `db_relation` 工具辅助完成 discover → 分析 → 注册的工作流。

## LLM 工具

扩展注册了 8 个工具（6 个只读 + 2 个写操作：`db_relation` 写本地 SQLite，`db_mutate` 写 MySQL），AI 可以直接调用而无需用户输入 `/db` 命令。其中 3 个工具默认不激活（按需加载），以控制上下文占用：

| 工具名              | 类型   | 激活 | 描述                                                                                        |
| ------------------- | ------ | ---- | ------------------------------------------------------------------------------------------- |
| `db_query`          | 只读   | 常驻 | 执行只读 SQL 查询（与 `/db query` 相同的安全限制）                                          |
| `db_list_tables`    | 只读   | 常驻 | 列出指定数据库的所有表（实时查询）                                                          |
| `db_table_schema`   | 只读   | 常驻 | 查看指定表的结构（列、索引）                                                                |
| `db_mutate`         | **写** | 常驻 | 执行 INSERT/UPDATE/DELETE/REPLACE，每次弹出确认弹窗需人工批准                               |
| `db_tools`          | 只读   | 常驻 | 按需启用下方 3 个懒加载工具（loader，下一轮生效）                                           |
| `db_discover`       | 只读   | 按需 | 发现可用的连接和数据库 — 探索入口。返回已配置的连接及其数据库                               |
| `db_list_relations` | 只读   | 按需 | 列出已注册的表关系 — AI 可用于自行编写 JOIN                                                 |
| `db_relation`       | **写** | 按需 | 管理表关系（本地 SQLite）：action="register"（幂等 upsert）或 action="delete"（按列对删除） |

`db_discover`、`db_list_relations`、`db_relation` 默认不激活；需要时先调用 `db_tools`（query 填 "discover" 或 "relations"），下一轮起即可用。

只读工具遵循与用户命令相同的只读保护：只能执行 SELECT/SHOW/DESCRIBE/EXPLAIN，DELETE/DROP/UPDATE 等写操作会被拒绝。`db_query`、`db_list_tables`、`db_table_schema` 支持可选的 `connection`/`database` 参数以跨库/跨连接查询。

`db_mutate` 用于数据修改：DDL（CREATE/DROP/ALTER/TRUNCATE）被硬性拒绝，UPDATE/DELETE 无 WHERE 时会显示警告。每次调用弹出 overlay 确认弹窗（Enter 确认 / Esc 取消），不可跳过。

## 数据存储

所有状态存储在 `~/.pi/database/` 下：

| 文件               | 用途                                 |
| ------------------ | ------------------------------------ |
| `workspace.json`   | 当前环境/数据库选择                  |
| `state.db`         | 查询历史、收藏、表关系的 SQLite 存储 |
| `connections.yaml` | 连接定义                             |

## 环境要求

- **Node.js** ≥ 20
- **pi** ≥ 0.80
- `better-sqlite3`（自动安装）
- `mysql2`（自动安装）

## License

MIT
