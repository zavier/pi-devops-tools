import { describe, it, expect } from "vitest";
import { summarizeDbToolResult } from "../tools/tool-result-summary";

describe("summarizeDbToolResult", () => {
  describe("db_query", () => {
    it("生成行数摘要", () => {
      expect(
        summarizeDbToolResult("db_query", {
          connection: "local",
          database: "test_db",
          rowCount: 42,
          elapsed: "8ms",
        }),
      ).toBe("db_query：42 行 · 8ms（local/test_db）");
    });

    it("rowCount 缺失时返回 undefined", () => {
      expect(
        summarizeDbToolResult("db_query", {
          connection: "local",
          database: "test_db",
          elapsed: "8ms",
        }),
      ).toBeUndefined();
    });
  });

  describe("db_tables", () => {
    it("列表模式：表数量", () => {
      expect(
        summarizeDbToolResult("db_tables", {
          connection: "local",
          database: "test_db",
          tables: ["users", "orders", "items"],
        }),
      ).toBe("db_tables：test_db 表列表（3 个）");
    });

    it("schema 模式：列数与索引数", () => {
      expect(
        summarizeDbToolResult("db_tables", {
          connection: "local",
          database: "test_db",
          table: "users",
          columnCount: 5,
          indexCount: 2,
        }),
      ).toBe("db_tables：test_db.users 结构（5 列 / 2 索引）");
    });

    it("schema 模式缺少计数时返回 undefined", () => {
      expect(
        summarizeDbToolResult("db_tables", {
          connection: "local",
          database: "test_db",
          table: "users",
        }),
      ).toBeUndefined();
    });

    it("列表模式缺少 tables 时返回 undefined", () => {
      expect(
        summarizeDbToolResult("db_tables", {
          connection: "local",
          database: "test_db",
          table: undefined,
        }),
      ).toBeUndefined();
    });
  });

  describe("db_discover", () => {
    it("只列连接", () => {
      expect(
        summarizeDbToolResult("db_discover", {
          connections: ["local", "staging"],
          connection: undefined,
        }),
      ).toBe("db_discover：2 个连接");
    });

    it("连接 + 目标库数量", () => {
      expect(
        summarizeDbToolResult("db_discover", {
          connections: ["local", "staging"],
          connection: "local",
          databaseCount: 7,
        }),
      ).toBe("db_discover：2 个连接 · 7 个数据库");
    });

    it("connections 缺失时返回 undefined", () => {
      expect(summarizeDbToolResult("db_discover", { connection: "local" })).toBeUndefined();
    });
  });

  describe("db_tools loader", () => {
    it("有新增工具时显示已启用列表", () => {
      expect(
        summarizeDbToolResult("db_tools", {
          matches: ["db_discover", "db_list_relations"],
          added: ["db_discover", "db_list_relations"],
        }),
      ).toBe("db_tools：已启用 db_discover、db_list_relations");
    });

    it("无新增时显示已激活列表", () => {
      expect(
        summarizeDbToolResult("db_tools", {
          matches: ["db_discover"],
          added: [],
        }),
      ).toBe("db_tools：已激活 db_discover");
    });

    it("无匹配时给出提示", () => {
      expect(summarizeDbToolResult("db_tools", { matches: [], added: [] })).toBe(
        "db_tools：无匹配工具",
      );
    });

    it("缺少数组字段时返回 undefined", () => {
      expect(summarizeDbToolResult("db_tools", { added: [] })).toBeUndefined();
    });
  });

  it("未知工具名返回 undefined", () => {
    expect(summarizeDbToolResult("db_mutate", { sql: "UPDATE t SET x=1" })).toBeUndefined();
  });

  it("非对象 details 返回 undefined", () => {
    expect(summarizeDbToolResult("db_query", undefined)).toBeUndefined();
    expect(summarizeDbToolResult("db_query", "text")).toBeUndefined();
  });
});
