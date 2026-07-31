# 工具分层改造设计：Dynamic Tool Loading

> 状态：已实施（v0.8.0）
> 目标版本：0.8.0

## 1. 背景与目标

当前 7 个 LLM 工具（`db_query`、`db_discover`、`db_list_tables`、`db_table_schema`、
`db_list_relations`、`db_relation`、`db_mutate`）全部常驻 system prompt，每轮请求
固定消耗约 **1.8–2.2k tokens**（description + promptSnippet + promptGuidelines +
JSON schema）。其中三个"本地侧"工具（`db_discover`、`db_list_relations`、
`db_relation`）合计约 **740 tokens/轮**，但并非每个任务都需要。

**目标**：在**不损失可靠性**的前提下把常驻工具集收窄到远程核心 4 个 + 1 个 loader，
懒工具按需激活，每轮省 ~600 tokens（约 1/3）。

**约束（来自 AGENTS.md 设计底线）**：

1. 写路径必须走扩展进程 —— `db_relation` 写 SQLite 时必须同步更新进程内
   `RelationGraph` 内存图，**禁止 skill 脚本直写 state.db**（会失同步，BFS 自动
   join 与 `/db relations` 全部看到陈旧数据）。
2. 不新增绕过 `sql-policy` 的执行路径；`db_mutate` 确认对话框不动。
3. 纯逻辑抽成纯函数以便测试。

## 2. 机制确认（pi 0.80 源码 + 文档）

- `pi.setActiveTools(names)` 全量替换当前工具集；未知名字静默忽略；立即重建
  system prompt。`session_start` 里收窄工具集是官方文档示例模式
  （`docs/extensions.md` → Dynamic Tool Loading）。
- loader 工具在 execute 中**加性**激活（只增不减），pi 会把新增工具名记录在该
  tool result 上，下一轮模型请求即生效。Anthropic 4.5+ / OpenAI gpt-5.4+ 原生
  支持 deferred loading（定义锚定在 loader 结果之后，不破坏前缀缓存）；其余模型
  走安全 fallback（下轮完整下发工具列表）。
- 懒加载工具**不应带 promptSnippet / promptGuidelines**（激活时重建 system prompt
  会失效前缀缓存）——只保留 `description`。
- 工具激活集存在 `agent.state.tools`（内存），**不持久化到 session 文件**。
  恢复会话时重新按默认（全部注册工具）激活，`session_start` 会再次触发 →
  每次会话起点都是确定性的最小集。
- 其他扩展注册的工具不在我们收窄范围内 —— 保留不动。

## 3. 目标工具分级

| 级别   | 工具                 | 常驻成本（估） | 说明                                             |
| ------ | -------------------- | -------------- | ------------------------------------------------ |
| 常驻   | `db_query`           | ~400           | 核心读                                           |
| 常驻   | `db_list_tables`     | ~160           | 核心读                                           |
| 常驻   | `db_table_schema`    | ~210           | 核心读                                           |
| 常驻   | `db_mutate`          | ~310           | 核心写（确认门禁）                               |
| 常驻   | `db_tools`（**新**） | ~200           | loader，按需激活下方 3 个                        |
| **懒** | `db_discover`        | —              | 探索入口（混合：本地连接 + 远程 SHOW DATABASES） |
| **懒** | `db_list_relations`  | —              | 本地读                                           |
| **懒** | `db_relation`        | —              | 本地写（必须走扩展进程）                         |

净节省 ≈ 740（移除） − 200（loader） − 少量 guidelines 精简 ≈ **~600 tokens/轮**。

## 4. 改动清单

### 4.1 `tools/db-tool-catalog.ts`（新文件，纯函数）

```ts
export const LOADER_TOOL_NAME = "db_tools";
export const LAZY_TOOL_NAMES = ["db_discover", "db_list_relations", "db_relation"] as const;
export function matchDbTools(query: string | undefined): string[];
```

