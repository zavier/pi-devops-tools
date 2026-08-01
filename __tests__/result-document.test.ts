/**
 * formatting/result-document.ts 的文档装配纯函数测试。
 */
import { describe, it, expect } from "vitest";
import { renderQueryDocument } from "../formatting/result-document";
import type { QueryResultDoc } from "../formatting/result-document";
import type { RelatedResult } from "../types";

function doc(over: Partial<QueryResultDoc> = {}): QueryResultDoc {
  return {
    database: "shop",
    sql: "SELECT * FROM users",
    rowCount: 2,
    elapsed: "0.010s",
    columns: ["id", "name"],
    rows: [
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ],
    ...over,
  };
}

function rel(over: Partial<RelatedResult> = {}): RelatedResult {
  return {
    schema: "shop",
    table: "orders",
    joinPath: "users.id → orders.user_id",
    rowCount: 1,
    elapsed: "0.001s",
    columns: ["id", "total"],
    rows: [{ id: 1, total: 100 }],
    ...over,
  };
}

/** 只取文本，忽略颜色提示。 */
function textOf(lines: ReturnType<typeof renderQueryDocument>): string {
  return lines.map((l) => l.text).join("\n");
}

// ====== llm-zh ======

describe("renderQueryDocument (llm-zh)", () => {
  it("信封：标题 + 元数据 + 表格", () => {
    const text = textOf(renderQueryDocument(doc(), { audience: "llm-zh" }));

    expect(text).toContain("## 数据库查询结果");
    expect(text).toContain("**数据库**：shop");
    expect(text).toContain("**SQL**：SELECT * FROM users");
    expect(text).toContain("**行数**：2（0.010s）");
    expect(text).toContain("| id | name |");
    expect(text).toContain("alice");
  });

  it("connectionId 存在时输出连接行，位于数据库行之前", () => {
    const lines = renderQueryDocument(doc({ connectionId: "main" }), { audience: "llm-zh" });
    const text = textOf(lines);

    expect(text).toContain("**连接**：main");
    expect(text.indexOf("**连接**")).toBeLessThan(text.indexOf("**数据库**"));
  });

  it("空结果输出（空结果）占位", () => {
    const text = textOf(
      renderQueryDocument(doc({ rowCount: 0, rows: [] }), { audience: "llm-zh" }),
    );

    expect(text).toContain("（空结果）");
  });

  it("related 节：每表标题 + 路径 + 行数 + 表格", () => {
    const text = textOf(renderQueryDocument(doc({ related: [rel({})] }), { audience: "llm-zh" }));

    expect(text).toContain("### 关联表（1 个）");
    expect(text).toContain("### shop.orders");
    expect(text).toContain("关联路径：users.id → orders.user_id");
    expect(text).toContain("行数：1（0.001s）");
    expect(text).toContain("| id | total |");
  });

  it("related 空结果表输出（空结果）占位", () => {
    const text = textOf(
      renderQueryDocument(doc({ related: [rel({ rows: [], rowCount: 0 })] }), {
        audience: "llm-zh",
      }),
    );

    expect(text).toContain("（空结果）");
  });

  it("related 多表按顺序输出", () => {
    const text = textOf(
      renderQueryDocument(
        doc({
          related: [
            rel({ table: "t1", rows: [], rowCount: 0 }),
            rel({ table: "t2", rows: [], rowCount: 0 }),
          ],
        }),
        { audience: "llm-zh" },
      ),
    );

    expect(text.indexOf("### shop.t1")).toBeLessThan(text.indexOf("### shop.t2"));
  });
});

// ====== tui-zh ======

describe("renderQueryDocument (tui-zh)", () => {
  it("折叠态：标题行带 accent、SQL 行带 muted、表格行", () => {
    const lines = renderQueryDocument(doc(), { audience: "tui-zh", width: 80 });

    expect(lines[0]).toEqual({
      text: "🗄 查询 — shop  2 行 (0.010s)",
      style: "accent",
    });
    expect(lines[1]).toEqual({ text: "SQL: SELECT * FROM users", style: "muted" });
    expect(textOf(lines)).toContain("alice");
  });

  it("折叠态：行数超过 20 输出展开提示行（hint: expand-rows）", () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: i, name: `u${i}` }));
    const lines = renderQueryDocument(doc({ rowCount: 21, rows }), {
      audience: "tui-zh",
      width: 80,
    });

    expect(lines.some((l) => l.hint === "expand-rows")).toBe(true);
  });

  it("展开态：全部行纵向 + 关联表节标题", () => {
    const lines = renderQueryDocument(doc({ related: [rel({})] }), {
      audience: "tui-zh",
      width: 80,
      expanded: true,
    });
    const text = textOf(lines);

    expect(text).toContain("📎 关联表（1 个）");
    expect(text).toContain("── 📎 关联表 shop.orders — 1 行（0.001s）──");
    expect(text).toContain("路径：users.id → orders.user_id");
    expect(text).toContain("alice");
  });

  it("展开态：related 空结果表输出（空结果）占位", () => {
    const lines = renderQueryDocument(doc({ related: [rel({ rows: [], rowCount: 0 })] }), {
      audience: "tui-zh",
      width: 80,
      expanded: true,
    });

    expect(textOf(lines)).toContain("（空结果）");
  });

  it("折叠态：related 输出摘要行与展开提示（hint: expand-related）", () => {
    const lines = renderQueryDocument(doc({ related: [rel({})] }), {
      audience: "tui-zh",
      width: 80,
    });
    const text = textOf(lines);

    expect(text).toContain("📎 关联表：orders（1 行）");
    expect(lines.some((l) => l.hint === "expand-related")).toBe(true);
  });

  it("折叠态：多表摘要逗号连接", () => {
    const lines = renderQueryDocument(
      doc({ related: [rel({}), rel({ table: "products", rowCount: 2 })] }),
      { audience: "tui-zh", width: 80 },
    );

    expect(textOf(lines)).toContain("📎 关联表：orders（1 行）、products（2 行）");
  });

  it("空结果输出（空结果）占位", () => {
    const text = textOf(
      renderQueryDocument(doc({ rowCount: 0, rows: [] }), { audience: "tui-zh", width: 80 }),
    );

    expect(text).toContain("（空结果）");
  });
});
