# AI 数据修改工具 — 设计方案

> 允许 AI 通过 `db_mutate` 工具发起 INSERT/UPDATE/DELETE/REPLACE，但 **必须经过人工在 TUI 中确认** 后才能执行。
>
> 状态：已实施（v0.8.x）。后续演进：校验 + 人工确认已收回 facade ——
> 现为 `DatabaseWorkspaceService.executeMutationWithApproval(sql, opts, confirm)`
> 单一写入口（见 §2/§5 更新），工具层只做参数装配与结果整形。

## 目录

1. [设计目标](#1-设计目标)
2. [架构概览](#2-架构概览)
3. [SQL 策略层](#3-sql-策略层)
4. [数据库管理层](#4-数据库管理层)
5. [Facade 层](#5-facade-层)
6. [工具注册](#6-工具注册)
7. [确认 UI 组件](#7-确认-ui-组件)
8. [交互流程](#8-交互流程)
9. [文件改动清单](#9-文件改动清单)
10. [安全边界](#10-安全边界)

---

## 1. 设计目标

### 1.1 核心能力

- AI 可以发起数据修改（INSERT / UPDATE / DELETE / REPLACE）
- **绝不自动执行** — 所有写操作必须经人工在 TUI 中确认
- 确认界面清晰展示：要执行的 SQL、目标数据库、操作类型
- 确认后立即执行并返回结果给 AI
- 拒绝后告知 AI "用户拒绝了该操作"

### 1.2 安全原则

- **DDL 禁止**：不允许 CREATE / DROP / ALTER / TRUNCATE，只允许 DML 写操作
- **读操作分流**：SELECT 类仍走 `db_query`（只读 + LIMIT 注入），`db_mutate` 不接受读操作
- **WHERE 缺失警告**：UPDATE / DELETE 无 WHERE 时显示醒目警告，但不阻止执行（用户自己判断）
- **同一执行路径**：通过 `DatabaseConnectionManager` 的专用方法执行，与读查询共用连接池但走不同的策略函数

### 1.3 交互体验目标

- **一目了然**：用户能在 1 秒内看出要执行什么操作
- **明确操作**：确认键 Enter / 取消键 Esc，无歧义
- **视觉区分**：用颜色和图标区分 INSERT（绿）、UPDATE（黄）、DELETE（红）
- **不打断工作流**：确认界面是 overlay 弹窗，关闭后回到原上下文

---

## 2. 架构概览

```
LLM 调用 db_mutate(sql)
        │
        ▼
tools/db-tools.ts  ──►  ws.executeMutationWithApproval(sql, opts, confirm)
        │                     └─ confirm = (req) => showMutationConfirm(ctx, req)
        ▼
state/workspace.ts（facade —— 仪式唯一归属）
        │
        ├─ 1. prepareMutationQuery(sql)   ← connection/sql-policy.ts
        │       校验通过？ 否（DDL 等）→ 抛 MutationValidationError → isError 给 LLM
        │       是 ↓
        ├─ 2. resolveTarget(opts)
        ├─ 3. confirm({ 校验结果 + 目标 }) —— commands/mutate-confirm.ts
        │       ├─ 用户取消 → 返回 { status: "rejected" } → 非 isError 回显给 LLM
        │       └─ 用户确认 ↓
        ├─ 4. manager.executeMutation() ← connection/db-manager.ts
        │
        ▼
        返回 { status: "executed", affectedRows, elapsed, sql, connectionId, database }
```

---

## 3. SQL 策略层

### 3.1 新增 `connection/sql-policy.ts`

```typescript
/** DML statements allowed for mutation. Rejects DDL (CREATE/DROP/ALTER/TRUNCATE). */
export const MUTATION_SQL_RE = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** UPDATE/DELETE without WHERE — warn but don't block. */
const WHERE_RE = /\bWHERE\b/i;

export interface MutationValidation {
  sql: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  hasWhere: boolean;
  warning?: string;
}

/**
 * Validate that `sql` is a DML mutation statement.
 * Throws on DDL, SELECT, or unrecognized statements.
 */
export function prepareMutationQuery(sql: string): MutationValidation {
  const trimmed = sql.trim();
  if (!MUTATION_SQL_RE.test(trimmed)) {
    throw new Error(
      "仅允许 DML 写操作（INSERT、UPDATE、DELETE、REPLACE）。" +
        "DDL（CREATE/DROP/ALTER/TRUNCATE）被禁止。",
    );
  }

  const operation = trimmed.match(/^(\w+)/i)![1].toUpperCase() as MutationValidation["operation"];
  const hasWhere = WHERE_RE.test(trimmed);

  let warning: string | undefined;
  if ((operation === "UPDATE" || operation === "DELETE") && !hasWhere) {
    warning = `⚠️ ${operation} 没有 WHERE 子句 — 将影响表中所有行！`;
  }

  return { sql: trimmed, operation, hasWhere, warning };
}
```

**设计要点**：

- `MUTATION_SQL_RE` 明确区分读和写：SELECT 不在此列
- DDL 被硬性拒绝（`throw`），不会走到确认环节
- UPDATE/DELETE 无 WHERE 时给出 warning 字符串，由 UI 层决定如何展示
- 纯函数、无副作用，便于测试

---

## 4. 数据库管理层

### 4.1 新增 `connection/db-manager.ts`

```typescript
export interface MutationOutput {
  affectedRows: number;
  elapsed: string;
  sql: string;
}

/**
 * Execute a DML mutation (INSERT/UPDATE/DELETE/REPLACE).
 * No read-only guard; no LIMIT injection.
 */
async executeMutation(
  connectionId: string,
  database: string,
  sql: string,
): Promise<MutationOutput> {
  const pool = this.getPool(connectionId);
  const conn = await pool.getConnection();
  try {
    await conn.query(`USE \`${database}\``);
    const start = Date.now();
    const [result] = await conn.query(
      { sql, timeout: 30000 },
    ) as [mysql.ResultSetHeader, any];
    const elapsed = `${((Date.now() - start) / 1000).toFixed(3)}s`;
    return {
      affectedRows: result.affectedRows,
      elapsed,
      sql,
    };
  } finally {
    conn.release();
  }
}
```

**设计要点**：

- 与 `executeQuery` 相同的连接检出模式（`getConnection → USE → query → release`）
- `affectedRows` 来自 MySQL 的 `ResultSetHeader`
- 返回类型与查询不同（无 columns/rows），避免混淆

---

## 5. Facade 层

### 5.1 新增 `state/workspace.ts`

```typescript
/** 写操作确认请求：校验结果 + 解析后的目标。 */
export interface MutationApprovalRequest {
  sql: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  warning?: string;
  connectionId: string;
  database: string;
}

/** 写操作结果：用户拒绝是正常结果（rejected），非异常。 */
export type MutationOutcome =
  | { status: "rejected"; sql: string }
  | {
      status: "executed";
      affectedRows: number;
      elapsed: string;
      sql: string;
      connectionId: string;
      database: string;
    };

/** 唯一写入口——持有完整仪式：校验 → 人工确认 → 执行。 */
async executeMutationWithApproval(
  sql: string,
  opts: { connectionId?: string; database?: string },
  confirm: (req: MutationApprovalRequest) => Promise<boolean>,
): Promise<MutationOutcome> {
  const validation = prepareMutationQuery(sql); // DDL → 抛 MutationValidationError，不进入确认
  const target = this.resolveTarget(opts);

  const approved = await confirm({
    sql: validation.sql,
    operation: validation.operation,
    warning: validation.warning,
    connectionId: target.connectionId,
    database: target.database,
  });
  if (!approved) return { status: "rejected", sql: validation.sql };

  const result = await this.manager.executeMutation(
    target.connectionId,
    target.database,
    validation.sql,
  );
  return {
    status: "executed",
    ...result,
    connectionId: target.connectionId,
    database: target.database,
  };
}
```

---

## 6. 工具注册

### 6.1 新增 `tools/db-tools.ts` 中注册 `db_mutate`

```typescript
pi.registerTool({
  name: "db_mutate",
  label: "DB Mutate",
  description:
    "Execute a data mutation (INSERT/UPDATE/DELETE/REPLACE). " +
    "⚠️ REQUIRES HUMAN CONFIRMATION — a dialog will appear for the user to approve " +
    "or reject the SQL before it executes. DDL (CREATE/DROP/ALTER/TRUNCATE) is rejected. " +
    "Use this to insert, update, or delete rows — never use db_query for writes.",
  promptSnippet: "Modify data (INSERT/UPDATE/DELETE) with human approval gate",
  promptGuidelines: [
    "Use db_mutate to insert/update/delete data — db_query rejects writes.",
    "Always include a WHERE clause in UPDATE/DELETE unless the user explicitly wants to affect all rows.",
    "Explain what the mutation will do before calling db_mutate, so the user understands why the confirmation dialog appeared.",
    "For multi-statement mutations, call db_mutate once per statement; each requires separate approval.",
  ],
  parameters: Type.Object({
    sql: Type.String({
      description: "DML SQL (INSERT/UPDATE/DELETE/REPLACE). DDL rejected.",
    }),
    ...targetParams,
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    // 1. Validate
    let validation: MutationValidation;
    try {
      validation = prepareMutationQuery(params.sql);
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `SQL rejected: ${err.message}` }],
      };
    }

    // 2. Show confirmation dialog
    const ws = getWorkspace();
    const target = ws.resolveTarget({
      connectionId: params.connection,
      database: params.database,
    });

    const confirmed = await showMutationConfirm(ctx, {
      sql: validation.sql,
      operation: validation.operation,
      warning: validation.warning,
      connectionId: target.connectionId,
      database: target.database,
    });

    if (!confirmed) {
      return {
        content: [
          {
            type: "text",
            text: `Mutation rejected by user: ${validation.sql}`,
          },
        ],
        details: { rejected: true, sql: validation.sql },
      };
    }

    // 3. Execute
    try {
      const result = await ws.executeMutation(validation.sql, {
        connectionId: params.connection,
        database: params.database,
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `✅ Mutation executed successfully.`,
              `Connection: ${result.connectionId}`,
              `Database: ${result.database}`,
              `SQL: ${result.sql}`,
              `Affected rows: ${result.affectedRows} (${result.elapsed})`,
            ].join("\n"),
          },
        ],
        details: {
          sql: result.sql,
          affectedRows: result.affectedRows,
          elapsed: result.elapsed,
          connection: result.connectionId,
          database: result.database,
        },
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Mutation failed: ${err.message}` }],
        details: { sql: validation.sql, error: err.message },
      };
    }
  },
});
```

**要点**：

- `promptGuidelines` 中的 "Explain what the mutation will do before calling db_mutate" 很重要 — 确保 AI 先向用户解释，这样用户看到弹窗时已有预期
- 校验失败直接返回错误，不弹窗
- 确认 UI 通过 `ctx.ui.custom({ overlay: true })` 实现

---

## 7. 确认 UI 组件

### 7.1 文件：`commands/mutate-confirm.ts`

这是本方案的核心 — 一个清晰、友好、信息完整的确认弹窗。

#### 组件设计

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ⚠️ 数据修改确认                                  │
│                                                  │
│  操作类型：  🔴 DELETE                            │
│  目标数据库：mysql @ qa                           │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │                                          │   │
│  │  DELETE FROM users                       │   │
│  │  WHERE last_login < '2024-01-01'         │   │
│  │                                          │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ⚠️ 该操作将永久修改数据，无法撤销                  │
│                                                  │
│  Enter 确认执行    Esc 取消                       │
│                                                  │
└──────────────────────────────────────────────────┘
```

#### 颜色方案

| 操作类型 | 图标 | 标签颜色 | SQL 框边框色 |
| -------- | ---- | -------- | ------------ |
| INSERT   | 🟢   | success  | success      |
| UPDATE   | 🟡   | warning  | warning      |
| DELETE   | 🔴   | error    | error        |

#### 组件实现

```typescript
// commands/mutate-confirm.ts
import { Container, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Text, Spacer, Box } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface MutationConfirmParams {
  sql: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  warning?: string;
  connectionId: string;
  database: string;
}

const OP_STYLE: Record<string, { icon: string; color: "success" | "warning" | "error" }> = {
  INSERT: { icon: "🟢", color: "success" },
  UPDATE: { icon: "🟡", color: "warning" },
  DELETE: { icon: "🔴", color: "error" },
  REPLACE: { icon: "🟠", color: "warning" },
};

export async function showMutationConfirm(
  ctx: ExtensionContext,
  params: MutationConfirmParams,
): Promise<boolean> {
  if (ctx.mode !== "tui") {
    // Non-TUI mode (RPC/JSON/print): cannot show interactive dialog.
    // In RPC mode we could expose this via the UI protocol, but for now
    // we fall back to a simple context-based confirm.
    const ok = await ctx.ui.confirm(
      `⚠️ 数据修改确认 [${params.operation}]`,
      `即将在 ${params.connectionId}/${params.database} 执行：\n\n${params.sql}` +
        (params.warning ? `\n\n${params.warning}` : ""),
    );
    return ok;
  }

  const style = OP_STYLE[params.operation] ?? OP_STYLE.UPDATE;

  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _kb, done) => {
      const container = new Container();

      // ── Top border ──
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Spacer(0));

      // ── Title ──
      container.addChild(new Text(theme.fg("accent", theme.bold(`  ⚠️ 数据修改确认`)), 2, 0));
      container.addChild(new Spacer(0));

      // ── Meta info ──
      const opLabel = `${style.icon} ${params.operation}`;
      container.addChild(
        new Text(theme.fg("dim", `  操作类型：  `) + theme.fg(style.color, opLabel), 2, 0),
      );
      container.addChild(
        new Text(
          theme.fg("dim", `  目标数据库：`) + ` ${params.database} @ ${params.connectionId}`,
          2,
          0,
        ),
      );
      container.addChild(new Spacer(0));

      // ── SQL box ──
      // Split into lines and render each line individually
      const sqlLines = params.sql.split("\n");
      const boxPadding = 2;
      const maxSqlLen = Math.max(...sqlLines.map((l) => l.length));
      const boxInnerWidth = Math.min(maxSqlLen + boxPadding * 2, 80);

      // Top of SQL box
      const boxTop = "  ┌" + "─".repeat(boxInnerWidth) + "┐";
      container.addChild(new Text(theme.fg(style.color, boxTop), 2, 0));

      // Empty line inside box
      container.addChild(
        new Text(
          theme.fg(style.color, "  │") + " ".repeat(boxInnerWidth) + theme.fg(style.color, "│"),
          2,
          0,
        ),
      );

      // SQL content lines
      for (const line of sqlLines) {
        const trimmed = line.trim();
        const display =
          trimmed.length > boxInnerWidth - 2
            ? trimmed.slice(0, boxInnerWidth - 2 - 1) + "…"
            : trimmed.padEnd(boxInnerWidth - 2);
        container.addChild(
          new Text(
            theme.fg(style.color, "  │ ") + theme.fg("text", display) + theme.fg(style.color, " │"),
            2,
            0,
          ),
        );
      }

      // Empty line inside box
      container.addChild(
        new Text(
          theme.fg(style.color, "  │") + " ".repeat(boxInnerWidth) + theme.fg(style.color, "│"),
          2,
          0,
        ),
      );

      // Bottom of SQL box
      const boxBottom = "  └" + "─".repeat(boxInnerWidth) + "┘";
      container.addChild(new Text(theme.fg(style.color, boxBottom), 2, 0));

      container.addChild(new Spacer(0));

      // ── Warning (if any) ──
      if (params.warning) {
        container.addChild(new Text(theme.fg("warning", `  ${params.warning}`), 2, 0));
      } else {
        container.addChild(new Text(theme.fg("dim", "  ⚠️ 该操作将永久修改数据，无法撤销"), 2, 0));
      }

      container.addChild(new Spacer(0));

      // ── Footer: key hints ──
      container.addChild(
        new Text(theme.fg("accent", "  Enter 确认执行") + theme.fg("dim", "    Esc 取消"), 2, 0),
      );

      container.addChild(new Spacer(0));

      // ── Bottom border ──
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (data === "\r" || data === "\n") {
            done(true);
          } else if (data === "\x1b") {
            done(false);
          }
          // Ignore all other input
        },
      };
    },
    { overlay: true },
  );

  return result ?? false;
}
```

**设计要点**：

- **Overlay 模式**：`{ overlay: true }` 使弹窗覆盖在聊天内容上方，关闭后无缝回到原处
- **极简键盘交互**：只有两个按键 — Enter 确认、Esc 取消。任何其他按键被忽略
- **颜色编码**：操作类型用主题色区分，SQL 框边框与操作类型对应
- **SQL 展示清晰**：用 Box 风格的边框包裹 SQL，多行 SQL 按行渲染
- **WHERE 缺失警告**：来自 SQL 策略层的 warning 直接展示在最显眼位置
- **非 TUI 降级**：当 `ctx.mode !== "tui"` 时回退到 `ctx.ui.confirm()`（RPC 模式可用）

---

## 8. 交互流程

### 8.1 正常流程（用户确认）

```
用户: "帮我把 id=5 的用户状态改成 inactive"
  ↓
AI: "我将执行 UPDATE users SET status='inactive' WHERE id=5"
  ↓
AI 调用 db_mutate({ sql: "UPDATE users SET status='inactive' WHERE id=5" })
  ↓
[弹窗出现] ⚠️ 数据修改确认 — 🟡 UPDATE
  SQL: UPDATE users SET status='inactive' WHERE id=5
  目标: mysql @ qa
  ↓
用户按 Enter
  ↓
执行成功 → AI 收到: "✅ Mutation executed. Affected rows: 1"
  ↓
AI: "已成功将 id=5 的用户状态改为 inactive，影响了 1 行"
```

### 8.2 拒绝流程（用户取消）

```
AI 调用 db_mutate({ sql: "DELETE FROM logs WHERE created_at < '2024-01-01'" })
  ↓
[弹窗出现] ⚠️ 数据修改确认 — 🔴 DELETE
  ↓
用户按 Esc
  ↓
AI 收到: "Mutation rejected by user: DELETE FROM logs WHERE..."
  ↓
AI: "已取消该操作" 或提供替代方案
```

### 8.3 无 WHERE 警告流程

```
AI 调用 db_mutate({ sql: "UPDATE users SET status='inactive'" })
  ↓
[弹窗出现] ⚠️ 数据修改确认 — 🟡 UPDATE
  SQL: UPDATE users SET status='inactive'
  ⚠️ UPDATE 没有 WHERE 子句 — 将影响表中所有行！
  ↓
用户看到警告，按 Esc 取消
  ↓
AI: "你取消了操作。需要在 UPDATE 中加 WHERE 条件吗？比如只修改特定用户？"
```

### 8.4 错误流程（DDL 被拒绝）

```
AI 调用 db_mutate({ sql: "DROP TABLE users" })
  ↓
SQL 策略层抛出异常（不弹窗）
  ↓
AI 收到 isError: "仅允许 DML 写操作...DDL 被禁止。"
  ↓
AI: "无法执行 DROP TABLE。如果需要删除用户数据，可以用 DELETE FROM users。"
```

### 8.5 执行失败流程

```
AI 调用 db_mutate({ sql: "INSERT INTO users (id, name) VALUES (1, 'test')" })
  ↓
用户确认
  ↓
MySQL 返回错误（如 duplicate key）
  ↓
AI 收到 isError: "Mutation failed: Duplicate entry '1' for key 'PRIMARY'"
  ↓
AI 修复 SQL 后重试
```

---

## 9. 文件改动清单

| 文件                         | 改动类型 | 说明                                                 |
| ---------------------------- | -------- | ---------------------------------------------------- |
| `connection/sql-policy.ts`   | 追加     | 新增 `MUTATION_SQL_RE`、`prepareMutationQuery()`     |
| `connection/db-manager.ts`   | 追加     | 新增 `executeMutation()` 方法                        |
| `state/workspace.ts`         | 追加     | 新增 `executeMutation()` facade 方法                 |
| `tools/db-tools.ts`          | 追加     | 注册 `db_mutate` 工具                                |
| `commands/mutate-confirm.ts` | **新增** | `MutationConfirmDialog` 组件 + `showMutationConfirm` |
| `formatting/result-table.ts` | 不动     | —                                                    |
| `index.ts`                   | 不动     | `registerDbTools` 已包含新工具注册                   |

**改动量估算**：

- `sql-policy.ts`: +25 行
- `db-manager.ts`: +25 行
- `workspace.ts`: +20 行
- `db-tools.ts`: +100 行（新工具注册）
- `mutate-confirm.ts`: +140 行（新文件）
- **总计**: ~310 行新增，0 行删除

---

## 10. 安全边界

### 10.1 硬性阻止

| 操作类型      | 在哪里阻止             | 机制        |
| ------------- | ---------------------- | ----------- |
| SELECT        | `prepareMutationQuery` | throw Error |
| SHOW/DESCRIBE | `prepareMutationQuery` | throw Error |
| CREATE TABLE  | `prepareMutationQuery` | throw Error |
| DROP TABLE    | `prepareMutationQuery` | throw Error |
| ALTER TABLE   | `prepareMutationQuery` | throw Error |
| TRUNCATE      | `prepareMutationQuery` | throw Error |
| 所有 DDL      | `prepareMutationQuery` | throw Error |

### 10.2 软性警告

| 情况            | 机制           |
| --------------- | -------------- |
| UPDATE 无 WHERE | warning 字符串 |
| DELETE 无 WHERE | warning 字符串 |

### 10.3 不做的事

- **不提供 `--force` / 跳过确认**：永远需要人工确认，这是核心安全保证
- **不缓存用户决定**：每次 `db_mutate` 调用都弹出确认（即使相邻两次调用）
- **不估算影响行数**：v1 不做 EXPLAIN / dry-run（MySQL 的 EXPLAIN 对 DML 无实际行数估计）。未来可加
- **不支持批量多条 SQL**：一个 `db_mutate` 调用只接受一条 SQL，多条需多次调用（每次独立确认）

### 10.4 未来可扩展方向

- **事务支持**：在确认弹窗中增加 "BEGIN...COMMIT/ROLLBACK" 选项
- **Dry-run 模式**：执行前用 EXPLAIN 或 SELECT 预估影响行数
- **审计日志**：记录所有通过 `db_mutate` 执行的操作
- **权限分级**：INSERT 可配置为无需确认（低风险），而 DELETE 始终需确认
- **影响行数上限**：超过 N 行时额外警告
