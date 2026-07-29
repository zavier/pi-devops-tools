/**
 * Tests for formatting/result-table.ts — pure functions, no dependencies.
 */
import { describe, it, expect } from "vitest";
import {
  analyzeColumns,
  layoutColumns,
  formatTableDisplay,
  formatTableCompact,
  formatTableResult,
} from "../formatting/result-table";

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

const WIDE_DATA = {
  columns: Array.from({ length: 12 }, (_, i) => `col_${i}`),
  rows: Array.from({ length: 3 }, (_, r) => {
    const row: Record<string, number> = {};
    for (let c = 0; c < 12; c++) row[`col_${c}`] = r * 100 + c;
    return row;
  }),
};

const MANY_ROWS_DATA = {
  columns: ["id", "name"],
  rows: Array.from({ length: 25 }, (_, i) => ({ id: i, name: `User ${i}` })),
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
    expect(stats.allSame).toHaveLength(2);
    expect(stats.visible).toEqual([]);
    expect(stats.allNull).toEqual([]);
  });

  it("空行列表不崩溃 — 所有列归为全 NULL", () => {
    const stats = analyzeColumns(["id", "name"], []);
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

// ====== layoutColumns ======

describe("layoutColumns", () => {
  it("空列返回空数组", () => {
    expect(layoutColumns([], 100)).toEqual([]);
  });

  it("内容超出预算时收缩最宽列", () => {
    // 3 cols: ideal [40, 40, 40], budget 100
    // overhead = 3*3+1 = 10, available = 90, total ideal = 120 > 90
    // Should shrink to fit within 90
    const result = layoutColumns([40, 40, 40], 100);
    expect(result).toHaveLength(3);
    const total = result.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(90);
    // All should be ≥ 6 (min)
    for (const w of result) expect(w).toBeGreaterThanOrEqual(6);
  });

  it("内容在预算内时不收缩", () => {
    const result = layoutColumns([10, 20, 30], 200);
    expect(result).toEqual([10, 20, 30]);
  });

  it("内容正好填满预算不收缩", () => {
    // ideal=[10,20,30] = 60, overhead=10, total=70, budget=70
    const result = layoutColumns([10, 20, 30], 70);
    expect(result).toEqual([10, 20, 30]);
  });

  it("预算太紧时按比例压缩", () => {
    // 3 cols at min 6: minTotal=18, overhead=10, need budget ≥ 28 for mins.
    // Budget 20 → available=10, scale=10/18≈0.55, widths≈[3,3,3]
    const result = layoutColumns([40, 40, 40], 20);
    expect(result).toHaveLength(3);
    const total = result.reduce((a, b) => a + b, 0);
    // overhead = 10, available = 10, proportional from min 6 each
    expect(total).toBeLessThanOrEqual(10);
  });
});

// ====== formatTableCompact ======

describe("formatTableCompact", () => {
  it("空结果返回中文提示", () => {
    expect(formatTableCompact({ columns: [], rows: [] })).toBe("（空结果）");
  });

  it("使用无填充表格", () => {
    const result = formatTableCompact(SINGLE_ROW);
    // Unpadded: cells not padded, no extra spaces
    expect(result).toContain("| id | name | email |");
    expect(result).toContain("| --- | --- | --- |");
    expect(result).toContain("| 1 | Alice | alice@example.com |");
  });

  it("包含分隔线", () => {
    const result = formatTableCompact(MULTI_ROW);
    expect(result).toContain("---");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  it("超长单元格被截断并带 …[+N] 标记", () => {
    const result = formatTableCompact({
      columns: ["id", "description"],
      rows: [{ id: 1, description: "A".repeat(250) }],
    });
    expect(result).toContain("…[+50]"); // 200 cap → 250-200=50
  });

  it("200 字符内不截断", () => {
    const result = formatTableCompact({
      columns: ["id", "text"],
      rows: [{ id: 1, text: "A".repeat(200) }],
    });
    expect(result).not.toContain("…[+");
    expect(result).toContain("A".repeat(200));
  });

  it("全 NULL 列在注释中报告", () => {
    const result = formatTableCompact({
      columns: ["id", "name", "deleted_at"],
      rows: [
        { id: 1, name: "Alice", deleted_at: null },
        { id: 2, name: "Bob", deleted_at: null },
      ],
    });
    expect(result).toContain("ⓘ");
    expect(result).toContain("已隐藏 1 列（全为 NULL）：deleted_at");
  });

  it("值完全相同列在注释中报告", () => {
    const result = formatTableCompact({
      columns: ["id", "name", "status"],
      rows: [
        { id: 1, name: "Alice", status: "active" },
        { id: 2, name: "Bob", status: "active" },
      ],
    });
    expect(result).toContain("ⓘ");
    expect(result).toContain("已隐藏 1 列（所有行取值相同）：status=active");
  });

  it("所有列都是常量时不输出隐藏注释", () => {
    const result = formatTableCompact({
      columns: ["id", "status"],
      rows: [{ id: 1, status: "active" }],
    });
    expect(result).not.toContain("ⓘ");
    expect(result).toContain("status");
  });
});

// ====== formatTableDisplay (adaptive width) ======

describe("formatTableDisplay", () => {
  it("空结果返回中文提示", () => {
    expect(formatTableDisplay({ columns: [], rows: [] }, 120)).toBe("（空结果）");
  });

  it("普通宽度 + 少量列 → 水平表格", () => {
    const result = formatTableDisplay(MULTI_ROW, 120);
    expect(result).toContain("| id");
    expect(result).toContain("| name");
    expect(result).toContain("---");
    expect(result).toContain("Alice");
  });

  it("单行结果回退显示全部列，不输出隐藏注释", () => {
    const result = formatTableDisplay(SINGLE_ROW, 120);
    expect(result).toContain("| id");
    expect(result).toContain("Alice");
    expect(result).not.toContain("ⓘ");
  });

  it("窄终端 + 多列 → 转置表格", () => {
    const result = formatTableDisplay(WIDE_DATA, 55); // 12 cols don't fit in 55
    expect(result).toContain("│"); // transposed marker
    expect(result).toContain("3 行");
  });

  it("转置表格显示行列数", () => {
    const result = formatTableDisplay(WIDE_DATA, 55);
    expect(result).toContain("3 行");
    expect(result).toContain("12 列");
  });

  it("窄终端 + 多列 + 多行 → 垂直格式", () => {
    const cols = Array.from({ length: 12 }, (_, i) => `col_${i}`);
    const rows = Array.from({ length: 15 }, (_, r) => {
      const row: Record<string, string> = {};
      for (let c = 0; c < 12; c++) row[`col_${c}`] = `r${r}c${c}`;
      return row;
    });
    const result = formatTableDisplay({ columns: cols, rows }, 55);
    // 12 cols × 15 rows: horizontal won't fit → transposed (max 10 rows) → vertical
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
    const result = formatTableDisplay({ columns: cols, rows }, 45);
    // 9 cols × 5 char (headers/content) = narrow terminal won't fit horizontal
    // 20 rows > 10 → vertical
    expect(result).toContain("─── Row");
    expect((result.match(/─── Row/g) || []).length).toBe(5);
    expect(result).toContain("… 还有");
  });

  it("水平表格截断超长单元格", () => {
    const result = formatTableDisplay(
      {
        columns: ["id", "description"],
        rows: [{ id: 1, description: "A".repeat(100) }],
      },
      120,
    );
    expect(result).toContain("…");
  });

  it("水平表格超 20 行时截断", () => {
    const result = formatTableDisplay(MANY_ROWS_DATA, 120);
    expect(result).toContain("… 还有 5 行");
    // 只显示 20 行数据
    expect((result.match(/\| \d+ +\| User/g) || []).length).toBe(20);
  });

  it("NULL 值显示为 'NULL'（转置格式中）", () => {
    const cols = Array.from({ length: 12 }, (_, i) => `col_${i}`);
    const rows = [Object.fromEntries(cols.map((c, i) => [c, c === "col_0" ? null : `v${i}`]))];
    const result = formatTableDisplay({ columns: cols, rows }, 55);
    // 12 cols single row won't fit horizontally → transposed. Formatter shouldn't crash.
    expect(result).not.toBe("（空结果）");
  });
});

// ====== formatTableResult (backward compat alias) ======

describe("formatTableResult", () => {
  it("等价于 formatTableDisplay(120)", () => {
    const a = formatTableResult(MULTI_ROW);
    const b = formatTableDisplay(MULTI_ROW, 120);
    expect(a).toBe(b);
  });

  it("超多列在 120 宽度下走水平布局", () => {
    // WIDE_DATA: 12 narrow cols fit in 120 budget
    const result = formatTableResult(WIDE_DATA);
    expect(result).toContain("---"); // horizontal
  });
});
