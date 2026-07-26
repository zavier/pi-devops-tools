import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryHistoryStore } from "../history/store";

describe("QueryHistoryStore", () => {
  const testDb = join(tmpdir(), `test-history-${Date.now()}.db`);
  let store: QueryHistoryStore;

  beforeEach(() => {
    store = new QueryHistoryStore(testDb);
  });

  afterEach(() => {
    store.close();
    if (existsSync(testDb)) unlinkSync(testDb);
  });

  it("starts with empty history", () => {
    expect(store.count()).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("saves and retrieves a history entry", () => {
    const entry = store.save({
      connectionId: "mysql-dev-01",
      environment: "dev",
      database: "order_db",
      sql: "SELECT * FROM orders LIMIT 10",
      rowCount: 10,
      elapsed: "0.052s",
    });

    expect(entry.id).toBeGreaterThan(0);
    expect(entry.connectionId).toBe("mysql-dev-01");
    expect(entry.environment).toBe("dev");
    expect(entry.database).toBe("order_db");
    expect(entry.sql).toBe("SELECT * FROM orders LIMIT 10");
    expect(entry.rowCount).toBe(10);
    expect(entry.elapsed).toBe("0.052s");
    expect(entry.createdTime).toBeTruthy();

    expect(store.count()).toBe(1);
  });

  it("lists entries newest first", () => {
    store.save({
      connectionId: "mysql-dev-01",
      environment: "dev",
      database: "order_db",
      sql: "SELECT 1",
      rowCount: 1,
      elapsed: "0.001s",
    });
    store.save({
      connectionId: "mysql-dev-01",
      environment: "dev",
      database: "order_db",
      sql: "SELECT 2",
      rowCount: 1,
      elapsed: "0.001s",
    });
    store.save({
      connectionId: "mysql-dev-01",
      environment: "dev",
      database: "order_db",
      sql: "SELECT 3",
      rowCount: 1,
      elapsed: "0.001s",
    });

    const list = store.list();
    expect(list.length).toBe(3);
    // Newest first
    expect(list[0].sql).toBe("SELECT 3");
    expect(list[2].sql).toBe("SELECT 1");
  });

  it("filters by database", () => {
    store.save({
      connectionId: "conn-1",
      environment: "dev",
      database: "db_a",
      sql: "SELECT * FROM a",
      rowCount: 1,
      elapsed: "0.001s",
    });
    store.save({
      connectionId: "conn-1",
      environment: "dev",
      database: "db_b",
      sql: "SELECT * FROM b",
      rowCount: 2,
      elapsed: "0.002s",
    });

    expect(store.count({ database: "db_a" })).toBe(1);
    expect(store.list({ database: "db_a" })[0].sql).toBe("SELECT * FROM a");
  });

  it("searches by keyword", () => {
    store.save({
      connectionId: "conn-1",
      environment: "dev",
      database: "order_db",
      sql: "SELECT * FROM orders WHERE status = 'FAIL'",
      rowCount: 5,
      elapsed: "0.010s",
    });
    store.save({
      connectionId: "conn-1",
      environment: "dev",
      database: "order_db",
      sql: "SHOW TABLES",
      rowCount: 10,
      elapsed: "0.005s",
    });

    const results = store.list({ keyword: "FAIL" });
    expect(results.length).toBe(1);
    expect(results[0].sql).toContain("FAIL");
  });

  it("deletes an entry", () => {
    const entry = store.save({
      connectionId: "conn-1",
      environment: "dev",
      database: "order_db",
      sql: "DELETE ME",
      rowCount: 0,
      elapsed: "0.001s",
    });

    expect(store.delete(entry.id)).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.delete(99999)).toBe(false);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.save({
        connectionId: "conn-1",
        environment: "dev",
        database: "test",
        sql: `SELECT ${i}`,
        rowCount: i,
        elapsed: "0.001s",
      });
    }

    expect(store.list({ limit: 3 }).length).toBe(3);
    expect(store.list({ limit: 100 }).length).toBe(10);
  });
});
