/**
 * 查询历史存储 —— 基于 SQLite 的 /db 查询历史持久化。
 *
 * 数据库：~/.pi/database/state.db
 * 表：query_history
 */

import type Database from "better-sqlite3";

// ====== 类型 ======

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

// ====== 存储 ======

export class QueryHistoryStore {
  private db: Database.Database;
  private initialized = false;

  constructor(db: Database.Database) {
    this.db = db;
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

    // 常用查询的索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_connection
        ON query_history(connection_id, database);
      CREATE INDEX IF NOT EXISTS idx_history_time
        ON query_history(created_time DESC);
    `);

    this.initialized = true;
  }

  /** 保存一条查询执行记录。 */
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

  /** 按 ID 获取单条记录。 */
  getById(id: number): HistoryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM query_history WHERE id = ?").get(id) as
      | Record<string, any>
      | undefined;

    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  /** 列出历史记录，最新的在前。 */
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
      .prepare(`SELECT * FROM query_history ${where} ORDER BY created_time DESC, id DESC LIMIT ?`)
      .all(...params, limit) as Record<string, any>[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /** 按 ID 删除记录。 */
  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM query_history WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** 历史记录总数。 */
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

// ====== 收藏类型 ======

export interface FavoriteEntry {
  id: number;
  name: string;
  sql: string;
  database: string; // '' = global
  description: string;
  createdTime: string;
  updatedTime: string;
}

export interface FavoriteFilter {
  database?: string; // also includes global (database = '')
  keyword?: string;
  limit?: number;
}

// ====== 收藏存储 ======

/**
 * 与历史同库持久化的收藏查询。
 * 表：query_favorites
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

  /** 保存一条新收藏。 */
  save(entry: Omit<FavoriteEntry, "id" | "createdTime" | "updatedTime">): FavoriteEntry {
    const stmt = this.db.prepare(`
      INSERT INTO query_favorites (name, sql, database, description)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(entry.name, entry.sql, entry.database, entry.description);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  /** 按 ID 获取。 */
  getById(id: number): FavoriteEntry | undefined {
    const row = this.db.prepare("SELECT * FROM query_favorites WHERE id = ?").get(id) as
      | Record<string, any>
      | undefined;
    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  /** 列出收藏，可按数据库和/或关键词过滤。 */
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
      .prepare(`SELECT * FROM query_favorites ${where} ORDER BY updated_time DESC, id DESC LIMIT ?`)
      .all(...params, limit) as Record<string, any>[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /** 更新收藏的名称、sql 和/或描述。 */
  update(
    id: number,
    fields: { name?: string; sql?: string; description?: string },
  ): FavoriteEntry | undefined {
    const sets: string[] = [];
    const params: any[] = [];

    if (fields.name !== undefined) {
      sets.push("name = ?");
      params.push(fields.name);
    }
    if (fields.sql !== undefined) {
      sets.push("sql = ?");
      params.push(fields.sql);
    }
    if (fields.description !== undefined) {
      sets.push("description = ?");
      params.push(fields.description);
    }

    if (sets.length === 0) return this.getById(id);

    sets.push("updated_time = datetime('now')");
    params.push(id);

    this.db.prepare(`UPDATE query_favorites SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    return this.getById(id);
  }

  /** 按 ID 删除收藏。 */
  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM query_favorites WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** 总数。 */
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
