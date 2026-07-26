import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadSchemaCache,
  saveSchemaCache,
  getCachedTables,
  getCachedTableSchema,
  type SchemaSnapshot,
} from "../schema/cache";

const SCHEMA_DIR = join(homedir(), ".pi", "database", "schema");
const TEST_CONN = "test-conn-cache";
const TEST_DB = "test_db_cache";

describe("schema cache", () => {
  beforeEach(() => {
    // Clean test area
    const dir = join(SCHEMA_DIR, TEST_CONN);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  afterEach(() => {
    const dir = join(SCHEMA_DIR, TEST_CONN);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
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
    expect(loadSchemaCache(TEST_CONN, TEST_DB)).toBeNull();
    expect(getCachedTables(TEST_CONN, TEST_DB)).toBeNull();
  });

  it("saves and loads schema cache", () => {
    const snapshot = makeSnapshot();
    saveSchemaCache(snapshot, TEST_CONN);

    const loaded = loadSchemaCache(TEST_CONN, TEST_DB);
    expect(loaded).not.toBeNull();
    expect(loaded!.database).toBe(TEST_DB);
    expect(loaded!.tables.length).toBe(1);
    expect(loaded!.tables[0].name).toBe("orders");
    expect(loaded!.tables[0].columns[0].comment).toBe("订单ID");
  });

  it("getCachedTables returns table names", () => {
    saveSchemaCache(makeSnapshot(), TEST_CONN);

    const tables = getCachedTables(TEST_CONN, TEST_DB);
    expect(tables).toEqual(["orders"]);
  });

  it("getCachedTableSchema returns table details", () => {
    saveSchemaCache(makeSnapshot(), TEST_CONN);

    const table = getCachedTableSchema(TEST_CONN, TEST_DB, "orders");
    expect(table).not.toBeNull();
    expect(table!.columns.length).toBe(2);
    expect(table!.indexes.length).toBe(1);
  });

  it("getCachedTableSchema returns null for unknown table", () => {
    saveSchemaCache(makeSnapshot(), TEST_CONN);

    expect(getCachedTableSchema(TEST_CONN, TEST_DB, "nonexistent")).toBeNull();
  });

  it("returns null for malformed cache file", () => {
    const dir = join(SCHEMA_DIR, TEST_CONN);
    mkdirSync(dir, { recursive: true });
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(dir, `${TEST_DB}.json`), "not json {");

    expect(loadSchemaCache(TEST_CONN, TEST_DB)).toBeNull();
  });
});
