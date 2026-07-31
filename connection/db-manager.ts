/**
 * /db 工作空间的数据库连接管理器。
 *
 * 管理按连接 ID 键控的 mysql2 连接池，是唯一的查询执行点：
 * 每条查询都经过只读守卫和 LIMIT 策略（见 sql-policy.ts），并在检出的
 * 专用连接上执行，这样 USE 与查询不会散落在连接池的不同连接上。
 */

import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import type { ResolvedConnectionConfig } from "./db-config";
import { prepareReadOnlyQuery, DEFAULT_QUERY_LIMIT } from "./sql-policy";

export interface QueryOptions {
  limit?: number; // row cap for SELECTs without trailing LIMIT (default: connection's queryLimit)
  timeout?: number; // per-query timeout in ms (default: 30000)
  params?: unknown[]; // bound values for ? placeholders
}

export interface QueryOutput {
  columns: string[];
  rows: RowDataPacket[];
  elapsed: string;
  sql: string; // final SQL after policy (LIMIT may have been appended)
}

export interface MutationOutput {
  affectedRows: number;
  elapsed: string;
  sql: string;
}

export class DatabaseConnectionManager {
  private pools = new Map<string, Pool>();
  private configMap: Map<string, ResolvedConnectionConfig>;

  constructor(connections: ResolvedConnectionConfig[]) {
    this.configMap = new Map(connections.map((c) => [c.id, c]));
  }

  /** 获取某连接 ID 的配置。 */
  getConfig(id: string): ResolvedConnectionConfig | undefined {
    return this.configMap.get(id);
  }

  /** 列出所有已配置的连接 ID。 */
  getConnectionIds(): string[] {
    return [...this.configMap.keys()];
  }

  /**
   * 获取（或创建）某连接 ID 的 mysql2 连接池。
   * 连接池连接时不指定默认数据库——工作空间通过 USE 动态切换数据库。
   */
  getPool(connectionId: string): Pool {
    const existing = this.pools.get(connectionId);
    if (existing) return existing;

    const cfg = this.configMap.get(connectionId);
    if (!cfg) {
      throw new Error(
        `Connection '${connectionId}' not found. Available: ${this.getConnectionIds().join(", ")}`,
      );
    }

    const pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.username,
      password: cfg.password,
      connectTimeout: 10000,
      waitForConnections: true,
      connectionLimit: 3,
      enableKeepAlive: true,
      keepAliveInitialDelay: 60000,
    });

    this.pools.set(connectionId, pool);
    return pool;
  }

  /**
   * 列出某连接上可访问的数据库。
   * 不带默认数据库连接，执行 SHOW DATABASES。
   */
  async getDatabases(connectionId: string): Promise<string[]> {
    const pool = this.getPool(connectionId);
    const [rows] = await pool.query<RowDataPacket[]>("SHOW DATABASES");
    return rows.map((r) => r.Database as string).sort();
  }

  /**
   * 列出当前数据库上下文中的表。
   */
  async getTables(connectionId: string, database: string): Promise<string[]> {
    const pool = this.getPool(connectionId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database],
    );
    return rows.map((r) => r.TABLE_NAME as string);
  }

  /**
   * 获取表的列定义。
   */
  async getTableSchema(
    connectionId: string,
    database: string,
    table: string,
  ): Promise<{ columns: RowDataPacket[]; indexes: RowDataPacket[] }> {
    const pool = this.getPool(connectionId);

    const [columns] = await pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table],
    );

    const [indexes] = await pool.query<RowDataPacket[]>(
      `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, table],
    );

    return { columns, indexes };
  }

  /**
   * 对指定数据库执行只读 SQL 查询。
   *
   * SQL 经过只读守卫，若是无界 SELECT 则自动追加 LIMIT。USE 只影响其执行的
   * 连接，因此检出专用连接，保证切换与查询不分离。
   */
  async executeQuery(
    connectionId: string,
    database: string,
    sql: string,
    opts: QueryOptions = {},
  ): Promise<QueryOutput> {
    const pool = this.getPool(connectionId);
    const cfg = this.configMap.get(connectionId)!;
    const finalSql = prepareReadOnlyQuery(sql, opts.limit ?? cfg.queryLimit ?? DEFAULT_QUERY_LIMIT);

    const conn = await pool.getConnection();
    try {
      await conn.query(`USE \`${database}\``);

      const start = Date.now();
      const [rows] = await conn.query<RowDataPacket[]>(
        { sql: finalSql, timeout: opts.timeout ?? 30000 },
        opts.params,
      );
      const elapsed = `${((Date.now() - start) / 1000).toFixed(3)}s`;

      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return { columns, rows, elapsed, sql: finalSql };
    } finally {
      conn.release();
    }
  }

  /**
   * 从 information_schema 发现外键关系。
   * 返回适合合并进 RelationGraph 的 ColumnRelation[]。
   */
  async discoverForeignKeys(
    connectionId: string,
    schema: string,
  ): Promise<import("../types").ColumnRelation[]> {
    const pool = this.getPool(connectionId);
    const fkSql = `
      SELECT
        TABLE_SCHEMA,
        TABLE_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_SCHEMA,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND REFERENCED_COLUMN_NAME IS NOT NULL
    `;
    const [rows] = (await pool.query(fkSql, [schema])) as [Record<string, any>[], any];

    return rows.map((row: Record<string, any>) => ({
      schema: row.TABLE_SCHEMA as string,
      table: row.TABLE_NAME as string,
      column: row.COLUMN_NAME as string,
      condition: "",
      refSchema: (row.REFERENCED_TABLE_SCHEMA ?? schema) as string,
      refTable: row.REFERENCED_TABLE_NAME as string,
      refColumn: row.REFERENCED_COLUMN_NAME as string,
      relationType: "MANY_TO_ONE" as const,
    }));
  }

  /**
   * 执行 DML 变更（INSERT/UPDATE/DELETE/REPLACE）。
   * 无只读守卫；无 LIMIT 注入。
   * 从 MySQL 的 ResultSetHeader 返回受影响行数。
   */
  async executeMutation(
    connectionId: string,
    database: string,
    sql: string,
    opts: { timeout?: number } = {},
  ): Promise<MutationOutput> {
    const pool = this.getPool(connectionId);
    const conn = await pool.getConnection();
    try {
      await conn.query(`USE \`${database}\``);
      const start = Date.now();
      const [result] = await conn.query<ResultSetHeader>({ sql, timeout: opts.timeout ?? 30000 });
      const elapsed = `${((Date.now() - start) / 1000).toFixed(3)}s`;
      return {
        affectedRows: result.affectedRows,
        elapsed,
        sql,
      };
    } finally {
      conn.release();
    }
  }

  /** 关闭所有连接池。 */
  destroy(): void {
    for (const [, pool] of this.pools) {
      pool.end().catch(() => {});
    }
    this.pools.clear();
  }
}
