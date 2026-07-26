import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSchemaCache,
  saveSchemaCache,
  getCachedTables,
  getCachedTableSchema,
  type SchemaSnapshot,
} from "../schema/cache";

const TEST_CONN = "test-conn-cache";
const TEST_DB = "test_db_cache";

describe("schema cache", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = join(tmpdir(), `schema-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  const makeSnapshot = (): SchemaSnapshot => ({
    database: TEST_DB,
    tables: [
      {
        name: "orders",
        columns: [
          {
            name: "id",
            type: "bigint",
            nullable: false,
            key: "PRI",
            default: null,
            extra: "auto_increment",
            comment: "订单ID",
          },
          {
            name: "status",
            type: "varchar(32)",
            nullable: false,
            key: "",
            default: null,
            extra: "",
            comment: "",
          },
        ],
        indexes: [
          { name: "PRIMARY", columns: ["id"], unique: true },
        ],
      },
    ],
    refreshedAt: "2026-07-26T12:00:00.000Z",
  });

  it("returns null when no cache exists", () => {
    expect(loadSchemaCache(TEST_CONN, TEST_DB, baseDir)).toBeNull();
    expect(getCachedTables(TEST_CONN, TEST_DB, baseDir)).toBeNull();
  });

  it("saves and loads schema cache", () => {
    const snapshot = makeSnapshot();
    saveSchemaCache(snapshot, TEST_CONN, baseDir);

    const loaded = loadSchemaCache(TEST_CONN, TEST_DB, baseDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.database).toBe(TEST_DB);
    expect(loaded!.tables.length).toBe(1);
    expect(loaded!.tables[0].name).toBe("orders");
    expect(loaded!.tables[0].columns[0].comment).toBe("订单ID");
  });

  it("getCachedTables returns table names", () => {
    saveSchemaCache(makeSnapshot(), TEST_CONN, baseDir);

    const tables = getCachedTables(TEST_CONN, TEST_DB, baseDir);
    expect(tables).toEqual(["orders"]);
  });

  it("getCachedTableSchema returns table details", () => {
    saveSchemaCache(makeSnapshot(), TEST_CONN, baseDir);

    const table = getCachedTableSchema(TEST_CONN, TEST_DB, "orders", baseDir);
    expect(table).not.toBeNull();
    expect(table!.columns.length).toBe(2);
    expect(table!.indexes.length).toBe(1);
  });

  it("getCachedTableSchema returns null for unknown table", () => {
    saveSchemaCache(makeSnapshot(), TEST_CONN, baseDir);

    expect(getCachedTableSchema(TEST_CONN, TEST_DB, "nonexistent", baseDir)).toBeNull();
  });

  it("returns null for malformed cache file", () => {
    const schemaDir = join(baseDir, "schema", TEST_CONN);
    mkdirSync(schemaDir, { recursive: true });
    writeFileSync(join(schemaDir, `${TEST_DB}.json`), "not json {");

    expect(loadSchemaCache(TEST_CONN, TEST_DB, baseDir)).toBeNull();
  });
});
