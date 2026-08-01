/**
 * connection/db-manager.ts 的驱动 seam 测试——fake pool 覆盖
 * USE→query 检出编排、LIMIT 策略、错误路径与元数据查询（不连真实 MySQL）。
 */
import { describe, it, expect } from "vitest";
import {
  DatabaseConnectionManager,
  type ConnectionLike,
  type PoolLike,
} from "../connection/db-manager";
import type { ResolvedConnectionConfig } from "../connection/db-config";

const CONFIG: ResolvedConnectionConfig = {
  id: "main",
  environment: "prod",
  type: "mysql",
  host: "h1",
  port: 3306,
  username: "u",
  password: "p",
  defaultDatabase: "appdb",
  queryLimit: 100,
};

interface QueryCall {
  sql: string | { sql: string; timeout?: number };
  params?: unknown[];
}

interface FakeRows {
  poolRows?: Record<string, any>[];
  columnsRows?: Record<string, any>[];
  indexRows?: Record<string, any>[];
  fkRows?: Record<string, any>[];
  dbRows?: Record<string, any>[];
  tableRows?: Record<string, any>[];
  /** conn.query 非 USE 语句的返回——executeQuery 传数组行，executeMutation 传单对象。 */
  connResult?: unknown;
}

/** fake 驱动池：按 SQL 特征路由到预设行，记录全部调用。 */
function makeFakePool(opts: FakeRows = {}) {
  const calls: QueryCall[] = [];
  let endCount = 0;

  const pool: PoolLike = {
    async query<T = unknown[]>(
      sql: string | { sql: string; timeout?: number },
      params?: unknown[],
    ): Promise<[T, unknown]> {
      calls.push({ sql, params });
      const s = typeof sql === "string" ? sql : sql.sql;
      let rows: Record<string, any>[];
      if (s.includes("information_schema.COLUMNS")) rows = opts.columnsRows ?? [];
      else if (s.includes("information_schema.STATISTICS")) rows = opts.indexRows ?? [];
      else if (s.includes("KEY_COLUMN_USAGE")) rows = opts.fkRows ?? [];
      else if (s.includes("SHOW DATABASES")) rows = opts.dbRows ?? [];
      else if (s.includes("information_schema.TABLES")) rows = opts.tableRows ?? [];
      else rows = opts.poolRows ?? [];
      return [rows as unknown as T, null];
    },
    async getConnection() {
      const conn: ConnectionLike = {
        async query<T = unknown[]>(
          sql: string | { sql: string; timeout?: number },
          params?: unknown[],
        ): Promise<[T, unknown]> {
          calls.push({ sql, params });
          const s = typeof sql === "string" ? sql : sql.sql;
          if (s.trim().startsWith("USE")) return [[] as unknown as T, null];
          return [opts.connResult as T, null];
        },
        release() {},
      };
      return conn;
    },
    async end() {
      endCount++;
    },
  };

  return { pool, calls, endCount: () => endCount };
}

describe("DatabaseConnectionManager.executeQuery", () => {
  it("检出连接先 USE 再执行查询，无界 SELECT 追加 LIMIT", async () => {
    const { pool, calls } = makeFakePool({ connResult: [{ id: 1, name: "alice" }] });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    const out = await manager.executeQuery("main", "appdb", "SELECT * FROM users");

    expect(calls.length).toBe(2);
    expect(calls[0].sql).toBe("USE `appdb`");
    expect(calls[1].sql).toEqual({ sql: "SELECT * FROM users LIMIT 100", timeout: 30000 });
    expect(out.sql).toBe("SELECT * FROM users LIMIT 100");
    expect(out.rows).toEqual([{ id: 1, name: "alice" }]);
    expect(out.columns).toEqual(["id", "name"]);
  });

  it("已有尾部 LIMIT 时不重复追加", async () => {
    const { pool, calls } = makeFakePool({ connResult: [] });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    await manager.executeQuery("main", "appdb", "SELECT * FROM users LIMIT 5");

    const final = calls[1].sql as { sql: string };
    expect(final.sql).toBe("SELECT * FROM users LIMIT 5");
  });

  it("透传 bound params", async () => {
    const { pool, calls } = makeFakePool({ connResult: [] });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    await manager.executeQuery("main", "appdb", "SELECT * FROM users WHERE id = ?", {
      params: [7],
    });

    expect(calls[1].params).toEqual([7]);
  });

  it("未知连接抛错并列出可用连接", async () => {
    const { pool } = makeFakePool();
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    await expect(manager.executeQuery("nope", "db", "SELECT 1")).rejects.toThrow(
      "Connection 'nope' not found",
    );
  });
});

