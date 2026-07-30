# pi-devops-tools 架构设计

pi-devops-tools 是一个 [pi](https://pi.dev) 终端扩展，提供交互式 MySQL 数据库工作空间。通过 `/db` 命令在终端内完成查询、浏览表结构、管理表关联关系等操作。

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
│  └───┬──────────────────┬──────────────────────────┘  │
│      │                  │          │                     │
│  ┌───▼──┐          ┌───▼───┐ ┌───▼──────┐            │
│  │连接层 │          │历史/收藏│ │关系图引擎│            │
│  └───┬──┘          └───┬───┘ └───┬──────┘            │
└──────┼─────────────────┼─────────┼───────────────────┘
       │                 │         │
  ┌────▼──┐         ┌───▼───┐ ┌──▼──────────┐
  │ MySQL │         │SQLite │ │  In-memory   │
  │ Pool  │         │  DB   │ │    Graph     │
  └───────┘         └───────┘ └──────────────┘
```

## 二、分层架构

项目采用**扁平分层**，严格的单向依赖：

```
commands/          ← UI 层：/db 子命令处理器，只依赖门面接口
state/workspace.ts ← 门面层：DatabaseWorkspaceService，组合所有模块
connection/        ← 连接层：MySQL 连接池管理 + SQL 安全策略
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
  async executeQuery(sql, opts?): Promise<QueryResult>;
  async executeQueryWithRelations(sql, table, autoJoin): Promise<...>;

  // ── 数据修改（人工确认门控）──
  async executeMutation(sql, opts?): Promise<MutationResult>;
  resolveTarget(opts?): QueryTarget;

  // ── 目标解析（跨库/跨连接）──
  resolveTarget(opts?): QueryTarget;  // 默认当前选择，可按调用覆盖

  // ── Schema（实时查询，无缓存）──
  async getTables(opts?): Promise<string[]>;
  async getTableSchema(table, opts?): Promise<ColumnInfo>;

  // ── 历史 / 收藏 ──
  saveHistory(sql, rowCount, elapsed): HistoryEntry;
  saveFavorite(name, sql, desc): FavoriteEntry;

  // ── 关系图 ──
  upsertRelation(srcTable, srcCol, refTable, refCol, opts?): RelationRow;
  removeRelationByColumns(database, srcTable, srcCol, refTable, refCol): boolean;
  async discoverForeignKeys(): Promise<number>;
}
```

**设计意图**：门面模式确保内部重构不影响命令层。如果要替换 SQLite 为其他存储，只需改 `StateStore` 和三个 Store 的构造函数 — 命令层代码零改动。

### 3.2 连接管理 — DatabaseConnectionManager

**一句话**：所有 SQL 执行的入口 — 读查询走 `executeQuery`（只读守卫 + LIMIT），写操作走 `executeMutation`（DML 校验 + 人工确认门控），两者共享连接池。

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
| `MUTATION_SQL_RE`                  | 正则匹配 INSERT / UPDATE / DELETE / REPLACE   |
| `prepareMutationQuery(sql)`        | 校验 DML → 返回操作类型/WHERE 检查/警告       |

**LIMIT 追加规则**：

- `SELECT ... LIMIT n` → 不追加（已有）
- `SELECT ... (subquery) LIMIT n` → 不追加（外层已有）
- `SELECT ... FOR UPDATE` → 不追加（锁定读）
- `SELECT ...` → 追加 `LIMIT 100`（默认，可在 connections.yaml 中配置 `queryLimit`）
- `SHOW ...` / `DESCRIBE ...` → 原样通过

### 3.4 Schema 实时查询与跨库目标解析

`getTables()` / `getTableSchema()` 每次都直接查询 `information_schema` — **没有缓存层**。历史上曾有本地 JSON 缓存（`/db refresh-schema` 刷新），后来移除：实时查询成本很低，缓存带来的陈旧问题和维护成本不值。（详见 4.4）

门面的 `resolveTarget({ connectionId?, database? })` 是跨库能力的核心：

- 默认解析为当前 workspace 选择（`switchTo` 设定的连接 + 数据库）
- 只传 `database` → 当前连接上的另一个库（MySQL 同实例天然支持 `db.table` 跨库 JOIN — 连接池不指定默认数据库，`USE` 只是默认值而非沙箱）
- 只传 `connectionId` → 回落到该连接的 `defaultDatabase`
- 都传 → 任意已配置连接上的任意库（跨实例无法 JOIN，但可分别查询）

LLM 工具（`db_query` 等）通过可选 `connection` / `database` 参数暴露这一能力，不需要 `/db switch` 来回切换。

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

### 3.6 结果格式化

纯函数模块 `formatting/result-table.ts`，导出四个主要入口：

| 函数                 | 受众 | 说明                                                                                      |
| -------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `formatTableDisplay` | TUI  | 自适应终端宽度 — 先尝试水平表格（`layoutColumns` 列宽打包），放不下则转置，再多行用垂直。 |
| `formatTableCompact` | LLM  | 无填充紧凑格式，200 字符截断带 `…[+N]` 标记，全部行。                                     |
| `formatVerticalFull` | TUI  | 展开模式完整键值对，不截断。                                                              |
| `formatTableResult`  | 兼容 | `formatTableDisplay(120)` 的别名，向后兼容。                                              |

列分析（`analyzeColumns`）在格式化前运行，自动折叠全 NULL 列和值完全相同列，在底部注释汇总（`ⓘ 已隐藏 N 列`）。

### 3.7 数据修改工具 — db_mutate

`db_mutate` 是唯一的写路径，设计原则是「AI 提议，人类批准」：

```
LLM 调用 db_mutate({ sql, connection?, database? })
  │
  ├─ 1. prepareMutationQuery(sql)     ← DML 校验（DDL 直接拒绝）
  ├─ 2. resolveTarget(opts)           ← 目标解析
  ├─ 3. showMutationConfirm()         ← TUI overlay 弹窗
  │     ├─ Enter → 确认
  │     └─ Esc  → 取消（返回给 LLM）
  └─ 4. manager.executeMutation()     ← 执行，返回 affectedRows
