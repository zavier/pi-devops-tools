import { describe, it, expect } from "vitest";
import {
  prepareReadOnlyQuery,
  prepareMutationQuery,
  READONLY_SQL_RE,
  MUTATION_SQL_RE,
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

  it("appends LIMIT after offset/range forms (documented limitation, see test-plan §6)", () => {
    // LIMIT 10, 5 与 LIMIT 5 OFFSET 10 都不是“尾部 LIMIT 数字”形式，
    // 会被追加默认 LIMIT → 在 MySQL 中是语法错误。分页只能写 LIMIT n。
    expect(prepareReadOnlyQuery("SELECT * FROM t LIMIT 10, 5")).toBe(
      `SELECT * FROM t LIMIT 10, 5 LIMIT ${DEFAULT_QUERY_LIMIT}`,
    );
    expect(prepareReadOnlyQuery("SELECT * FROM t LIMIT 5 OFFSET 10")).toBe(
      `SELECT * FROM t LIMIT 5 OFFSET 10 LIMIT ${DEFAULT_QUERY_LIMIT}`,
    );
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

describe("prepareMutationQuery", () => {
  it("accepts INSERT and reports operation type", () => {
    const r = prepareMutationQuery("INSERT INTO t (name) VALUES ('x')");
    expect(r.operation).toBe("INSERT");
    expect(r.hasWhere).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it("accepts UPDATE with WHERE without warning", () => {
    const r = prepareMutationQuery("UPDATE t SET a = 1 WHERE id = 1");
    expect(r.operation).toBe("UPDATE");
    expect(r.hasWhere).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("warns for UPDATE without WHERE", () => {
    const r = prepareMutationQuery("UPDATE t SET a = 1");
    expect(r.operation).toBe("UPDATE");
    expect(r.hasWhere).toBe(false);
    expect(r.warning).toMatch(/没有 WHERE/);
  });

  it("warns for DELETE without WHERE", () => {
    const r = prepareMutationQuery("DELETE FROM t");
    expect(r.operation).toBe("DELETE");
    expect(r.hasWhere).toBe(false);
    expect(r.warning).toMatch(/没有 WHERE/);
  });

  it("accepts DELETE with WHERE without warning", () => {
    const r = prepareMutationQuery("DELETE FROM t WHERE id = 1");
    expect(r.hasWhere).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("accepts REPLACE", () => {
    const r = prepareMutationQuery("REPLACE INTO t (id, v) VALUES (1, 2)");
    expect(r.operation).toBe("REPLACE");
    expect(r.warning).toBeUndefined();
  });

  it("trims surrounding whitespace and keeps the rest verbatim", () => {
    const r = prepareMutationQuery("  update t set a=1 where id=1  ");
    expect(r.sql).toBe("update t set a=1 where id=1");
    expect(r.operation).toBe("UPDATE");
  });

  it("is case-insensitive", () => {
    expect(prepareMutationQuery("insert into t values (1)").operation).toBe("INSERT");
    expect(prepareMutationQuery("delete from t where id=1").operation).toBe("DELETE");
  });

  it("rejects DDL statements", () => {
    for (const sql of [
      "CREATE TABLE t (id INT)",
      "DROP TABLE t",
      "ALTER TABLE t ADD COLUMN c INT",
      "TRUNCATE TABLE t",
    ]) {
      expect(() => prepareMutationQuery(sql)).toThrow(/DDL/);
    }
  });

  it("rejects SELECT and other non-DML statements", () => {
    for (const sql of ["SELECT 1", "SHOW TABLES", "WITH x AS (SELECT 1) SELECT * FROM x"]) {
      expect(() => prepareMutationQuery(sql)).toThrow(/DML/);
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

describe("MUTATION_SQL_RE", () => {
  it("matches DML statements case-insensitively", () => {
    expect(MUTATION_SQL_RE.test("insert into t values (1)")).toBe(true);
    expect(MUTATION_SQL_RE.test("UPDATE t SET a=1")).toBe(true);
    expect(MUTATION_SQL_RE.test("delete from t")).toBe(true);
    expect(MUTATION_SQL_RE.test("REPLACE INTO t VALUES (1)")).toBe(true);
  });

  it("requires a word boundary — rejects lookalike words", () => {
    expect(MUTATION_SQL_RE.test("INSERTER INTO t")).toBe(false);
    expect(MUTATION_SQL_RE.test("updateable")).toBe(false);
    expect(MUTATION_SQL_RE.test("deleteable")).toBe(false);
  });
});
