/**
 * Query History Store — SQLite-based persistence for /db query history.
 *
 * Database: ~/.pi/database/history.db
 * Table: query_history
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ====== Paths ======

const DATA_DIR = join(homedir(), ".pi", "database");
const DB_PATH = join(DATA_DIR, "history.db");

// ====== Types ======

export interface HistoryEntry {
  id: number;
  connectionId: string;
  environment: string;
  database: string;
  sql: string;
  rowCount: number;
  elapsed: string;
  createdTime: string; // ISO-8601
}

export interface HistoryFilter {
  limit?: number;
  connectionId?: string;
  database?: string;
  keyword?: string;
}

// ====== Store ======

export class QueryHistoryStore {
  private db: Database.Database;
  private initialized = false;

  constructor(dbPath?: string) {
    const path = dbPath ?? DB_PATH;
    mkdirSync(DATA_DIR, { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    if (this.initialized) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        database TEXT NOT NULL,
        sql TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        elapsed TEXT NOT NULL DEFAULT '',
        created_time TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Indexes for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_connection
        ON query_history(connection_id, database);
      CREATE INDEX IF NOT EXISTS idx_history_time
        ON query_history(created_time DESC);
    `);

    this.initialized = true;
  }

  /** Save a query execution record. */
  save(entry: Omit<HistoryEntry, "id" | "createdTime">): HistoryEntry {
    const stmt = this.db.prepare(`
      INSERT INTO query_history (connection_id, environment, database, sql, row_count, elapsed)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      entry.connectionId,
      entry.environment,
      entry.database,
      entry.sql,
      entry.rowCount,
      entry.elapsed,
    );

    return this.getById(Number(result.lastInsertRowid))!;
  }

  /** Get a single entry by ID. */
  getById(id: number): HistoryEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM query_history WHERE id = ?")
      .get(id) as Record<string, any> | undefined;

    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  /** List history entries, newest first. */
  list(filter: HistoryFilter = {}): HistoryEntry[] {
    const limit = filter.limit ?? 50;
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.connectionId) {
      conditions.push("connection_id = ?");
      params.push(filter.connectionId);
    }

    if (filter.database) {
      conditions.push("database = ?");
      params.push(filter.database);
    }

    if (filter.keyword) {
      conditions.push("sql LIKE ?");
      params.push(`%${filter.keyword}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT * FROM query_history ${where} ORDER BY created_time DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as Record<string, any>[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /** Delete an entry by ID. */
  delete(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM query_history WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /** Total count of history entries. */
  count(filter?: { connectionId?: string; database?: string }): number {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.connectionId) {
      conditions.push("connection_id = ?");
      params.push(filter.connectionId);
    }
    if (filter?.database) {
      conditions.push("database = ?");
      params.push(filter.database);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM query_history ${where}`)
      .get(...params) as { cnt: number };

    return row.cnt;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  private rowToEntry(row: Record<string, any>): HistoryEntry {
    return {
      id: row.id,
      connectionId: row.connection_id,
      environment: row.environment,
      database: row.database,
      sql: row.sql,
      rowCount: row.row_count,
      elapsed: row.elapsed,
      createdTime: row.created_time,
    };
  }
}