- 关键词目录（子串匹配，小写归一化）：
  - `db_discover`：discover / connection / database / orient / explore /
    available / list databases / which database
  - `db_list_relations`：relation / relationship / join / foreign key / fk /
    reference
  - `db_relation`：register / add relation / delete relation / remove relation /
    upsert / relate
- 命中即返回（"relation" 同时命中两个关系工具时两者都返回——激活是廉价且加性的）；
  按目录顺序稳定排序。
- `query` 为空 → 返回全部懒工具（兜底，模型拿不准时直接给全）。
- 无命中 → 返回 `[]`。

### 4.2 `tools/db-tools.ts`

1. **新增 `db_tools` loader 工具**：
   - `description`：说明本工具用于按需启用三个懒工具，启用后**下一轮**可用。
   - `promptSnippet`："Enable additional database tools (discover, relations) when needed"
   - `promptGuidelines`（2 条）：
     - "Call db_tools to enable db_discover / db_list_relations / db_relation when a
       task needs them — they are loaded on demand to keep the tool set small."
     - "db_query, db_list_tables, db_table_schema, db_mutate are always available."
   - `parameters`：`{ query: Type.Optional(Type.String()) }`
   - `execute`：`matchDbTools(query)` → 过滤已在激活集的 → `setActiveTools(加性)`
     → 返回"新启用 / 已激活 / 无匹配建议"。**不需要 workspace readiness**（纯注册表操作）。
2. **移除** `db_discover` / `db_list_relations` / `db_relation` 的
   `promptSnippet` + `promptGuidelines`（保留 description）。
3. **精简常驻工具 guidelines**：`db_query` 保留 2 条（直接用 db_query 回答数据问题；
   跨库用 db.table 限定名）；`db_mutate` 保留 2 条（UPDATE/DELETE 必须带 WHERE；
   调用前先向用户解释将执行的变更）。其余删掉（使用指导已由 `db-explore` skill 承载）。
4. **导出** `applyInitialToolSet(pi)`：`getActiveTools()` 过滤掉 `LAZY_TOOL_NAMES`，
   补上 `LOADER_TOOL_NAME`，`setActiveTools`（全量替换，session 起点允许）。

### 4.3 `index.ts`

`session_start` 处理器开头调用 `applyInitialToolSet(pi)`（在现有 restoreStatusBar /
db-active-db 逻辑之前）。

### 4.4 `skills/db-explore/SKILL.md`（与 4.2 **必须同批发布**）

- "Available Tools" 表：新增"激活"列 —— 常驻 4 个 + 懒 3 个（标注经 `db_tools` 启用）。
- 新增小节 "Enabling lazy tools"：一段话 + 示例：
  `db_tools {query: "discover"}` / `db_tools {query: "relations"}`，说明下一轮生效。
- Phase 1（Orient）第一步改为：如 `db_discover` 不可用，先调 `db_tools`。
- Phase 5（Connect）同理：调 `db_list_relations` / `db_relation` 前先确保已启用。
- 脚本引用从 `workspace-status.sh` 改为 `status.mjs`（见 4.5）。

### 4.5 `skills/db-explore/scripts/`：`.sh` → `status.mjs`

用 Node 重写（消除 sqlite3 CLI / python3 / pyyaml 外部依赖）：

- 依赖：`better-sqlite3` + `js-yaml` —— **扩展自身已有的运行时依赖**。脚本位于
  扩展包内（`files: ["skills/"]` 已含），Node 从脚本目录向上解析 node_modules
  必然可达（非 hoisted 落在扩展包 node_modules，hoisted 则向上命中父级）。
- 行为与现有 `.sh` 对齐 + 增强：
  - 默认：workspace.json 当前选择、state.db 统计（relations/history/favorites 计数）、
    connections.yaml 脱敏列表（只输出 id/env/host/defaultDatabase，**不打印密码**，
    并对 `${ENV_VAR}` 做显示级替换）。
  - `node status.mjs relations [table]`：输出 `table_relations` 全量/按表过滤，
    格式与工具输出一致（`#id schema.table.column → ref_table.ref_column (TYPE)`），
    作为 `db_list_relations` 的 skill 兜底。
