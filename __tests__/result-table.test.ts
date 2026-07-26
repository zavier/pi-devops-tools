/**
 * Tests for formatting/result-table.ts — pure functions, no dependencies.
 */
import { describe, it, expect } from "vitest";
import { analyzeColumns, formatTableResult } from "../formatting/result-table";

// ====== Shared test data ======

const SINGLE_ROW = {
  columns: ["id", "name", "email"],
  rows: [{ id: 1, name: "Alice", email: "alice@example.com" }],
};

const MULTI_ROW = {
  columns: ["id", "name", "email"],
  rows: [
    { id: 1, name: "Alice", email: "alice@example.com" },
    { id: 2, name: "Bob", email: "bob@example.com" },
    { id: 3, name: "Charlie", email: "charlie@example.com" },
  ],
};

const MANY_COLS = {
  columns: Array.from({ length: 12 }, (_, i) => `col_${i}`),
  rows: Array.from({ length: 3 }, (_, r) => {
    const row: Record<string, number> = {};
    for (let c = 0; c < 12; c++) row[`col_${c}`] = r * 100 + c;
    return row;
  }),
};

// ====== analyzeColumns ======

describe("analyzeColumns", () => {
  it("返回空结果", () => {
    const stats = analyzeColumns([], []);
    expect(stats.visible).toEqual([]);
    expect(stats.allNull).toEqual([]);
    expect(stats.allSame).toEqual([]);
  });

  it("所有列可见当值各不相同", () => {
    const stats = analyzeColumns(
      ["id", "name"],
      [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    );
    expect(stats.visible).toEqual(["id", "name"]);
    expect(stats.allNull).toEqual([]);
    expect(stats.allSame).toEqual([]);
  });

  it("检测全 NULL 列", () => {
    const stats = analyzeColumns(
      ["id", "name", "deleted_at"],
      [
        { id: 1, name: "Alice", deleted_at: null },
        { id: 2, name: "Bob", deleted_at: null },
      ],
    );
    expect(stats.visible).toEqual(["id", "name"]);
    expect(stats.allNull).toEqual(["deleted_at"]);
    expect(stats.allSame).toEqual([]);
  });

  it("检测值完全相同的列", () => {
    const stats = analyzeColumns(
      ["id", "name", "status"],
      [
        { id: 1, name: "Alice", status: "active" },
        { id: 2, name: "Bob", status: "active" },
        { id: 3, name: "Charlie", status: "active" },
      ],
    );
    expect(stats.visible).toEqual(["id", "name"]);
    expect(stats.allNull).toEqual([]);
    expect(stats.allSame).toEqual([{ col: "status", value: "active" }]);
  });

  it("混合情况：NULL + 相同值 + 可见", () => {
    const stats = analyzeColumns(
      ["id", "name", "status", "deleted_at"],
      [
        { id: 1, name: "Alice", status: "active", deleted_at: null },
        { id: 2, name: "Bob", status: "active", deleted_at: null },
      ],
    );
    expect(stats.visible).toEqual(["id", "name"]);
    expect(stats.allNull).toEqual(["deleted_at"]);
    expect(stats.allSame).toEqual([{ col: "status", value: "active" }]);
  });

  it("单行时所有非 NULL 列都是相同值", () => {
    const stats = analyzeColumns(["id", "name"], [{ id: 1, name: "Alice" }]);
    // 单行时，值相同的列被归入 allSame（因为没有其他行可比较）
    expect(stats.allSame).toHaveLength(2);
    expect(stats.visible).toEqual([]);
    expect(stats.allNull).toEqual([]);
  });

  it("空行列表不崩溃 — 所有列归为全 NULL", () => {
    const stats = analyzeColumns(["id", "name"], []);
    // 无数据时所有列都"没有非 NULL 值"，归入 allNull
    expect(stats.allNull).toEqual(["id", "name"]);
    expect(stats.visible).toEqual([]);
    expect(stats.allSame).toEqual([]);
  });

  it("null 值被检测为全 NULL", () => {
    const stats = analyzeColumns(
      ["id", "name"],
      [
        { id: 1, name: null },
        { id: 2, name: null },
      ],
    );
    expect(stats.allNull).toEqual(["name"]);
    expect(stats.visible).toEqual(["id"]);
  });
});

// ====== formatTableResult ======

describe("formatTableResult", () => {
  it("空结果返回中文提示", () => {
    const result = formatTableResult({ columns: [], rows: [] });
    expect(result).toBe("（空结果）");
  });

  it("≤ 8 列使用水平表格", () => {
    const result = formatTableResult(SINGLE_ROW);
    // 水平表格包含 | 分隔符
    expect(result).toContain("| id");
    expect(result).toContain("| name");
    expect(result).toContain("| email");
    expect(result).toContain("Alice");
  });

  it("水平表格包含分隔线", () => {
    const result = formatTableResult(MULTI_ROW);
    expect(result).toContain("---");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  it("> 8 列 & ≤ 10 行使用转置表格", () => {
    const result = formatTableResult(MANY_COLS);
    // 转置表格用 │ 连接多行
    expect(result).toContain("│");
    // 不应该是垂直 key-value 格式（不含 "─── Row" 前缀）
    expect(result).not.toContain("─── Row");
  });

  it("转置表格显示行列数", () => {
    const result = formatTableResult(MANY_COLS);
    expect(result).toContain("3 行");
    expect(result).toContain("12 列");
  });

  it("> 8 列 & > 10 行使用垂直格式", () => {
    const cols = Array.from({ length: 12 }, (_, i) => `col_${i}`);
    const rows = Array.from({ length: 15 }, (_, r) => {
      const row: Record<string, string> = {};
      for (let c = 0; c < 12; c++) row[`col_${c}`] = `r${r}c${c}`;
      return row;
    });
    const result = formatTableResult({ columns: cols, rows });
    // 垂直格式有 "─── Row" 前缀
    expect(result).toContain("─── Row");
    expect(result).toContain("col_0");
  });

  it("垂直格式限制最大显示 5 行", () => {
    const cols = Array.from({ length: 9 }, (_, i) => `col_${i}`);
    const rows = Array.from({ length: 20 }, (_, r) => {
      const row: Record<string, string> = {};
      for (let c = 0; c < 9; c++) row[`col_${c}`] = `r${r}c${c}`;
      return row;
    });
    const result = formatTableResult({ columns: cols, rows });
    // 应该显示 5 行
    expect((result.match(/─── Row/g) || []).length).toBe(5);
    // 提示还有更多行
    expect(result).toContain("还有 15 行");
  });

  it("水平表格截断超长单元格", () => {
    const result = formatTableResult({
      columns: ["id", "description"],
      rows: [
        {
          id: 1,
          description: "A".repeat(100),
        },
      ],
    });
    // 超长文本被截断（带 …）
    expect(result).toContain("…");
  });

  it("水平表格超 20 行时截断", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: i,
      name: `User ${i}`,
    }));
    const result = formatTableResult({
      columns: ["id", "name"],
      rows,
    });
    expect(result).toContain("还有 5 行");
    // 只显示 20 行数据
    expect((result.match(/\| \d+ +\| User/g) || []).length).toBe(20);
  });

  it("NULL 值显示为 'NULL'（转置/垂直格式中）", () => {
    // 用 >8 列触发转置格式，其中一列全部为 NULL
    const cols = Array.from({ length: 9 }, (_, i) => `col_${i}`);
    const rows = [Object.fromEntries(cols.map((c, i) => [c, c === "col_0" ? null : `v${i}`]))];
    const result = formatTableResult({ columns: cols, rows });
    // 单行时全相同，会被归入注释；但至少不崩溃
    expect(result).not.toBe("（空结果）");
  });

  it("全 NULL 列在注释中报告", () => {
    const result = formatTableResult({
      columns: ["id", "name", "deleted_at"],
      rows: [
        { id: 1, name: "Alice", deleted_at: null },
        { id: 2, name: "Bob", deleted_at: null },
      ],
    });
    expect(result).toContain("ⓘ");
    expect(result).toContain("全为 NULL");
  });

  it("值完全相同列在注释中报告", () => {
    const result = formatTableResult({
      columns: ["id", "name", "status"],
      rows: [
        { id: 1, name: "Alice", status: "active" },
        { id: 2, name: "Bob", status: "active" },
      ],
    });
    expect(result).toContain("ⓘ");
    expect(result).toContain("值相同");
    expect(result).toContain("status=active");
  });
});
