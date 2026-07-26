import { describe, it, expect } from "vitest";
import {
  prepareReadOnlyQuery,
  READONLY_SQL_RE,
  DEFAULT_QUERY_LIMIT,
} from "../connection/sql-policy";

describe("prepareReadOnlyQuery", () => {
  it("appends the default LIMIT to an unbounded SELECT", () => {
    expect(prepareReadOnlyQuery("SELECT * FROM users")).toBe(
      `SELECT * FROM users LIMIT ${DEFAULT_QUERY_LIMIT}`,
    );
  });

  it("appends a custom limit", () => {
    expect(prepareReadOnlyQuery("SELECT * FROM users", 50)).toBe("SELECT * FROM users LIMIT 50");
  });

  it("trims surrounding whitespace", () => {
    expect(prepareReadOnlyQuery("  select * from t  ")).toBe(
      `select * from t LIMIT ${DEFAULT_QUERY_LIMIT}`,
    );
  });

  it("leaves a trailing LIMIT untouched", () => {
    expect(prepareReadOnlyQuery("SELECT * FROM t LIMIT 10")).toBe("SELECT * FROM t LIMIT 10");
  });

  it("leaves a trailing LIMIT with semicolon untouched", () => {
    expect(prepareReadOnlyQuery("select * from t limit 10;")).toBe("select * from t limit 10;");
  });

  it("appends an outer LIMIT when LIMIT only appears inside a subquery", () => {
    const sql = "SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5)";
    expect(prepareReadOnlyQuery(sql)).toBe(`${sql} LIMIT ${DEFAULT_QUERY_LIMIT}`);
  });

  it("strips trailing semicolons before appending", () => {
    expect(prepareReadOnlyQuery("SELECT 1;")).toBe(`SELECT 1 LIMIT ${DEFAULT_QUERY_LIMIT}`);
  });

  it("passes SHOW through untouched", () => {
    expect(prepareReadOnlyQuery("SHOW TABLES")).toBe("SHOW TABLES");
  });

  it("passes DESCRIBE through untouched", () => {
    expect(prepareReadOnlyQuery("DESCRIBE users")).toBe("DESCRIBE users");
  });

  it("passes EXPLAIN through untouched", () => {
    expect(prepareReadOnlyQuery("EXPLAIN SELECT * FROM t")).toBe("EXPLAIN SELECT * FROM t");
  });

  it("does not append LIMIT after FOR UPDATE (syntax error)", () => {
    expect(prepareReadOnlyQuery("SELECT * FROM t FOR UPDATE")).toBe("SELECT * FROM t FOR UPDATE");
    expect(prepareReadOnlyQuery("SELECT * FROM t FOR UPDATE;")).toBe("SELECT * FROM t FOR UPDATE;");
  });

  it("throws on non-read-only statements", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "WITH x AS (SELECT 1) SELECT * FROM x",
    ]) {
      expect(() => prepareReadOnlyQuery(sql)).toThrow(/只读/);
    }
  });
});

describe("READONLY_SQL_RE", () => {
  it("matches case-insensitively", () => {
    expect(READONLY_SQL_RE.test("select 1")).toBe(true);
    expect(READONLY_SQL_RE.test("Show Tables")).toBe(true);
  });

  it("requires a word boundary", () => {
    expect(READONLY_SQL_RE.test("SELECTOR")).toBe(false);
    expect(READONLY_SQL_RE.test("showcase")).toBe(false);
  });
});
