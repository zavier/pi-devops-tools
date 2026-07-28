# pi-devops-tools 架构设计

pi-devops-tools 是一个 [pi](https://pi.dev) 终端扩展，提供交互式 MySQL 数据库工作空间。通过 `/db` 命令在终端内完成查询、浏览表结构、管理表关联关系、缓存 schema 等操作。

## 一、系统全景

```
┌─────────────────────────────────────────────────────────┐
│                      pi 终端环境                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │                 /db 命令                           │  │
│  │  ┌──────┐ ┌───────┐ ┌──────┐ ┌───────┐ ┌───────┐ │  │
│  │  │switch│ │tables │ │schema│ │ query │ │relations│  │  │
│  │  └──────┘ └───────┘ └──────┘ └───────┘ └───────┘ │  │
│  └───────────────────┬───────────────────────────────┘  │
│                      │                                  │
│  ┌───────────────────▼───────────────────────────────┐  │
│  │          DatabaseWorkspaceService                  │  │
│  │              (facade / 门面)                       │  │
│  └───┬──────────┬──────────┬──────────┬──────────────┘  │
│      │          │          │          │                  │
│  ┌───▼──┐ ┌────▼────┐ ┌───▼───┐ ┌───▼──────┐           │
│  │连接层 │ │Schema层│ │历史/收藏│ │关系图引擎│           │
│  └───┬──┘ └────┬────┘ └───┬───┘ └───┬──────┘           │
└──────┼─────────┼──────────┼─────────┼──────────────────┘
       │         │          │         │
  ┌────▼──┐ ┌───▼────┐ ┌───▼───┐ ┌──▼──────────┐
  │ MySQL │ │  JSON  │ │SQLite │ │  In-memory   │
  │ Pool  │ │ Cache  │ │  DB   │ │    Graph     │
  └───────┘ └────────┘ └───────┘ └──────────────┘
```

## 二、分层架构

项目采用**扁平分层**，严格的单向依赖：

```
commands/          ← UI 层：/db 子命令处理器，只依赖门面接口
state/workspace.ts ← 门面层：DatabaseWorkspaceService，组合所有模块
connection/        ← 连接层：MySQL 连接池管理 + SQL 安全策略
schema/            ← Schema 层：本地 JSON 缓存读写
history/           ← 持久层：查询历史 + 收藏夹 (SQLite)
relation/          ← 关系层：表关联持久化 (SQLite)
relation-graph.ts  ← 图引擎：内存双向图 + BFS 遍历
formatting/        ← 展示层：查询结果格式化（纯函数）
types.ts           ← 类型层：共享领域类型
```

每一层只能向下依赖，从不反向。命令层不知道连接池的存在，图引擎不知道 MySQL 的存在。

## 三、核心组件

### 3.1 门面 — DatabaseWorkspaceService

**一句话**：`/db` 命令背后的唯一入口，所有功能通过它的 ~23 个公共方法暴露。

```typescript
class DatabaseWorkspaceService {
  // 全部私有 — 外部不可见
  private store: StateStore;
  private manager: DatabaseConnectionManager;
  private history: QueryHistoryStore;
  private favorites: FavoriteStore;
  private relationGraph: RelationGraph;

  // 当前工作状态
  current: WorkspaceState | null;  // { environment, connectionId, database }

  // 公共方法（按职责分组）
  // ── 连接管理 ──
  getEnvironments(): string[];
  switchTo(env, connId, db): void;

  // ── 数据查询 ──
  async executeQuery(sql): Promise<QueryResult>;
  async executeQueryWithRelations(sql, table, autoJoin): Promise<...>;

  // ── Schema ──
  async getTables(): Promise<string[]>;
  async getTableSchema(table): Promise<ColumnInfo>;
  async refreshSchema(): Promise<SchemaSnapshot>;

  // ── 历史 / 收藏 ──
  saveHistory(sql, rowCount, elapsed): HistoryEntry;
  saveFavorite(name, sql, desc): FavoriteEntry;

  // ── 关系图 ──
  registerRelation(src, ref): RelationRow;
  async discoverForeignKeys(): Promise<number>;
}
```

**设计意图**：门面模式确保内部重构不影响命令层。如果要替换 SQLite 为其他存储，只需改 `StateStore` 和三个 Store 的构造函数 — 命令层代码零改动。

### 3.2 连接管理 — DatabaseConnectionManager

**一句话**：所有 SQL 查询的唯一执行入口，保证安全策略和连接复用。

```
executeQuery(connId, db, sql)
  │
  ├─ 1. prepareReadOnlyQuery(sql, limit)  ← 只读校验 + LIMIT 注入
  ├─ 2. pool.getConnection()              ← 检出专用连接
  ├─ 3. USE `database`                    ← 切换数据库（同一连接）
  ├─ 4. conn.query(finalSql, params)      ← 执行查询
  └─ 5. conn.release()                    ← 归还连接（finally 块）
```

**为什么需要专用连接**：MySQL 的 `USE database` 是连接级状态。如果使用连接池的 `pool.query()`，两次调用可能落在不同连接上，导致 `USE` 和 `query` 分离。检出专用连接并在 finally 中归还，保证了原子性。

**延迟连接**：MySQL 连接池在第一次使用时才创建（`getPool()` 懒初始化），按 connection ID 缓存。`destroy()` 遍历关闭所有池。

### 3.3 SQL 安全策略 — sql-policy.ts

纯函数模块，两个职责：

| 函数                               | 作用                                          |
| ---------------------------------- | --------------------------------------------- |
| `READONLY_SQL_RE`                  | 正则匹配 SELECT / SHOW / DESCRIBE / EXPLAIN   |
| `prepareReadOnlyQuery(sql, limit)` | 校验只读 → 未限定的 SELECT 自动追加 `LIMIT n` |

**LIMIT 追加规则**：

- `SELECT ... LIMIT n` → 不追加（已有）
- `SELECT ... (subquery) LIMIT n` → 不追加（外层已有）
- `SELECT ... FOR UPDATE` → 不追加（锁定读）
- `SELECT ...` → 追加 `LIMIT 100`（默认，可在 connections.yaml 中配置 `queryLimit`）
- `SHOW ...` / `DESCRIBE ...` → 原样通过

### 3.4 Schema 缓存

```
查询流程：
  getTables()
    ├─ 缓存命中 → 返回 JSON 中的表列表
    └─ 缓存未命中 → 查询 information_schema → 返回

  refreshSchema()
    ├─ 查询 information_schema.TABLES（获取表列表）
    ├─ 批并行查询每张表的 COLUMNS + INDEXES（5 并发）
    └─ 持久化到 ~/.pi/database/schema/<connId>/<db>.json
```

**缓存不是事实来源** — 它只是性能优化。刷新是显式的（`/db refresh-schema`），或切换数据库时自动触发（`autoLoadSchema`）。

### 3.5 关系图引擎 — RelationGraph

**数据结构**：内存中的**双向图**。

```
注册关系: source.column → target.column (MANY_TO_ONE)
效果:
  forward["db.orders.user_id"] → { targets: [user.id] }     ← 前向
  forward["db.users.id"]       → { targets: [orders.user_id] } ← 反向（自动创建）
```

每条注册的关系同时写入正反两个方向。这使得 BFS 遍历可以从任意表出发，沿任意方向跳转。

**BFS 自动联查**：

```
用户查询: /db query orders (选择关联表)

bfsQuery("orders", rows, maxDepth=2, limit=10)
  │
  ├─ depth 0: 查询 orders
  │     getDirectRelations("orders") → orders.user_id → users.id
  │     SELECT * FROM users WHERE id IN (row1.user_id, row2.user_id, ...) LIMIT 10
  │     (同深度的多个方向 Promise.allSettled 并行)
  │
  ├─ depth 1: 查询 users 返回的关联
  │     getDirectRelations("users") → users.id → orders.user_id (反向, visited 跳过)
  │                               → users.dept_id → depts.id
  │     SELECT * FROM depts WHERE id IN (...) LIMIT 10
  │
  └─ 返回: [RelatedResult(users), RelatedResult(depts)]
```

**关键设计**：

- `QueryFn` 解耦 — 图引擎不依赖 mysql2，只接受一个 `(sql, params) => rows` 函数签名，测试用 stub 替代
- `visited` 集合防止环路 — 已访问的 `schema.table.column` 不会重复查询
- 参数化查询 — `IN (?)` + mysql2 数组展开，无 SQL 注入风险
- `null` 值跳过 — 外键为 NULL 的行不触发关联查询

### 3.6 结果格式化 — formatTableResult

自动选择最优布局：

```
≤ 8 列  →  水平 Markdown 表格
> 8 列 & ≤ 10 行 → 转置（行列互换）
> 8 列 & > 10 行 → 垂直键值对（每行一组）
```

列分析（`analyzeColumns`）在格式化前运行，自动折叠全 NULL 列和值完全相同列，在底部注释汇总。

### 3.7 持久化存储

所有数据在 `~/.pi/database/` 下：

| 文件                        | 格式         | 内容                                                          |
| --------------------------- | ------------ | ------------------------------------------------------------- |
| `workspace.json`            | JSON         | 当前选择的环境/连接/数据库                                    |
| `connections.yaml`          | YAML         | 用户配置的数据库连接（支持 `${ENV}` 替换）                    |
| `state.db`                  | SQLite (WAL) | 三张表：`query_history`、`query_favorites`、`table_relations` |
| `schema/<connId>/<db>.json` | JSON         | 表/列/索引快照，带 `refreshedAt` 时间戳                       |

## 四、关键设计决策

### 4.1 为什么是门面模式而不是每个命令独立调用？

一个 `/db query` 的执行路径涉及 5 个模块协作：连接管理、SQL 策略、查询执行、结果格式化、历史记录。如果命令层直接调用这些模块：

- 每个命令需要理解全部 5 个模块的接口
- 模块间的协作逻辑分散在多个命令中
- 修改内部架构需要改所有命令

门面将「如何协作」封装在一个地方，命令只关心「做什么」。

### 4.2 为什么用双向图而不是单纯的 FK 外键？

MySQL 的 `information_schema.KEY_COLUMN_USAGE` 只能发现已定义的外键约束。实际项目中大量关系靠列名约定隐含（`user_id`、`dept_no`）。双向图模型允许用户手动注册任意关系，且 BFS 可以沿任意方向遍历 — 从用户出发查订单、从订单出发查用户均可。

### 4.3 为什么可注入而不直接 mock？

测试哲学：用真实替身（`:memory:` SQLite、临时目录、stub 函数），不用 mock 框架。

- `StateStore` 接受可选 `baseDir` — 测试注入 `tmpdir()`，生产用 `~/.pi/database`
- Store 类接受 `Database` 句柄 — 测试传 `new Database(":memory:")`
- `RelationGraph.bfsQuery()` 接受 `QueryFn` — 测试传 stub 函数，按 `schema.table` 前缀路由返回值
- Schema cache 函数接受可选 `baseDir` — 测试用临时目录

这种方式的优点是测试运行快（无网络 IO）、可并行、可离线运行。

### 4.4 为什么缓存优先但不自动刷新？

Schema 缓存（JSON 文件）读取快于 information_schema 查询，尤其是在远程数据库场景。但它不会自动过期 — 用户显式执行 `/db refresh-schema` 或切换数据库时才刷新。这样设计的考虑：

- 自动过期需要跟踪 DDL 变更，需要额外的轮询或触发器
- pi 终端会话通常针对同一 schema 连续工作，缓存新鲜度足够
- 用户控制刷新时机，避免意外的网络延迟

## 五、数据流走查

### 5.1 用户查询 `/db query orders`

```
1. commands/query.ts: handleQuery()
   ├─ 校验 ws.isReady
   ├─ pickTable("orders")           ← 交互式表选择（支持模糊过滤）
   ├─ 输入 WHERE 条件
   ├─ 询问是否查询关联表
   └─ 构建 SQL: SELECT * FROM `orders` WHERE ...
        │
2. workspace.ts: executeQueryWithRelations()
   ├─ manager.executeQuery(sql)     ← 主表查询
   └─ relationGraph.bfsQuery()      ← BFS 关联表查询
        │
3. db-manager.ts: executeQuery()
   ├─ prepareReadOnlyQuery(sql)     ← 安全策略
   ├─ pool.getConnection()
   ├─ USE `database`
   └─ conn.query(finalSql)
        │
4. query.ts: displayQueryResult()
   ├─ formatTableResult()           ← 格式化
   ├─ ws.saveHistory()              ← 记录历史
   ├─ ctx.ui.notify()               ← 展示给用户
   └─ pi.sendMessage()              ← 发送 db-query-result 给 pi
```

### 5.2 Schema 刷新

```
1. commands/refresh-schema.ts: handleRefreshSchema()
   └─ ws.refreshSchema()
        │
2. schema/cache.ts: refreshSchemaCache()
   ├─ manager.getTables()           ← information_schema.TABLES
   ├─ Promise.all(batch) × N        ← 5 并发查询每张表
   └─ saveSchemaCache()             ← 持久化 JSON
```

### 5.3 关系注册

```
1. commands/relations.ts: handleRelationsAdd()
   ├─ pickTable("源表")
   ├─ ws.getTableSchema(table)      ← 获取列信息
   ├─ select("源列")
   ├─ pickTable("关联表")
   ├─ select("关联列")
   └─ ws.registerRelation(srcTable, srcCol, refTable, refCol)
        │
2. workspace.ts: registerRelation()
   └─ relationGraph.register()
        │
3. relation-graph.ts: register()
   ├─ store.insert()                ← 持久化到 SQLite
   └─ addToForward(source, target)  ← 更新内存图（正反双向）
```

## 六、扩展点

| 扩展场景        | 改动范围                                         | 说明                                       |
| --------------- | ------------------------------------------------ | ------------------------------------------ |
| 支持 PostgreSQL | 新增 `connection/pg-manager.ts`，实现相同接口    | `DatabaseConnectionManager` 接口已是隐式的 |
| 新增子命令      | 在 `commands/` 下创建文件，在 `db.ts` 路由中注册 | 不需要改门面（如果现有方法够用）           |
| 替换 SQLite     | 改 `StateStore` 构造函数 + 三个 Store 类         | Store 类对外接口不变                       |
| Schema 自动过期 | 在 `getTables()` 中加时间戳检查                  | 不影响其他模块                             |
| 导出查询结果    | 在 `commands/` 下新增 handler                    | 纯 UI 层改动                               |

## 七、代码质量保障

```
tsc --noEmit     ← TypeScript 类型检查（strict mode）
vitest run       ← 60 个单元测试（无外部依赖）
oxlint           ← Rust linter（correctness + suspicious + perf）
oxfmt --check    ← Rust formatter（统一风格）
```

CI 在每次 push 到 main 和 PR 时自动运行全部四项检查。
