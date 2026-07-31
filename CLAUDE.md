@AGENTS.md

# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供指引。

## 概览

`pi-devops-tools` 是一个 [pi](https://pi.dev) 扩展，在终端内提供数据库工作空间——查询 MySQL 数据库、管理表关联关系。唯一入口是交互式 `/db` 命令。

## 命令

```bash
npm test              # 运行所有测试（vitest）
npx vitest run        # 等价写法
npx vitest path/to/test.test.ts  # 运行单个测试文件
npx tsc --noEmit      # 类型检查（无构建步骤——pi 直接加载 TypeScript）
```

## 架构

### 单一服务入口

`DatabaseWorkspaceService`（`state/workspace.ts`）是 `/db` 命令背后的 facade，组合所有模块。它在 `index.ts` 中注册——`index.ts` 是扩展唯一的接线点。

### 配置

用户级连接位于 `~/.pi/database/connections.yaml`，由 `connection/db-config.ts` 加载为 `ResolvedConnectionConfig[]`。支持密码中的 `${ENV_VAR}` 替换。没有项目级配置文件。

### 数据存储

所有持久状态位于 `~/.pi/database/` 下：

| 路径             | 格式   | 属主                                                                                                        |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `workspace.json` | JSON   | `WorkspaceContext` —— 当前的 env/connection/database 选择                                                   |
| `state.db`       | SQLite | `QueryHistoryStore` + `FavoriteStore` + `RelationStore`（3 张表、1 个 DB，通过 `history.getDb()` 共享句柄） |

### 分层结构（扁平）

```
commands/          ← /db 子命令处理器 —— 只看到 DatabaseWorkspaceService 接口
state/workspace.ts ← DatabaseWorkspaceService —— /db 背后唯一的深度模块
state/state-store.ts ← StateStore —— 拥有 baseDir + SQLite 句柄 + 派生路径（可注入接缝）
connection/        ← DatabaseConnectionManager（懒加载 mysql2 连接池）+ sql-policy（守卫 + LIMIT）
                     + db-config（connections.yaml 加载器，接受可选路径）
history/           ← QueryHistoryStore + FavoriteStore（构造函数接受 Database）
relation/          ← RelationStore（构造函数接受 Database）
relation-graph.ts  ← RelationGraph（内存双向图 + BFS，接受 Database）
formatting/        ← formatTableResult —— 自动布局：横向 / 转置 / 纵向
```

### 关键设计模式

- **深度工作空间模块**：`DatabaseWorkspaceService` 将 WorkspaceContext + QueryRunner 吸收进一个类。所有委托（`manager`、`history`、`favorites`、`relationGraph`）都是私有字段——命令通过约 23 个专用方法穿越外部接缝。任何命令都不能越过 facade。
- **单一执行点**：所有读查询经过 `DatabaseConnectionManager.executeQuery`，它应用只读守卫和 LIMIT 策略（`connection/sql-policy.ts`——纯函数，`READONLY_SQL_RE` 的唯一归属），然后在检出的专用连接上执行（`getConnection → USE → query → release`），这样 USE 与查询不会散落在连接池的不同连接上。无界 SELECT 自动追加 `LIMIT n`（默认 100，connections.yaml 中可配 per-connection `queryLimit`）；最终 SQL 通过 `result.sql` 返回，用户可以看到自动追加的 LIMIT。写操作经过 `DatabaseConnectionManager.executeMutation`——没有只读守卫，但由 `prepareMutationQuery`（拒绝 DDL）和强制人工确认对话框把关。命令处理器只在分发时（表名 vs SQL）导入 `READONLY_SQL_RE`，绝不用于执行期校验。
- **实时 schema**：`getTables()` 和 `getTableSchema()` 总是查询 `information_schema`——无缓存、无刷新。实践中足够廉价且永不过期。
- **BFS 自动 JOIN**：`RelationGraph.bfsQuery()` 遍历内存前向图，每跳发出参数化（`IN (?)`）、schema 限定的查询。深度受限（默认 2，最大 5）。它从调用方接收 `QueryFn` 而非 mysql2 连接池——图保持数据库无关，用 stub 测试。
- **懒加载工作空间初始化**：`DatabaseWorkspaceService` 不在扩展工厂中构造（工厂可能运行在从不启动会话的调用中，如 `--list-models` 或 print 模式）。懒 getter 将打开 SQLite / 读取配置推迟到 `session_start`、第一次 `/db` 命令或第一次工具调用。
- **懒加载连接**：MySQL 连接池在首次使用时创建，按 connection ID 缓存。`destroy()` 清理所有池。`reloadConfig()` 在替换前销毁旧 manager，避免旧池泄漏。
- **StateStore 接缝**：`DatabaseWorkspaceService(storage?)` 接受可选的 `StateStore`——生产默认 `~/.pi/database`，测试注入临时目录。`StateStore` 拥有 SQLite 句柄（三个存储 + RelationGraph 通过构造函数注入共享它），以及 workspace.json 和 connections 配置的路径辅助。

### LLM 工具

扩展在 `tools/db-tools.ts` 中为 LLM 注册 7 个工具（5 个只读 + 2 个写：`db_relation` 写本地 SQLite 元数据，`db_mutate` 写 MySQL）。其中 3 个工具**懒加载**——已注册但未激活，通过 `db_tools` loader 工具按需启用（`tools/db-tool-catalog.ts` 持有纯关键词匹配目录 + `applyInitialToolSet`，在 `index.ts` 的 `session_start` 中调用，让每个会话从最小集合开始）：

| 工具                | 类型   | 激活方式  | 描述                                                                                                        |
| ------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------- |
| `db_query`          | 只读   | 常驻      | 执行只读 SQL 查询；自动追加 LIMIT。结果用 `truncateHead` 截断（50KB / 2000 行）。                           |
| `db_tables`         | 只读   | 常驻      | 列出表，或展示某张表的列 + 索引（传 `table`）。使用共享纯函数 `formatSchemaMarkdown`。                      |
| `db_mutate`         | **写** | 常驻      | 执行 INSERT/UPDATE/DELETE/REPLACE，带人工确认门（overlay 对话框，Enter 批准）。拒绝 DDL。                   |
| `db_tools`          | 只读   | 常驻      | Loader：按需启用 `db_discover` / `db_list_relations` / `db_relation`（加性 `setActiveTools`，下一轮生效）。 |
| `db_discover`       | 只读   | 经 loader | 发现连接和数据库——探索入口。返回已配置的连接及某连接上的数据库。                                            |
| `db_list_relations` | 只读   | 经 loader | 列出已注册的表关联关系——AI 读这些关系自行写 JOIN 或规划批量查询。                                           |
| `db_relation`       | **写** | 经 loader | 管理本地 SQLite 中的表关联关系：action="register"（幂等 upsert）或 action="delete"（按列对匹配）。          |

`db_query` 和 `db_tables` 默认使用工作空间选择，但接受可选的 `connection` / `database` 覆盖，由 `DatabaseWorkspaceService.resolveTarget` 解析（显式 connection 不带 database 时回退到其 `defaultDatabase`）。`db_list_relations` / `db_relation` 接受可选的 `database` 覆盖。同一 MySQL 实例上的数据库可以用 `db.table` 限定名直接 JOIN——连接池不带默认数据库连接，所以 `USE` 从来不是沙箱。

只读工具 `db_query` 经过 `DatabaseWorkspaceService.executeQuery`，因此只读守卫和 LIMIT 策略生效。`db_tables` 使用与 `/db` 命令相同的实时 `information_schema` 查询（`getTables` / `getTableSchema`）。`db_discover` 读取本地连接配置并通过 manager 上的 `SHOW DATABASES` 列出数据库。`db_list_relations` / `db_relation` 通过 `RelationGraph` / `RelationStore` 操作本地 SQLite——它们不触碰 MySQL，不需要只读守卫或确认门（register 幂等，delete 按精确列对匹配）。`db_mutate` 使用 `executeMutation`——没有只读守卫，但 `prepareMutationQuery` 拒绝 DDL，每次执行都有确认对话框把关。`db_tools`（loader）只操作激活工具集。

### 消息渲染

查询结果使用双受众拆分（`commands/query.ts`、`commands/renderers.ts`）：

- **TUI**：`pi.appendEntry("db-query-result", data)` + `registerEntryRenderer` → 自适应宽度 Component（横向/转置/纵向，列宽打包用 `layoutColumns`）。`ctrl+o` 展开为完整纵向输出。
- **LLM 上下文**：`pi.sendMessage({ display: false, ... })` → `formatTableCompact`——无填充的 markdown，200 字符单元格上限加 `…[+N]` 标记，包含所有行。

| customType           | 渲染器                                                            |
| -------------------- | ----------------------------------------------------------------- |
| `db-query-result`    | Entry 渲染器：表头 + SQL + 自适应表格；关联表提示；展开看完整行。 |
| `db-workspace-panel` | Message 渲染器：原始预格式化文本（面板不是 markdown）。           |

其他（`db-tables`、`db-table-schema`、`db-er-diagram`）使用默认自定义消息渲染（紫色框 + markdown）——内容小且适合 markdown。

### 关系图数据流

1. 用户通过 `/db relations add` 注册关系：`source_table.column → target_table.column`
   - 或：AI 发现关系并调用 `db_relation` 工具（`/db relations discover` 流程指示模型使用该工具）
2. `RelationStore` 持久化到 SQLite `table_relations` 表
3. `RelationGraph` 重建其内存双向 `forward` Map
4. 自动 JOIN 查询时，`bfsQuery()` 从被查询表出发，沿已注册边遍历，将关联行作为独立 `RelatedResult` 对象返回

### 类型系统

所有共享类型在 `types.ts`：`ColumnRef`、`ColumnRelation`、`RelatedResult`。每个模块可以定义额外内部类型（如 `history/store.ts` 中的 `HistoryEntry`）。

### 测试

测试使用 `vitest`，位于 `__tests__/`（sql-policy、history、relation-graph、workspace-target 等）。它们隔离地测试单个模块。`history.test.ts` 传入 `new Database(":memory:")`；`relation-graph.test.ts` 使用 `:memory:`；`workspace-target.test.ts` 注入临时目录 `StateStore` + 临时 `connections.yaml`。
