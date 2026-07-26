import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { QueryHistoryStore } from "../history/store";

describe("QueryHistoryStore", () => {
  const db = new Database(":memory:");
  let store: QueryHistoryStore;

  beforeEach(() => {
    store = new QueryHistoryStore(db);
  });

  afterEach(() => {
    // Clean rows between tests — SQLite :memory: keeps the schema
    db.exec("DELETE FROM query_history");
  });

  it("saves and retrieves a history entry", () => {
    const entry = store.save({
      connectionId: "conn-1",
      environment: "prod",
      database: "app_db",
      sql: "SELECT * FROM users",
      rowCount: 42,
      elapsed: "0.123s",
    });

    expect(entry.id).toBeGreaterThan(0);
    expect(entry.database).toBe("app_db");
    expect(entry.sql).toBe("SELECT * FROM users");

    const retrieved = store.getById(entry.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.rowCount).toBe(42);
  });

  it("lists entries newest first", () => {
    store.save({
      connectionId: "c",
      environment: "e",
      database: "d",
      sql: "SELECT 1",
      rowCount: 1,
      elapsed: "",
    });
    store.save({
      connectionId: "c",
      environment: "e",
      database: "d",
      sql: "SELECT 2",
      rowCount: 2,
      elapsed: "",
    });

    const entries = store.list({ limit: 10 });
    expect(entries.length).toBe(2);
    expect(entries[0].sql).toBe("SELECT 2");
  });

  it("filters by database", () => {
    store.save({
      connectionId: "c",
      environment: "e",
      database: "a",
      sql: "x",
      rowCount: 0,
      elapsed: "",
    });
    store.save({
      connectionId: "c",
      environment: "e",
      database: "b",
      sql: "y",
      rowCount: 0,
      elapsed: "",
    });

    expect(store.list({ database: "a" }).length).toBe(1);
    expect(store.list({ database: "b" }).length).toBe(1);
  });

  it("filters by keyword", () => {
    store.save({
      connectionId: "c",
      environment: "e",
      database: "d",
      sql: "SELECT * FROM users",
      rowCount: 0,
      elapsed: "",
    });
    store.save({
      connectionId: "c",
      environment: "e",
      database: "d",
      sql: "SELECT * FROM orders",
      rowCount: 0,
      elapsed: "",
    });

    expect(store.list({ keyword: "users" }).length).toBe(1);
    expect(store.list({ keyword: "SELECT" }).length).toBe(2);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 10; i++) {
      store.save({
        connectionId: "c",
        environment: "e",
        database: "d",
        sql: `SELECT ${i}`,
        rowCount: 0,
        elapsed: "",
      });
    }
    expect(store.list({ limit: 5 }).length).toBe(5);
  });

  it("deletes by id", () => {
    const entry = store.save({
      connectionId: "c",
      environment: "e",
      database: "d",
      sql: "x",
      rowCount: 0,
      elapsed: "",
    });
    expect(store.delete(entry.id)).toBe(true);
    expect(store.delete(9999)).toBe(false);
  });
});