```

**安全边界**：

- DDL（CREATE/DROP/ALTER/TRUNCATE）硬性拒绝，不弹窗
- UPDATE/DELETE 无 WHERE 时弹窗显示醒目警告，但不阻止执行
- 每次调用独立确认，无缓存/跳过机制
- `mutate-confirm.ts` 组件用颜色区分操作类型：INSERT=绿、UPDATE=黄、DELETE=红

### 3.8 持久化存储

所有数据在 `~/.pi/database/` 下：

| 文件               | 格式         | 内容                                                          |
| ------------------ | ------------ | ------------------------------------------------------------- |
| `workspace.json`   | JSON         | 当前选择的环境/连接/数据库                                    |
| `connections.yaml` | YAML         | 用户配置的数据库连接（支持 `${ENV}` 替换）                    |
| `state.db`         | SQLite (WAL) | 三张表：`query_history`、`query_favorites`、`table_relations` |

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

这种方式的优点是测试运行快（无网络 IO）、可并行、可离线运行。

### 4.4 为什么不做 Schema 缓存？

早期版本有本地 JSON 缓存（`schema/<connId>/<db>.json` + `/db refresh-schema`），后来整体移除，全部实时查询 `information_schema`。理由：

- **实时查询成本很低** — information_schema 查询是毫秒级的本地元数据读取，即使远程数据库也可忽略
- **缓存永不过时是不可能的** — 自动过期需要跟踪 DDL 变更，手动刷新（`/db refresh-schema`）则把负担推给用户，AI 拿到陈旧表列表时还无法自愈
- **少一层少一类 bug** — 缓存读写、目录管理、刷新命令、autoLoad 全部消失，代码路径只剩一条

如果未来某场景证明实时查询是瓶颈（如超高延迟链路 + 频繁列表），再以「有测量的需求」为前提重新引入。

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
   ├─ ws.saveHistory()              ← 记录历史
   ├─ pi.appendEntry()              ← TUI 自适应宽度表格（EntryRenderer）
   └─ pi.sendMessage({display:false}) ← LLM 上下文紧凑表格
```

### 5.2 关系注册

```
1. commands/relations.ts: handleRelationsAdd()
   ├─ pickTable("源表")
   ├─ ws.getTableSchema(table)      ← 获取列信息
   ├─ select("源列")
   ├─ pickTable("关联表")
   ├─ select("关联列")
   └─ ws.upsertRelation(srcTable, srcCol, refTable, refCol)
        │
2. workspace.ts: upsertRelation()
   └─ relationGraph.upsert()
        │
3. relation-graph.ts: upsert()
   ├─ store.upsert()              ← 持久化到 SQLite（幂等）
   └─ rebuildForward()            ← 全量重建内存图（正反双向）
```

### 5.3 数据修改 `/db mutate`（LLM 工具）

```
1. tools/db-tools.ts: db_mutate.execute()
   ├─ prepareMutationQuery(sql)       ← DML 校验
   ├─ ws.resolveTarget(opts)          ← 目标解析
   └─ showMutationConfirm(ctx, ...)   ← TUI overlay 确认
        │
        ├─ 用户按 Esc → 返回 rejected 给 LLM
        │
        └─ 用户按 Enter ↓
              │
2. workspace.ts: executeMutation()
   └─ manager.executeMutation(connId, db, sql)
        │
3. db-manager.ts: executeMutation()
   ├─ pool.getConnection()
   ├─ USE `database`
   ├─ conn.query(sql)                ← ResultSetHeader
   └─ conn.release()
```

## 六、扩展点

| 扩展场景        | 改动范围                                         | 说明                                       |
| --------------- | ------------------------------------------------ | ------------------------------------------ |
| 支持 PostgreSQL | 新增 `connection/pg-manager.ts`，实现相同接口    | `DatabaseConnectionManager` 接口已是隐式的 |
| 新增子命令      | 在 `commands/` 下创建文件，在 `db.ts` 路由中注册 | 不需要改门面（如果现有方法够用）           |
| 替换 SQLite     | 改 `StateStore` 构造函数 + 三个 Store 类         | Store 类对外接口不变                       |
| 导出查询结果    | 在 `commands/` 下新增 handler                    | 纯 UI 层改动                               |

## 七、代码质量保障

```
tsc --noEmit     ← TypeScript 类型检查（strict mode）
vitest run       ← 100+ 个单元测试（无外部依赖）
oxlint           ← Rust linter（correctness + suspicious + perf）
oxfmt --check    ← Rust formatter（统一风格）
```

CI 在每次 push 到 main 和 PR 时自动运行全部四项检查。
