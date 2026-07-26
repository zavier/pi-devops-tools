/**
 * Database Connection Manager for the /db workspace.
 *
 * Manages mysql2 connection pools keyed by connection ID, and is the single
 * query execution point: every query passes the read-only guard and LIMIT
 * policy (see sql-policy.ts) and runs on a dedicated checked-out connection
 * so USE and the query can't be split across pool connections.
 */

import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { ResolvedConnectionConfig } from "./db-config";
import { prepareReadOnlyQuery, DEFAULT_QUERY_LIMIT } from "./sql-policy";

export interface QueryOptions {
  limit?: number;     // row cap for SELECTs without trailing LIMIT (default: connection's queryLimit)
  timeout?: number;   // per-query timeout in ms (default: 30000)
  params?: unknown[]; // bound values for ? placeholders
}

export interface QueryOutput {
  columns: string[];
  rows: RowDataPacket[];
  elapsed: string;
  sql: string; // final SQL after policy (LIMIT may have been appended)
}

export class DatabaseConnectionManager {
  private pools = new Map<string, Pool>();
  private configMap: Map<string, ResolvedConnectionConfig>;

  constructor(connections: ResolvedConnectionConfig[]) {
    this.configMap = new Map(connections.map(c => [c.id, c]));
  }

  /** Get the config for a connection ID. */
  getConfig(id: string): ResolvedConnectionConfig | undefined {
    return this.configMap.get(id);
  }

  /** List all configured connection IDs. */
  getConnectionIds(): string[] {
    return [...this.configMap.keys()];
  }

  /**
   * Get (or create) a mysql2 pool for a connection ID.
   * The pool connects without specifying a default database —
   * the workspace switches databases dynamically via USE.
   */
  getPool(connectionId: string): Pool {
    const existing = this.pools.get(connectionId);
    if (existing) return existing;

    const cfg = this.configMap.get(connectionId);
    if (!cfg) {
      throw new Error(
        `Connection '${connectionId}' not found. Available: ${this.getConnectionIds().join(", ")}`
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
   * List databases accessible on a connection.
   * Connects without a default database and runs SHOW DATABASES.
   */
  async getDatabases(connectionId: string): Promise<string[]> {
    const pool = this.getPool(connectionId);
    const [rows] = await pool.query<RowDataPacket[]>("SHOW DATABASES");
    return rows.map(r => r.Database as string).sort();
  }

  /**
   * List tables in the current database context.
   */
  async getTables(connectionId: string, database: string): Promise<string[]> {
    const pool = this.getPool(connectionId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database]
    );
    return rows.map(r => r.TABLE_NAME as string);
  }

  /**
   * Get column definitions for a table.
   */
  async getTableSchema(
    connectionId: string,
    database: string,
    table: string
  ): Promise<{ columns: RowDataPacket[]; indexes: RowDataPacket[] }> {
    const pool = this.getPool(connectionId);

    const [columns] = await pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table]
    );

    const [indexes] = await pool.query<RowDataPacket[]>(
      `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, table]
    );

    return { columns, indexes };
  }

  /**
   * Execute a read-only SQL query against a specific database.
   *
   * The SQL passes the read-only guard and gets a LIMIT appended if it's an
   * unbounded SELECT. USE only affects the connection it runs on, so we check
   * out a dedicated connection to keep the switch and the query together.
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
   * Discover foreign key relationships from information_schema.
   * Returns ColumnRelation[] suitable for merging into RelationGraph.
   */
  async discoverForeignKeys(connectionId: string, schema: string): Promise<import("../types").ColumnRelation[]> {
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
    const [rows] = await pool.query(fkSql, [schema]) as [Record<string, any>[], any];

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

  /** Close all pools. */
  destroy(): void {
    for (const [, pool] of this.pools) {
      pool.end().catch(() => {});
    }
    this.pools.clear();
  }
}
