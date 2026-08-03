import { describe, it, expect, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderQueryResult, type QueryResultEntryData } from "../commands/renderers";

/** keyHint 依赖全局 theme——测试环境需先初始化（pi 运行时已初始化）。 */
beforeAll(() => {
  initTheme("dark");
});

/** 透传颜色标记的 fake theme——断言只看文本与宽度。 */
const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function entry(over: Partial<QueryResultEntryData>): QueryResultEntryData {
  return {
    database: "test_db",
    sql: "SELECT 1",
    rowCount: 1,
    elapsed: "3ms",
    columns: ["id"],
    rows: [{ id: "1" }],
    related: [],
    ...over,
  };
}

/** 断言所有渲染行可见宽度不超过 width。 */
function expectAllLinesWithin(lines: string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line), `超宽行：${line.slice(0, 60)}…`).toBeLessThanOrEqual(width);
  }
}

// ====== renderQueryResult（/db query 的 TUI 条目渲染）======

describe("renderQueryResult 宽度防线", () => {
  const WIDTH = 120;

  it("长 SQL 行被截断到渲染宽度（回归：TUI 宽度断言崩溃）", () => {
    const sql = "SELECT * FROM t WHERE a = 1 AND b = " + "x".repeat(200);
    const lines = renderQueryResult(entry({ sql }), WIDTH, false, fakeTheme);
    expectAllLinesWithin(lines, WIDTH);
    expect(lines.some((l) => l.includes("SQL: SELECT"))).toBe(true);
  });

  it("折叠态中文单元格表格行不超过渲染宽度", () => {
    const lines = renderQueryResult(
      entry({
        columns: ["id", "description"],
        rows: [{ id: "1", description: "产品".repeat(60) }],
      }),
      WIDTH,
      false,
      fakeTheme,
    );
    expectAllLinesWithin(lines, WIDTH);
  });

  it("展开态长值（ASCII）行不超过渲染宽度", () => {
    const lines = renderQueryResult(
      entry({
        columns: ["id", "payload"],
        rows: [{ id: "1", payload: "A".repeat(300) }],
      }),
      WIDTH,
      true,
      fakeTheme,
    );
    expectAllLinesWithin(lines, WIDTH);
  });

  it("展开态长值（中文）行不超过渲染宽度", () => {
    const lines = renderQueryResult(
      entry({
        columns: ["id", "payload"],
        rows: [{ id: "1", payload: "中".repeat(200) }],
      }),
      WIDTH,
      true,
      fakeTheme,
    );
    expectAllLinesWithin(lines, WIDTH);
  });

  it("折叠态关联表摘要（长表名）行不超过渲染宽度", () => {
    const related = Array.from({ length: 8 }, (_, i) => ({
      schema: "db",
      table: `order_items_2024_${i}_snapshot`,
      joinPath: "",
      rowCount: 1,
      elapsed: "1ms",
      columns: ["id"],
      rows: [{ id: "1" }],
    }));
    const lines = renderQueryResult(entry({ related }), WIDTH, false, fakeTheme);
    expectAllLinesWithin(lines, WIDTH);
  });

  it("展开态关联表节（长表名标题）行不超过渲染宽度", () => {
    const related = Array.from({ length: 8 }, (_, i) => ({
      schema: "db",
      table: `order_items_2024_${i}_snapshot`,
      joinPath: "",
      rowCount: 1,
      elapsed: "1ms",
      columns: ["id"],
      rows: [{ id: "1" }],
    }));
    const lines = renderQueryResult(entry({ related }), WIDTH, true, fakeTheme);
    expectAllLinesWithin(lines, WIDTH);
  });

  it("短内容保持原样不被截断", () => {
    const lines = renderQueryResult(entry({}), 120, false, fakeTheme);
    expect(lines.some((l) => l.includes("SELECT 1"))).toBe(true);
    expect(lines.some((l) => l.includes("1 行"))).toBe(true);
  });
});
