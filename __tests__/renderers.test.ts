/**
 * commands/renderers.ts 的关联表格式化纯函数测试。
 */
import { describe, it, expect } from "vitest";
import { formatRelatedSummary, formatRelatedExpanded } from "../commands/renderers";
import type { RelatedTuiData } from "../commands/renderers";

/** 构造一条最小 RelatedTuiData。 */
function rel(over: Partial<RelatedTuiData>): RelatedTuiData {
  return {
    schema: "shop",
    table: "users",
    joinPath: "orders.user_id → users.id",
    rowCount: 1,
    elapsed: "0.001s",
    columns: ["id", "name"],
    rows: [{ id: "1", name: "alice" }],
    ...over,
  };
}

// ====== formatRelatedSummary ======

describe("formatRelatedSummary", () => {
  it("空数组返回空字符串", () => {
    expect(formatRelatedSummary([])).toBe("");
  });

  it("单表：表名 + 行数", () => {
    expect(formatRelatedSummary([rel({})])).toBe("📎 关联表：users（1 行）");
  });

  it("多表：逗号连接", () => {
    const related = [rel({}), rel({ table: "products", rowCount: 2 })];
    expect(formatRelatedSummary(related)).toBe("📎 关联表：users（1 行）、products（2 行）");
  });
});

// ====== formatRelatedExpanded ======

describe("formatRelatedExpanded", () => {
  it("每个表输出标题行 + 关联路径 + 表格行", () => {
    const lines = formatRelatedExpanded([rel({})], 80);
    const text = lines.join("\n");

    expect(text).toContain("📎 关联表 shop.users — 1 行（0.001s）");
    expect(text).toContain("路径：orders.user_id → users.id");
    expect(text).toContain("alice");
  });

  it("多表按顺序输出，表之间有分隔", () => {
    const related = [
      rel({}),
      rel({ table: "products", joinPath: "orders.product_id → products.id", rowCount: 2 }),
    ];
    const lines = formatRelatedExpanded(related, 80);
    const text = lines.join("\n");

    expect(text.indexOf("shop.users")).toBeLessThan(text.indexOf("shop.products"));
    expect(text).toContain("orders.product_id → products.id");
  });

  it("空结果表输出（空结果）占位", () => {
    const lines = formatRelatedExpanded([rel({ rows: [], rowCount: 0 })], 80);
    expect(lines.join("\n")).toContain("（空结果）");
  });

  it("空数组返回空行数组", () => {
    expect(formatRelatedExpanded([], 80)).toEqual([]);
  });
});
