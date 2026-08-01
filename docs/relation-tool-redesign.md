# 表关系工具重构方案

> 将 `db_register_relation` 重构为统一的 `db_relation` 工具（register / delete），
> 底层补齐唯一约束 + upsert，消除重复关系的可能性。

## 目录

1. [动机](#1-动机)
2. [设计目标](#2-设计目标)
3. [工具接口设计](#3-工具接口设计)
4. [存储层变更](#4-存储层变更)
5. [RelationGraph 变更](#5-relationgraph-变更)
6. [Facade 变更](#6-facade-变更)
7. [命令层变更](#7-命令层变更)
8. [数据迁移](#8-数据迁移)
9. [文件改动清单](#9-文件改动清单)

---

## 1. 动机

### 1.1 现状

| Tool                   | 操作 | 问题                        |
| ---------------------- | ---- | --------------------------- |
| `db_list_relations`    | 查询 | 正常                        |
| `db_register_relation` | 注册 | 仅支持新增，不支持修改/删除 |

Facade 层 `removeRelation(id)` 已存在但未暴露为 tool；`updateRelation` 全层缺失。

### 1.2 核心问题

- 要补齐修改和删除能力，如果按现有模式（一个操作一个 tool），会变成 4 个 tool：
  `db_list_relations` / `db_register_relation` / `db_update_relation` / `db_delete_relation`
- 上下文膨胀，且 register 和 update 参数 90% 重叠

### 1.3 设计洞察

- **update 本质是替换整条关系**：关系的核心是 `(table, column) → (refTable, refColumn)` 元组，不存在"部分修改"场景。update = delete + register
- **`id` 是实现细节**：LLM 思考关系用的是 `orders.user_id → users.id`，不是 `#5`。暴露 id 给 tool 会增加 LLM 的心智负担（需先 list 再记 id）
- **重复关系在业务上没有意义**：同一对列注册两次不会带来任何收益。当前 SQLite 没有唯一约束，但内存层（`RelationGraph.addToForward`）已经在去重——两层不一致是个隐藏 bug

---

## 2. 设计目标

1. **2 个 tool 覆盖全部 CRUD**：`db_list_relations`（查）+ `db_relation`（改）
2. **register 和 delete 使用相同的列参数**：`(table, column, refTable, refColumn)`
3. **幂等 register**：已存在的自动更新（upsert），LLM 无需先查后写
4. **唯一约束兜底**：数据库层保证不出现重复关系
5. **update = 直接 register**：LLM 不需要 delete + register 两步

---

## 3. 工具接口设计

### 3.1 `db_list_relations`（不变）

```
name: "db_list_relations"
parameters:
  table?:    string   // 可选：只查涉及此表的关系
  database?: string   // 可选：覆盖当前数据库
```

### 3.2 `db_relation`（替代 `db_register_relation`）

```typescript
pi.registerTool({
  name: "db_relation",
  label: "DB Relation",
  description:
    "Manage table relationships. " +
    "action='register': create or update a relationship (idempotent — safe to call repeatedly). " +
    "action='delete': remove a relationship by exact column match. " +
    "Use db_list_relations to browse existing relationships before modifying them.",
  promptSnippet: "Register or delete a table relationship",
  promptGuidelines: [
    "Use db_list_relations to see existing relations before registering or deleting.",
    "action='register' is idempotent — if the same relation exists, it will be updated.",
    "action='delete' removes all relations matching the exact column pair.",
    "After registering a relation, the auto-join engine can use it immediately.",
  ],
  parameters: Type.Object({
    action: StringEnum(["register", "delete"], {
      description: "register: create or update a relationship. delete: remove a relationship.",
    }),
    table: Type.String({ description: "Source table name" }),
    column: Type.String({ description: "Source column name" }),
    refTable: Type.String({ description: "Referenced table name" }),
    refColumn: Type.String({ description: "Referenced column name" }),
    relationType: Type.Optional(
      StringEnum(["MANY_TO_ONE", "ONE_TO_MANY", "ONE_TO_ONE", "MANY_TO_MANY"] as const, {
        description: "Relationship type. Default: MANY_TO_ONE. Only used for register.",
      }),
    ),
    condition: Type.Optional(
      Type.String({
        description: "Extra join condition, e.g. type=1. Only used for register.",
      }),
    ),
    database: Type.Optional(
      Type.String({
        description: "Database name. Defaults to the current database.",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const ws = ready(!!params.database);
    const schema = params.database ?? ws.current?.database;
    if (!schema) {
      return {
        isError: true,
        content: [{ type: "text", text: "No database selected. Use /db switch first." }],
      };
    }

    switch (params.action) {
      case "register": {
        const row = ws.upsertRelation(
          params.table,
          params.column,
          params.refTable,
          params.refColumn,
          {
            condition: params.condition,
            relationType: params.relationType ?? "MANY_TO_ONE",
            database: params.database,
          },
        );
        return {
          content: [
            {
              type: "text",
              text: `Relation #${row.id}: ${params.table}.${params.column} → ${params.refTable}.${params.refColumn} (${row.relation_type})`,
            },
          ],
          details: { relationId: row.id },
        };
      }
      case "delete": {
        const deleted = ws.removeRelationByColumns(
          schema,
          params.table,
          params.column,
          params.refTable,
          params.refColumn,
        );
        return {
          content: [
            {
              type: "text",
              text: deleted
                ? `Deleted relation: ${params.table}.${params.column} → ${params.refTable}.${params.refColumn}`
                : `No matching relation found: ${params.table}.${params.column} → ${params.refTable}.${params.refColumn}`,
            },
          ],
          details: { deleted },
        };
      }
    }
  },
});
```

**设计要点**：

- `action` 是唯一的 discriminator，两个 action 共享所有列参数
- `relationType` 和 `condition` 标注 "Only used for register"，LLM 在 delete 时不会传
- delete 返回是否实际删除了行，让 LLM 知道操作结果
- register 是 upsert，已存在的会被更新（`updated_time` 刷新、`relation_type` 和 `condition` 覆盖）
- 没有 `id` 参数——LLM 用列名操作，不需要记内部 ID

---

## 4. 存储层变更

### 4.1 新增唯一索引（`relation/store.ts`）

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
  ON table_relations(schema, table_name, column_name, condition,
                     ref_schema, ref_table, ref_column);
```

覆盖全部业务字段，保证同一组列对最多一条记录。

### 4.2 insert → upsert

`RelationStore.insert()` 改为 `RelationStore.upsert()`：

```typescript
upsert(rel: Omit<ColumnRelation, "id">): StoredRelation {
  const stmt = this.db.prepare(`
    INSERT INTO table_relations
      (schema, table_name, column_name, condition, ref_schema, ref_table, ref_column, relation_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(schema, table_name, column_name, condition, ref_schema, ref_table, ref_column)
    DO UPDATE SET
      relation_type = excluded.relation_type,
      updated_time  = datetime('now')
  `);
  stmt.run(
    rel.schema, rel.table, rel.column, rel.condition,
    rel.refSchema, rel.refTable, rel.refColumn, rel.relationType,
  );
  // 查询返回完整行（包括更新后的 id 和 updated_time）
  return this.findByColumns(
    rel.schema, rel.table, rel.column, rel.condition,
    rel.refSchema, rel.refTable, rel.refColumn,
  )!;
}
```

### 4.3 新增精确查找方法

```typescript
/** 按完整列对查找（配合 upsert 返回完整行）。 */
findByColumns(
  schema: string, table: string, column: string, condition: string,
  refSchema: string, refTable: string, refColumn: string,
): StoredRelation | undefined {
  const row = this.db.prepare(`
    SELECT * FROM table_relations
    WHERE schema = ? AND table_name = ? AND column_name = ? AND condition = ?
      AND ref_schema = ? AND ref_table = ? AND ref_column = ?
  `).get(schema, table, column, condition, refSchema, refTable, refColumn) as
    Record<string, any> | undefined;
  return row ? this.rowToRelation(row) : undefined;
}
```

### 4.4 新增 delete-by-columns

```typescript
/** 按列对删除。返回是否实际删除了行。 */
deleteByColumns(
  schema: string, table: string, column: string, condition: string,
  refSchema: string, refTable: string, refColumn: string,
): boolean {
  const result = this.db.prepare(`
    DELETE FROM table_relations
    WHERE schema = ? AND table_name = ? AND column_name = ? AND condition = ?
      AND ref_schema = ? AND ref_table = ? AND ref_column = ?
  `).run(schema, table, column, condition, refSchema, refTable, refColumn);
  return result.changes > 0;
}
```

---

## 5. RelationGraph 变更

### 5.1 `register` → `upsert`

```typescript
upsert(source: ColumnRef, target: ColumnRef, relationType = "MANY_TO_ONE"): StoredRelation {
  const rel: Omit<ColumnRelation, "id"> = {
    schema: source.schema,
    table: source.table,
    column: source.column,
    condition: source.condition ?? "",
    refSchema: target.schema,
    refTable: target.table,
    refColumn: target.column,
    relationType,
  };

  const row = this.store.upsert(rel);
  // 重建整个 forward 图（因为可能是更新而非新增，addToForward 的去重逻辑不够）
  this.rebuildForward();
  return row;
}
```

改为全量重建而非增量 `addToForward`：因为 upsert 可能是更新已有边的 `relationType`，而 `addToForward` 的去重逻辑会跳过已存在的 key，导致类型不更新。

### 5.2 `remove` 改用 `deleteByColumns`

现有的 `remove(source, target)` 实现是对的——用 `store.list() + find + store.delete(id)`，但改为直接调用 `store.deleteByColumns()` 更高效：

```typescript
remove(source: ColumnRef, target: ColumnRef): boolean {
  const deleted = this.store.deleteByColumns(
    source.schema, source.table, source.column, source.condition ?? "",
    target.schema, target.table, target.column,
  );
  if (deleted) this.rebuildForward();
  return deleted;
}
```

### 5.3 `removeById` 保留

Facade 旧的 `removeRelation(id)` 和命令层的关系删除交互仍通过 id 选择 → `removeById`，保留不动。

---

## 6. Facade 变更

### 6.1 `registerRelation` → `upsertRelation`

```typescript
upsertRelation(
  sourceTable: string,
  sourceColumn: string,
  refTable: string,
  refColumn: string,
  opts?: { condition?: string; relationType?: string; database?: string },
): StoredRelation {
  const schema = opts?.database ?? this.current?.database;
  if (!schema) throw new Error("No database selected");
  return this.relationGraph.upsert(
    { schema, table: sourceTable, column: sourceColumn, condition: opts?.condition || undefined },
    { schema, table: refTable, column: refColumn },
    opts?.relationType ?? "MANY_TO_ONE",
  );
}
```

### 6.2 新增 `removeRelationByColumns`

```typescript
removeRelationByColumns(
  database: string,
  sourceTable: string,
  sourceColumn: string,
  refTable: string,
  refColumn: string,
): boolean {
  return this.relationGraph.remove(
    { schema: database, table: sourceTable, column: sourceColumn },
    { schema: database, table: refTable, column: refColumn },
  );
}
```

### 6.3 `removeRelation(id)` 保留

向后兼容，命令层的交互式删除仍用这个。

---

## 7. 命令层变更

### 7.1 `/db relations add`

改用 `ws.upsertRelation()`（原 `ws.registerRelation()`）。

### 7.2 `/db relations discover` 的 AI prompt

将 prompt 中的 `db_register_relation` 改为 `db_relation`，更新参数说明：

```
对每一对确认的关系，调用 db_relation 工具保存：
  action="register", table, column, refTable, refColumn, relationType, condition
```

### 7.3 其余子命令不变

`/db relations remove` 仍通过 id 选择 → `ws.removeRelation(id)`。
`/db relations er-diagram` 已移除（候选 5：pi 不渲染 mermaid 图，命令删除；discover 的 AI 消息改为表结构文本）。

---

## 8. 数据迁移

### 8.1 潜在问题

现有数据库可能存在重复关系（无唯一约束时多次注册同一列对）。需要在新索引创建前清理。

### 8.2 迁移策略

在 `RelationStore.init()` 中，创建唯一索引前执行去重：

```typescript
// 删除重复行，保留 id 最小的那条
this.db.exec(`
  DELETE FROM table_relations
  WHERE id NOT IN (
    SELECT MIN(id) FROM table_relations
    GROUP BY schema, table_name, column_name, condition,
             ref_schema, ref_table, ref_column
  )
`);
```

这是幂等操作——如果没有重复行，DELETE 不影响任何行。

### 8.3 执行时机

`RelationStore.init()` 在扩展首次使用数据库时自动执行（lazy init），无需用户手动迁移。

---

## 9. 文件改动清单

| 文件                    | 改动类型 | 说明                                                                              |
| ----------------------- | -------- | --------------------------------------------------------------------------------- |
| `relation/store.ts`     | 修改     | 新增唯一索引、`insert`→`upsert`、新增 `findByColumns`/`deleteByColumns`、迁移去重 |
| `relation-graph.ts`     | 修改     | `register`→`upsert`（全量重建 forward）、`remove` 改用 `deleteByColumns`          |
| `state/workspace.ts`    | 修改     | `registerRelation`→`upsertRelation`、新增 `removeRelationByColumns`               |
| `tools/db-tools.ts`     | 修改     | 删除 `db_register_relation`、新增 `db_relation`                                   |
| `commands/relations.ts` | 修改     | `/db relations add` 改用 `upsertRelation`、discover prompt 更新                   |
| `index.ts`              | 修改     | 更新 tool 注册注释                                                                |
| `CLAUDE.md`             | 修改     | 更新 tool 表格和描述                                                              |
| `README.md`             | 修改     | 更新 tool 列表                                                                    |

### 改动量估算

| 模块                    | 行数                       |
| ----------------------- | -------------------------- |
| `relation/store.ts`     | +50                        |
| `relation-graph.ts`     | +10 / -10                  |
| `state/workspace.ts`    | +15 / -5                   |
| `tools/db-tools.ts`     | +80 / -60                  |
| `commands/relations.ts` | +5 / -5                    |
| 文档                    | +20 / -10                  |
| **总计**                | ~+180 / ~-90 (净增 ~90 行) |

---

## 附录 A：LLM 交互示例

### 注册新关系

```
AI 调用 db_relation({
  action: "register",
  table: "orders",
  column: "user_id",
  refTable: "users",
  refColumn: "id",
  relationType: "MANY_TO_ONE"
})
→ "Relation #42: orders.user_id → users.id (MANY_TO_ONE)"
```

### 更新已有关系（修改类型）

```
AI 调用 db_relation({
  action: "register",  // 幂等，同一个列对会被更新
  table: "orders",
  column: "user_id",
  refTable: "users",
  refColumn: "id",
  relationType: "ONE_TO_ONE"
})
→ "Relation #42: orders.user_id → users.id (ONE_TO_ONE)"
```

### 删除关系

```
AI 调用 db_relation({
  action: "delete",
  table: "orders",
  column: "user_id",
  refTable: "users",
  refColumn: "id"
})
→ "Deleted relation: orders.user_id → users.id"
```

### AI discover 工作流

```
1. db_list_relations → 查看现有关系
2. 分析表结构，发现 candidates
3. 对每个 candidate:
   a. 检查是否已存在（在步骤 1 的结果中查找）
   b. 不存在 → db_relation({ action: "register", ... })
   c. 已存在但类型/条件不同 → db_relation({ action: "register", ... }) 直接覆盖更新
4. 对过时的关系 → db_relation({ action: "delete", ... })
```

## 附录 B：与 `db_mutate` 的设计对比

|          | `db_mutate`                  | `db_relation`                       |
| -------- | ---------------------------- | ----------------------------------- |
| 操作范围 | INSERT/UPDATE/DELETE/REPLACE | register/delete                     |
| 安全门   | 人工确认弹窗                 | 无需确认（操作 state.db，非业务库） |
| 参数模型 | 自由 SQL                     | 结构化参数                          |
| 幂等性   | 取决于 SQL                   | register 幂等（upsert）             |
| 错误处理 | DDL 硬拒绝 + SQL 执行错误    | 结构化校验 + 明确错误信息           |
