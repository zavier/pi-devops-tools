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

  /** Get the underlying database instance (for sharing across stores). */
  getDb(): Database.Database {
    return this.db;
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

// ====== Favorite Types ======

export interface FavoriteEntry {
  id: number;
  name: string;
  sql: string;
  database: string;   // '' = global
  description: string;
  createdTime: string;
  updatedTime: string;
}

export interface FavoriteFilter {
  database?: string;  // also includes global (database = '')
  keyword?: string;
  limit?: number;
}

// ====== Favorite Store ======

/**
 * Favorite queries persisted in the same SQLite DB as history.
 * Table: query_favorites
 */
export class FavoriteStore {
  private db: Database.Database;
  private initialized = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    if (this.initialized) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        sql TEXT NOT NULL,
        database TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        created_time TEXT NOT NULL DEFAULT (datetime('now')),
        updated_time TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_favorites_database
        ON query_favorites(database, name)
    `);

    this.initialized = true;
  }

  /** Save a new favorite. */
  save(entry: Omit<FavoriteEntry, "id" | "createdTime" | "updatedTime">): FavoriteEntry {
    const stmt = this.db.prepare(`
      INSERT INTO query_favorites (name, sql, database, description)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(entry.name, entry.sql, entry.database, entry.description);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  /** Get by ID. */
  getById(id: number): FavoriteEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM query_favorites WHERE id = ?")
      .get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  /** List favorites, filtered by database and/or keyword. */
  list(filter: FavoriteFilter = {}): FavoriteEntry[] {
    const limit = filter.limit ?? 100;
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.database !== undefined) {
      conditions.push("(database = ? OR database = '')");
      params.push(filter.database);
    }

    if (filter.keyword) {
      conditions.push("(name LIKE ? OR sql LIKE ?)");
      params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT * FROM query_favorites ${where} ORDER BY updated_time DESC, id DESC LIMIT ?`
      )
      .all(...params, limit) as Record<string, any>[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /** Update a favorite's name, sql, and/or description. */
  update(id: number, fields: { name?: string; sql?: string; description?: string }): FavoriteEntry | undefined {
    const sets: string[] = [];
    const params: any[] = [];

    if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
    if (fields.sql !== undefined) { sets.push("sql = ?"); params.push(fields.sql); }
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }

    if (sets.length === 0) return this.getById(id);

    sets.push("updated_time = datetime('now')");
    params.push(id);

    this.db
      .prepare(`UPDATE query_favorites SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  }

  /** Delete a favorite by ID. */
  delete(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM query_favorites WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /** Total count. */
  count(filter?: { database?: string }): number {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.database !== undefined) {
      conditions.push("(database = ? OR database = '')");
      params.push(filter.database);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM query_favorites ${where}`)
      .get(...params) as { cnt: number };
    return row.cnt;
  }

  private rowToEntry(row: Record<string, any>): FavoriteEntry {
    return {
      id: row.id,
      name: row.name,
      sql: row.sql,
      database: row.database,
      description: row.description,
      createdTime: row.created_time,
      updatedTime: row.updated_time,
    };
  }
}
