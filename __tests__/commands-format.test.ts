import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeRows } from "../commands/query";
import { formatRelationsList } from "../commands/relations";
import { formatFavoriteList } from "../commands/favorites";
import { formatEntry, entryToItem } from "../commands/history";
import type { FavoriteEntry, HistoryEntry } from "../history/store";
import type { SqlRow, StoredRelation } from "../types";

/** 构造一条最小 StoredRelation（formatRelationsList 测试用）。 */
function row(over: Partial<StoredRelation>): StoredRelation {
  return {
    id: 1,
    schema: "db",
    table: "t_orders",
    column: "customer_id",
    condition: "",
    refSchema: "db",
    refTable: "t_customers",
    refColumn: "id",
    relationType: "MANY_TO_ONE",
    createdTime: "2025-01-01 00:00:00",
    updatedTime: "2025-01-01 00:00:00",
    ...over,
  };
}

/** 构造一条最小 FavoriteEntry（formatFavoriteList 测试用）。 */
function fav(over: Partial<FavoriteEntry>): FavoriteEntry {
  return {
    id: 1,
    name: "最近订单",
    sql: "SELECT * FROM t_orders ORDER BY id DESC",
    database: "appdb",
    description: "",
    createdTime: "2025-01-01T00:00:00.000Z",
    updatedTime: "2025-01-01T00:00:00.000Z",
    ...over,
  };
}

// ====== sanitizeRows ======

describe("sanitizeRows", () => {
  it("converts non-null values to strings", () => {
    const rows: SqlRow[] = [{ id: 1, name: "alice", vip: true, score: 3.14 }];
    expect(sanitizeRows(rows)).toEqual([{ id: "1", name: "alice", vip: "true", score: "3.14" }]);
  });

  it("maps null and undefined to null (JSON-safe)", () => {
    // SqlValue 不含 undefined/Date——运行时的真实值由 mysql2 产出,
    // 这里用 as any 模拟边界输入。
    const rows: any[] = [{ a: null, b: undefined, c: 0 }];
    expect(sanitizeRows(rows)).toEqual([{ a: null, b: null, c: "0" }]);
  });

  it("stringifies Date values without throwing", () => {
    const d = new Date("2025-01-02T03:04:05Z");
    expect(sanitizeRows([{ t: d }] as any)).toEqual([{ t: d.toString() }]);
  });

  it("handles empty row list", () => {
    expect(sanitizeRows([])).toEqual([]);
  });
});

// ====== formatRelationsList ======

describe("formatRelationsList", () => {
  it("returns the empty placeholder", () => {
    expect(formatRelationsList([])).toBe("暂无表关联关系。");
  });

  it("renders count, direction, type and padded id", () => {
    const out = formatRelationsList([row({})]);
    expect(out).toContain("═══ 表关联关系 — 1 条 ═══");
    expect(out).toContain("db.t_orders.customer_id → db.t_customers.id (MANY_TO_ONE)");
    expect(out).toMatch(/#\s+1\s/); // id padStart(3)
  });

  it("appends condition when present", () => {
    const out = formatRelationsList([row({ condition: "is_active = 1" })]);
    expect(out).toContain("(MANY_TO_ONE) [is_active = 1]");
  });

  it("renders multiple rows", () => {
    const out = formatRelationsList([row({ id: 1 }), row({ id: 2, table: "t_items" })]);
    expect(out).toContain("— 2 条");
    expect(out).toContain("#  2");
  });
});

// ====== formatFavoriteList ======

describe("formatFavoriteList", () => {
  it("shows empty placeholder with and without current db", () => {
    expect(formatFavoriteList([])).toContain("暂无收藏。");
    expect(formatFavoriteList([], "appdb")).toContain("暂无收藏（appdb）。");
  });

  it("renders scope, entry name, db tag and sql", () => {
    const out = formatFavoriteList([fav({})], "appdb");
    expect(out).toContain("（appdb + 全局）");
    expect(out).toContain("最近订单");
    expect(out).toContain("[appdb]");
    expect(out).toContain("SELECT * FROM t_orders ORDER BY id DESC");
  });

  it("tags global favorites with a globe marker", () => {
    const out = formatFavoriteList([fav({ database: "" })]);
    expect(out).toContain("[🌐 全局]");
    expect(out).toContain("（全局）");
  });

  it("truncates long sql and appends description line", () => {
    const longSql = "SELECT * FROM " + "x".repeat(100);
    const out = formatFavoriteList([fav({ sql: longSql, description: "很长的一段说明" })]);
    expect(out).toContain("…");
    expect(out).toContain("很长的一段说明");
  });

  it("中文收藏名与中文 SQL 按显示宽度对齐（不按码元）", () => {
    // 中文名 "最近订单" 显示宽 8 列——若按码元 padEnd(18) 只补到 10 列，
    // dbTag 起点会比 ASCII 名提前 8 列，列错位。
    const out = formatFavoriteList([fav({}), fav({ id: 2, name: "orders", database: "" })]);
    const lines = out.split("\n").filter((l) => l.startsWith("  #"));
    const tagStarts = lines.map((l) => visibleWidth(l.slice(0, l.indexOf("["))));
    expect(new Set(tagStarts).size).toBe(1);
  });
});

// ====== formatEntry / entryToItem ======

describe("formatEntry / entryToItem", () => {
  const entry: HistoryEntry = {
    id: 42,
    connectionId: "main",
    environment: "prod",
    database: "appdb",
    sql: "SELECT * FROM users",
    rowCount: 100,
    elapsed: "0.010s",
    createdTime: "2025-06-01T12:34:56.000Z",
  };

  it("formats time (MM-DD HH:MM:SS), sql, row count and elapsed", () => {
    const out = formatEntry(entry, 0);
    expect(out).toContain("06-01 12:34:56");
    expect(out).toContain("SELECT * FROM users");
    expect(out).toContain("100行");
    expect(out).toContain("0.010s");
  });

  it("pads the index and truncates long sql", () => {
    const long: HistoryEntry = { ...entry, sql: "SELECT * FROM " + "y".repeat(100) };
    expect(formatEntry(long, 8)).toMatch(/^ ?9 /); // index 9 = 8+1, padStart(2)
    expect(formatEntry(long, 8)).toContain("…");
  });

  it("中文 SQL 按显示宽度截断/补齐——整行宽度与 ASCII 行一致", () => {
    const cjk: HistoryEntry = {
      ...entry,
      sql: "SELECT * FROM 产品表 WHERE 产品名称 LIKE '%智能音箱%' AND 状态='在售' ORDER BY 创建时间 DESC",
    };
    const out = formatEntry(cjk, 0);
    // SQL 列固定 52 显示列：按码元 slice/padEnd 会撑到 ~104 列，
    // 挤掉右侧的行数/耗时列（SelectList 按宽度截断后丢失）。
    expect(out).toContain("…");
    expect(out).toContain("100行");
    expect(out).toContain("0.010s");
    expect(visibleWidth(out)).toBe(visibleWidth(formatEntry(entry, 0)));
  });

  it("converts to a SelectItem keyed by id", () => {
    const item = entryToItem(entry, 3);
    expect(item.value).toBe("42");
    expect(item.description).toBe("SELECT * FROM users");
    expect(item.label).toBe(formatEntry(entry, 3));
  });
});
