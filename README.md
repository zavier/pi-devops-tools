# pi-devops-tools

[pi](https://pi.dev) 的数据库工作区扩展 — 在终端里查询 MySQL 数据库、管理表关系。

## 功能特性

- **SQL 查询** — 只读执行 + 自动 LIMIT 封顶，结果自适应格式化
- **实时表结构** — 直接查询 `information_schema`，始终最新
- **AI 工具** — 7 个 LLM 工具，写操作（`db_mutate`）需人工确认
- **表关系图** — 注册外键关系，BFS 自动联表查询
- **查询历史与收藏** — 本地记录查询，支持关键词搜索与一键执行收藏模板
- **跨库查询** — 同一 MySQL 实例上的库可直接 `db.table` JOIN，无需切换
- **状态栏** — 底部状态栏显示当前数据库上下文
- **状态持久化** — 工作区状态跨会话保持

## 安装

pi 会在首次使用时提示安装 Node.js 运行环境（验证：`pi node -- --version`）。

**安装扩展：**

```bash
pi install npm:pi-devops-tools                     # 从 npm 安装
pi install git:github.com/zavier/pi-devops-tools   # 从 GitHub 安装
```

**本地开发：**

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

| 字段              | 默认值 | 说明                                         |
| ----------------- | ------ | -------------------------------------------- |
| `environment`     | 必填   | 环境分组名（`/db switch` 按此分组展示连接）  |
| `type`            | 必填   | 连接类型，目前仅支持 `mysql`                 |
| `host`            | 必填   | 主机名                                       |
| `port`            | `3306` | 端口                                         |
| `username`        | `root` | 用户名                                       |
| `password`        | 空     | 支持 `${环境变量}` 替换                      |
| `defaultDatabase` | 空     | 首次 `/db switch` 到该连接时自动选用的数据库 |
| `queryLimit`      | `100`  | 无 LIMIT 的 SELECT 自动追加的行数上限        |

## 使用

### 命令总览

| 命令                                                | 说明                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/db`                                               | 显示工作区面板：连接状态、可用连接和子命令                                                                        |
| `/db add`                                           | 交互式添加连接：选环境 → 连接名 → host/port → 用户名/密码 → 默认数据库；写入 `connections.yaml` 后自动 hot-reload |
| `/db switch`                                        | 切换环境 → 连接 → 数据库                                                                                          |
| `/db tables`                                        | 列出当前数据库中的所有表                                                                                          |
| `/db schema [表名]`                                 | 查看表结构（列、索引），以 markdown 表格渲染并持久展示；不带参数显示可搜索的表列表                                |
| `/db query [表名\|SQL]`                             | 查询数据：选表模式或直接执行 SQL（只读，自动追加 LIMIT）                                                          |
| `/db history [关键词]`                              | 搜索查询历史；不带关键词显示最近 20 条                                                                            |
| `/db favorite [add]`                                | 管理收藏的 SQL 模板（按数据库分组）                                                                               |
| `/db relations [add\|remove\|discover\|er-diagram]` | 管理表关联关系                                                                                                    |
| `/db related`                                       | 以悬浮层浏览器查看最近一次关联查询的关联表（←→ 切表 · ↑↓ 滚动 · Esc 关闭）                                        |
| `/db on` / `/db off`                                | 会话内启用 / 禁用扩展（见[启用与禁用](#启用与禁用)）                                                              |

`/db query` 的三种调用方式 — 参数命中已知表名走选表模式，以 `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` 开头则直接执行：

```bash
/db query                                                # 交互选择：选表 + WHERE，或输入完整 SQL
/db query users                                          # 选表模式（已知表名），输入 WHERE 条件
/db query SELECT * FROM users WHERE status = 'active'    # 直接执行 SQL
```

结果按终端宽度自适应选择水平表格 / 转置 / 垂直键值对，`ctrl+o` 可展开查看全部行；全 NULL 列、值全相同的列会被折叠并给出摘要提示。

选表模式勾选「📎 一起查询关联表」时，除主表外还会按关系图 BFS 拉取关联表数据：结果条目折叠态显示关联表摘要（表名 + 行数），`ctrl+o` 展开后与主表完整内容一起展示；也可随时执行 `/db related` 打开悬浮层浏览器逐表浏览（←→ 切换 · ↑↓ 滚动 · Esc 关闭）。完整关联数据同时进入 LLM 上下文供分析。

`/db favorite` 与 `/db relations` 的子命令：

```bash
/db favorite                            # 列出当前数据库收藏
/db favorite add                        # 交互式添加收藏（名称 + SQL + 描述）
/db favorite add <名称> <SQL>            # 直接添加，省略交互
/db relations                           # 列出已注册的关系，选择后可删除
/db relations add                       # 注册关系：选源表 → 源列 → 目标表 → 目标列 → 类型
/db relations remove                    # 删除已注册的关系
/db relations discover                  # 从 MySQL 外键约束自动发现并导入（可选 AI 分析补充）
/db relations er-diagram [表名]          # 以该表为中心生成 mermaid ER 图
```

### LLM 工具

扩展注册了 7 个工具（5 个只读 + 2 个写操作：`db_relation` 写本地 SQLite，`db_mutate` 写 MySQL），AI 可以直接调用而无需用户输入 `/db` 命令。其中 3 个工具默认不激活（按需加载），以控制上下文占用：

| 工具名              | 类型   | 激活 | 描述                                                                                        |
| ------------------- | ------ | ---- | ------------------------------------------------------------------------------------------- |
| `db_query`          | 只读   | 常驻 | 执行只读 SQL 查询（与 `/db query` 相同的安全限制）                                          |
| `db_tables`         | 只读   | 常驻 | 列出数据库的所有表；传 `table` 查看该表的结构（列、索引，实时查询）                         |
| `db_mutate`         | **写** | 常驻 | 执行 INSERT/UPDATE/DELETE/REPLACE，需人工确认                                               |
| `db_tools`          | 只读   | 常驻 | 按需启用下方 3 个懒加载工具（loader，下一轮生效）                                           |
| `db_discover`       | 只读   | 按需 | 发现可用的连接和数据库 — 探索入口。返回已配置的连接及其数据库                               |
| `db_list_relations` | 只读   | 按需 | 列出已注册的表关系 — AI 可用于自行编写 JOIN                                                 |
| `db_relation`       | **写** | 按需 | 管理表关系（本地 SQLite）：action="register"（幂等 upsert）或 action="delete"（按列对删除） |

使用前先调用 `db_tools`（query 填 "discover" 或 "relations"）按需启用，下一轮起即可用。

只读工具遵循与用户命令相同的只读保护：只能执行 SELECT/SHOW/DESCRIBE/EXPLAIN，DELETE/DROP/UPDATE 等写操作会被拒绝。`db_query`、`db_tables` 支持可选的 `connection`/`database` 参数以跨库/跨连接查询。

`db_mutate` 用于数据修改：DDL（CREATE/DROP/ALTER/TRUNCATE）被硬性拒绝，UPDATE/DELETE 无 WHERE 时会显示警告。每次调用弹出 overlay 确认弹窗（Enter 确认 / Esc 取消），不可跳过。

## 测试

端到端验证用例集见 [docs/testing/](docs/testing/)：`init-env.mjs` 每轮自动生成命名唯一的库对（主测试库 + 跨库测试库）并完成建表与种子，内置 8 项环境预检，`--cleanup` 一键销毁，不依赖固定库、多轮互不干扰；`schema.sql` 提供一套无外键、含全部关系类型与边界情况的测试表结构；`test-plan.md` 按能力域给出约 80 个用例及精确预期值（含只读守卫、LIMIT 注入、列折叠、BFS 关联查询等边界）；`ai-runner.md` 是执行协议——AI 自动跑工具层用例并断言，产出人工验证清单（写操作确认 + 交互命令），人逐项打勾即可；`requirements.md` 说明机器环境要求与全新机器部署步骤。

## 启用与禁用

扩展支持两层开关：

| 层         | 方式                                                 | 适用场景                                             |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------- |
| 会话内开关 | `/db on` / `/db off`                                 | 临时收起：不离开会话、不动配置文件，自动 reload 生效 |
| 原生禁用   | `pi config`（或 settings.json 的 `extensions` 排除） | 彻底不用：扩展完全不加载，连工厂都不执行             |

- `/db off` 通过 `ctx.reload()` 重载扩展生效，**无需手动操作**；代价是所有扩展都会被重载一次、系统提示词重建一轮（开关是低频操作，可接受）。
- 禁用后扩展完全不占用上下文空间：LLM 工具不注册（`/tools` 中消失）、`db-explore` skill 不再被发现、状态栏不再显示、`/db` 仅保留 `on` 子命令作为重新启用的入口。已配置的连接数据（`connections.yaml` / `state.db`）**不会删除**，重新启用后一切恢复。
- 开关状态存于 `~/.pi/database/extension.json`（`{ "enabled": false }`），文件缺失/损坏时默认启用。
- 扩展被 `pi config` 禁用时本扩展根本不加载，`/db on` 也不可用——那是"彻底不用"的语义，与会话内开关一致。

## 数据存储

所有状态存储在 `~/.pi/database/` 下：

| 文件               | 用途                                                |
| ------------------ | --------------------------------------------------- |
| `workspace.json`   | 当前环境/数据库选择                                 |
| `state.db`         | 查询历史、收藏、表关系的 SQLite 存储                |
| `connections.yaml` | 连接定义                                            |
| `extension.json`   | 扩展开关状态（`{ "enabled": bool }`，缺失默认启用） |

## 环境要求

- **Node.js** ≥ 20
- **pi** ≥ 0.80
- `better-sqlite3`（自动安装）
- `mysql2`（自动安装）

## License

MIT
