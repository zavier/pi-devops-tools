# 表工具合并方案：db_list_tables + db_table_schema → db_tables

> 状态：已实施（`db_tables` 位于 `tools/db-tools.ts`）
> 前置：v0.8.0 Dynamic Tool Loading 已完成（`docs/tool-loading-redesign.md`）

## 1. 背景与目标

上轮改造后常驻 5 个工具（db_query / db_list_tables / db_table_schema / db_mutate / db_tools）。
其中 `db_list_tables` 与 `db_table_schema` 是同一探索动作（"查看库/表结构"）的两个视图，
且共享完全相同的可选参数（`connection` / `database`），各自的 description、promptSnippet、
promptGuidelines、参数 schema 在 system prompt 中重复出现。

**目标**：合并为一个 `db_tables` 工具（方案 C，已确认），用 `table` 参数的有无天然区分
两种模式——无歧义、零新增模型认知负担，同时保留全部结构化返回能力。

**收益**：常驻成本每轮约省 **130–150 tokens**（两个工具 ~240 → 一个 ~100），
常驻工具 5 → 4，总注册 8 → 7。

## 2. 现状成本（每轮 system prompt，估算）

| 工具                 | description + snippet + guidelines + schema |
| -------------------- | ------------------------------------------- |
| db_list_tables       | ~110 tokens                                 |
| db_table_schema      | ~130 tokens                                 |
| **合并后 db_tables** | **~100 tokens（净省 ~140）**                |

## 3. 目标形态

### 3.1 工具定义

```ts
pi.registerTool({
  name: "db_tables",
  label: "DB Tables",
  description:
    "List tables in a database, or inspect one table's columns and indexes (live query). " +
    "Without `table`: returns the table list of the target database. With `table`: returns " +
    "the full schema — columns (name, type, nullable, key, comment) and indexes — formatted " +
    "as Markdown. Defaults to the currently selected database; pass connection/database to " +
    "target elsewhere.",
  promptSnippet: "List tables, or show a table's columns and indexes",
  promptGuidelines: [
    "List tables before guessing table names in db_query; pass table to check columns and types before writing SQL.",
  ],
  parameters: Type.Object({
    table: Type.Optional(Type.String({ description: "Table name. Omit to list tables." })),
    ...targetParams,
  }),
  async execute(_toolCallId, params) {
    const ws = ready(!!(params.connection && params.database));
    const target = ws.resolveTarget({ connectionId: params.connection, database: params.database });
    if (params.table) {
      // schema 模式：getTableSchema + formatSchemaMarkdown（与现 db_table_schema 完全一致）
      const { columns, indexes } = await ws.getTableSchema(params.table, target);
      return {
        content: [
          {
            type: "text",
            text: truncate(formatSchemaMarkdown(params.table, target.database, columns, indexes)),
          },
        ],
        details: {
          connection: target.connectionId,
          database: target.database,
          table: params.table,
        },
      };
    }
    // 列表模式：getTables（与现 db_list_tables 完全一致）
    const tables = await ws.getTables(target);
    return {
      content: [
        {
          type: "text",
          text: `Tables in ${target.connectionId}/${target.database} (${tables.length}):\n${tables.join("\n")}`,
        },
      ],
      details: { connection: target.connectionId, database: target.database, tables },
    };
  },
});
```

要点：

- **两种模式由 `table` 参数有无区分**，不引入 `op` 枚举——模型零学习成本（"想查结构就传表名"）
- 两个分支的 execute 逻辑**原样搬运**，返回格式与 details 结构不变（下游无感知）
- `ready()` 守卫、`resolveTarget`、`targetParams` 与现状一致

### 3.2 删除内容

- `db_list_tables` 注册块（description / snippet / guideline / schema / execute）
- `db_table_schema` 注册块（同上）
- `db_discover` description 中的 "valid for the optional params of db_query, db_list_tables, and db_table_schema" → "db_query, and db_tables"

## 4. 引用点更新清单（逐文件）