describe("DatabaseConnectionManager.executeMutation", () => {
  it("在检出连接上执行并返回受影响行数", async () => {
    const { pool, calls } = makeFakePool({ connResult: { affectedRows: 3 } });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    const out = await manager.executeMutation(
      "main",
      "appdb",
      "UPDATE users SET vip = 1 WHERE id = 2",
    );

    expect(calls[0].sql).toBe("USE `appdb`");
    expect(out).toEqual({
      affectedRows: 3,
      elapsed: expect.any(String),
      sql: "UPDATE users SET vip = 1 WHERE id = 2",
    });
  });
});

describe("DatabaseConnectionManager 元数据查询", () => {
  it("getDatabases 排序返回数据库名", async () => {
    const { pool } = makeFakePool({ dbRows: [{ Database: "logs" }, { Database: "appdb" }] });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    expect(await manager.getDatabases("main")).toEqual(["appdb", "logs"]);
  });

  it("getTables 映射表名", async () => {
    const { pool } = makeFakePool({ tableRows: [{ TABLE_NAME: "users" }] });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    expect(await manager.getTables("main", "appdb")).toEqual(["users"]);
  });

  it("getTableSchema 在边界收窄为 SchemaColumn 并聚合索引", async () => {
    const { pool } = makeFakePool({
      columnsRows: [
        {
          COLUMN_NAME: "id",
          COLUMN_TYPE: "bigint",
          IS_NULLABLE: "NO",
          COLUMN_KEY: "PRI",
          COLUMN_DEFAULT: null,
          EXTRA: "auto_increment",
          COLUMN_COMMENT: "",
        },
      ],
      indexRows: [{ INDEX_NAME: "PRIMARY", COLUMN_NAME: "id", NON_UNIQUE: 0, SEQ_IN_INDEX: 1 }],
    });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    const schema = await manager.getTableSchema("main", "appdb", "users");

    expect(schema.columns).toEqual([
      {
        name: "id",
        type: "bigint",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "auto_increment",
        comment: "",
      },
    ]);
    expect(schema.indexes).toEqual([{ name: "PRIMARY", columns: ["id"], unique: true }]);
  });

  it("discoverForeignKeys 映射为 ColumnRelation", async () => {
    const { pool } = makeFakePool({
      fkRows: [
        {
          TABLE_SCHEMA: "appdb",
          TABLE_NAME: "orders",
          COLUMN_NAME: "user_id",
          REFERENCED_TABLE_SCHEMA: "appdb",
          REFERENCED_TABLE_NAME: "users",
          REFERENCED_COLUMN_NAME: "id",
        },
      ],
    });
    const manager = new DatabaseConnectionManager([CONFIG], () => pool);

    const fks = await manager.discoverForeignKeys("main", "appdb");

    expect(fks[0]).toMatchObject({
      table: "orders",
      column: "user_id",
      refTable: "users",
      refColumn: "id",
      relationType: "MANY_TO_ONE",
    });
  });
});

describe("DatabaseConnectionManager 池生命周期", () => {
  it("pool 按连接懒创建一次并复用", async () => {
    const pool = makeFakePool();
    let created = 0;
    const manager = new DatabaseConnectionManager([CONFIG], () => {
      created++;
      return pool.pool;
    });

    await manager.getDatabases("main");
    await manager.getDatabases("main");
    expect(created).toBe(1);
  });

  it("destroy 关闭所有池", async () => {
    const pool = makeFakePool();
    const manager = new DatabaseConnectionManager([CONFIG], () => pool.pool);

    await manager.getDatabases("main");
    manager.destroy();
    expect(pool.endCount()).toBe(1);
  });
});