- 删除 `workspace-status.sh`，同步更新 SKILL.md 中所有引用。
- 数据目录：`$HOME/.pi/database`（与 StateStore 生产默认一致，沿用 .sh 原逻辑）。

### 4.6 `README.md`

- LLM 工具表：新增"常驻/按需"标注 + `db_tools` 行 + 一段"按需启用"说明。

### 4.7 测试

- 新增 `__tests__/db-tool-catalog.test.ts`：`matchDbTools` 空查询 / 关键词命中 /
  重叠命中（relation → 两个）/ 无命中；`LAZY_TOOL_NAMES` 与注册一致。
- 现有测试全量回归（`npm run check && npm test && npm run lint && npm run fmt`）。

## 5. 边界情况与决策

| 场景                           | 行为                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| 会话恢复                       | 工具集重置为最小集（确定性）；历史消息中的懒工具调用原样保留，无 schema 兼容问题（参数未变） |
| 其他扩展的工具                 | `applyInitialToolSet` 只滤掉本扩展懒工具，其余保留                                           |
| `--no-tools` / 用户受限工具集  | `setActiveTools` 对受限名静默忽略（`isAllowedTool` 过滤），no-op                             |
| 模型未先调 loader 就"用"懒工具 | 不可能发生——工具不在 prompt 里，模型无法调用；SKILL.md 同批更新保证流程正确                  |
| loader 重复激活                | 幂等：已激活则返回"already active"，不加性重复                                               |
| 懒工具带 snippet/guidelines    | 已按文档要求移除（避免激活时重建 system prompt）                                             |
| 会话中途用户 /tools UI 启停    | 与 loader 互不干扰；下次 session_start 重置                                                  |
| 模型把 loader 当搜索用         | 正是设计意图；无命中时返回建议关键词                                                         |

## 6. 不做的事（范围保护）

- **不**改 `sql-policy.ts` / `db_query` 的 `ready()`（`db_discover` 保留为工具，
  无需 `SHOW DATABASES` 变通）。
- **不**删 `db_list_relations` / `db_relation` 的工具注册（懒加载即可；skill 直写
  SQLite 会破坏 RelationGraph 内存一致性）。
- **不**动 `RelationStore` / `RelationGraph` / `db_mutate` 确认门禁。
- **不**引入新依赖。

## 7. 验收清单

1. `npx tsc --noEmit`、`npx vitest run`、`npm run lint`、`npm run fmt:check` 全绿。
2. 手动冒烟（pi 交互会话）：
   - `/tools` 或 system prompt 中常驻工具 = 内置 + `db_query`/`db_list_tables`/
     `db_table_schema`/`db_mutate`/`db_tools`；懒工具不在列。
   - 问"有哪些数据库" → 模型调 `db_tools{query:"discover"}` → 下一轮 `db_discover`
     可用并成功执行。
   - 问"users 和 orders 的关系" → loader 激活关系工具 → `db_list_relations` 可调。
   - `/skill:db-explore` 后 `node skills/db-explore/scripts/status.mjs` 与
     `node skills/db-explore/scripts/status.mjs relations` 输出正确、无密码泄露。
   - 退出重进会话 → 工具集回到最小集（确定）。
3. `npm pack --dry-run` 确认 `skills/`（含新 `.mjs`）入包。

## 8. 任务拆分（依赖顺序）

1. `db-tool-catalog.ts` 纯函数 + `__tests__/db-tool-catalog.test.ts`
2. `db-tools.ts`：loader 注册 + 懒工具元数据移除 + guidelines 精简 + `applyInitialToolSet`
3. `index.ts`：session_start 接线
4. `status.mjs` 迁移 + SKILL.md 更新（工具表 / lazy 小节 / Phase 1/5 / 脚本引用）
5. README 更新 + 全量校验（check/test/lint/fmt + 手动冒烟 + pack 验证）

> 预计净上下文收益 ~600 tokens/轮（约 1/3）；可靠性零损失；写路径零改动。