| 文件                            | 位置                     | 改动                                                                                                   |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `tools/db-tools.ts`             | db_discover description  | 参数指引改 db_tables                                                                                   |
| `commands/switch.ts`            | :186 LLM 提示文本        | "Use db_query, db_list_tables, and db_table_schema" → "Use db_query and db_tables"                     |
| `formatting/schema-table.ts`    | :3 头注释                | "the db_table_schema LLM tool" → "the db_tables LLM tool"                                              |
| `skills/db-explore/SKILL.md`    | :28-29 工具表            | 两行合并为一行 db_tables（激活列 = always）                                                            |
| 同上                            | :39 激活说明             | "db_query, db_list_tables, db_table_schema, and db_mutate" → "db_query, db_tables, and db_mutate"      |
| 同上                            | :76 失败重试             | db_table_schema → db_tables（带 table）                                                                |
| 同上                            | :106 Phase 2             | db_list_tables → db_tables                                                                             |
| 同上                            | :120,123 Phase 3         | db_table_schema → db_tables                                                                            |
| 同上                            | :197 Empty database 边界 | db_list_tables → db_tables                                                                             |
| `README.md`                     | :178 数量表述            | "8 个工具（6 只读 + 2 写）" → "7 个工具（5 只读 + 2 写）"                                              |
| 同上                            | :183-184 工具表          | 两行合并为一行 db_tables                                                                               |
| 同上                            | :193 参数说明            | "db_query、db_list_tables、db_table_schema 支持…" → "db_query、db_tables 支持…"                        |
| `CLAUDE.md`                     | :70-71 工具表            | 两行合并为一行 db_tables                                                                               |
| 同上                            | :78 参数说明             | 三个工具 → db_tables                                                                                   |
| 同上                            | :80 执行路径             | "(`db_query`, `db_list_tables`, `db_table_schema`)" → "(`db_query`, `db_tables`)"                      |
| `index.ts`                      | 注册注释                 | 常驻列表 "(db_query, db_list_tables, db_table_schema, db_mutate)" → "(db_query, db_tables, db_mutate)" |
| `docs/tool-loading-redesign.md` | —                        | 不改（历史记录）；新文档顶部已注明取代关系                                                             |

## 5. 边界（明确不动）

- `sql-policy.ts`、`executeQuery` / `executeMutation`、`ready()`、`resolveTarget` 不动
- 懒加载三工具（db_discover / db_list_relations / db_relation）与 loader 机制不动
- `db_query`、`db_mutate` 的定义不动
- `db-tool-catalog.ts` 不动（`LAZY_TOOL_NAMES` 与关键词目录均不涉及这两个工具）
- 不引入新依赖

## 6. 风险与缓解

| 风险                                                | 缓解                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 模型想查 schema 却忘传 `table` → 拿到表列表，多一轮 | description 首句 "or inspect one table's…" + guideline 明确 "pass table to check columns"；模型成本可接受（同现 db_list_tables 误用） |
| 引用点更新遗漏导致 skill/提示文本指向不存在的工具   | 第 4 节清单逐文件核对；全量 grep `db_list_tables                                                                                      | db_table_schema` 归零校验 |
| 回归：schema 输出格式变化                           | 分支逻辑原样搬运，返回格式与 details 不变；stub 冒烟对比两种模式                                                                      |

## 7. 验收

1. `npm run check` / `npm test`（应仍 131 通过，无既有测试删除）/ `npm run lint`（0 error）/ `npm run fmt:check` 全绿
2. 全仓 grep `db_list_tables|db_table_schema` **零命中**（除历史设计文档 docs/tool-loading-redesign.md、docs/table-tool-consolidation.md 自身）
3. stub-pi 冒烟（不入库）：7 工具注册；`db_tables` 无 table → 表列表；有 table → schema Markdown
4. 真机验证：问"有哪些表"（列表模式）与"users 表的结构"（schema 模式）各一次，确认无多轮纠错
5. `npm pack --dry-run` 确认包内容正常

## 8. 任务拆分

1. **task-tables-1**：`tools/db-tools.ts` 合并（删两注册 + 新增 db_tables + db_discover description）+ `commands/switch.ts` + `formatting/schema-table.ts` + `index.ts` 注释
2. **task-tables-2**：`skills/db-explore/SKILL.md` 更新（依赖 task-tables-1 的命名确认，可并行）
3. **task-tables-3**：`README.md` / `CLAUDE.md` + 全量校验 + 冒烟（依赖前两者）
