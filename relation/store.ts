/**
 * Table Relation Store — SQLite-based persistence for table column relationships.
 *
 * Table: table_relations (in the same state.db)
 */

import Database from "better-sqlite3";
import type { ColumnRelation } from "../types";

// ====== Types ======

export interface RelationRow {
  id: number;
  schema: string;
  table_name: string;
  column_name: string;
  condition: string;
  ref_schema: string;
  ref_table: string;
  ref_column: string;
  relation_type: string;
  created_time: string;
  updated_time: string;
}

// ====== Store ======

export class RelationStore {
  private db: Database.Database;
  private initialized = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    if (this.initialized) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS table_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema TEXT NOT NULL,
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        condition TEXT NOT NULL DEFAULT '',
        ref_schema TEXT NOT NULL,
        ref_table TEXT NOT NULL,
        ref_column TEXT NOT NULL,
        relation_type TEXT NOT NULL DEFAULT 'MANY_TO_ONE',
        created_time TEXT NOT NULL DEFAULT (datetime('now')),
        updated_time TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Dedup before adding unique constraint — keep the row with the smallest id
    this.db.exec(`
      DELETE FROM table_relations
      WHERE id NOT IN (
        SELECT MIN(id) FROM table_relations
        GROUP BY schema, table_name, column_name, condition,
                 ref_schema, ref_table, ref_column
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relations_schema_table
        ON table_relations(schema, table_name);
      CREATE INDEX IF NOT EXISTS idx_relations_ref
        ON table_relations(ref_schema, ref_table);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
        ON table_relations(schema, table_name, column_name, condition,
                           ref_schema, ref_table, ref_column);
    `);

    this.initialized = true;
  }

  // ── CRUD ──────────────────────────────────────────────────────

  /** Upsert a relation. Creates or updates on conflict. Returns the row. */
  upsert(rel: Omit<ColumnRelation, "id">): RelationRow {
    this.db
      .prepare(`
      INSERT INTO table_relations
        (schema, table_name, column_name, condition, ref_schema, ref_table, ref_column, relation_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schema, table_name, column_name, condition, ref_schema, ref_table, ref_column)
      DO UPDATE SET
        relation_type = excluded.relation_type,
        updated_time  = datetime('now')
    `)
      .run(
        rel.schema,
        rel.table,
        rel.column,
        rel.condition,
        rel.refSchema,
        rel.refTable,
        rel.refColumn,
        rel.relationType,
      );
    return this.findByColumns(
      rel.schema,
      rel.table,
      rel.column,
      rel.condition,
      rel.refSchema,
      rel.refTable,
      rel.refColumn,
    )!;
  }

  /** Find a relation by its full column tuple. */
  findByColumns(
    schema: string,
    table: string,
    column: string,
    condition: string,
    refSchema: string,
    refTable: string,
    refColumn: string,
  ): RelationRow | undefined {
    const row = this.db
      .prepare(`
      SELECT * FROM table_relations
      WHERE schema = ? AND table_name = ? AND column_name = ? AND condition = ?
        AND ref_schema = ? AND ref_table = ? AND ref_column = ?
    `)
      .get(schema, table, column, condition, refSchema, refTable, refColumn) as
      | Record<string, any>
      | undefined;
    return row ? this.rowToRelation(row) : undefined;
  }

  /** Get a single relation by ID. */
  getById(id: number): RelationRow | undefined {
    const row = this.db.prepare("SELECT * FROM table_relations WHERE id = ?").get(id) as
      | Record<string, any>
      | undefined;
    if (!row) return undefined;
    return this.rowToRelation(row);
  }

  /** List all relations, optionally filtered. */
  list(filter?: {
    schema?: string;
    table?: string;
    refSchema?: string;
    refTable?: string;
  }): RelationRow[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.schema) {
      conditions.push("schema = ?");
      params.push(filter.schema);
    }
    if (filter?.table) {
      conditions.push("table_name = ?");
      params.push(filter.table);
    }
    if (filter?.refSchema) {
      conditions.push("ref_schema = ?");
      params.push(filter.refSchema);
    }
    if (filter?.refTable) {
      conditions.push("ref_table = ?");
      params.push(filter.refTable);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(`SELECT * FROM table_relations ${where} ORDER BY id ASC`)
      .all(...params) as Record<string, any>[];

    return rows.map((r) => this.rowToRelation(r));
  }

  /** Delete a relation by ID. */
  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM table_relations WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Delete a relation by exact column match. Returns whether a row was deleted. */
  deleteByColumns(
    schema: string,
    table: string,
    column: string,
    condition: string,
    refSchema: string,
    refTable: string,
    refColumn: string,
  ): boolean {
    const result = this.db
      .prepare(`
      DELETE FROM table_relations
      WHERE schema = ? AND table_name = ? AND column_name = ? AND condition = ?
        AND ref_schema = ? AND ref_table = ? AND ref_column = ?
    `)
      .run(schema, table, column, condition, refSchema, refTable, refColumn);
    return result.changes > 0;
  }

  /** Count relations, optionally filtered. */
  count(filter?: { schema?: string }): number {
    const params: any[] = [];
    let where = "";
    if (filter?.schema) {
      where = "WHERE schema = ?";
      params.push(filter.schema);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM table_relations ${where}`)
      .get(...params) as { cnt: number };
    return row.cnt;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private rowToRelation(row: Record<string, any>): RelationRow {
    return {
      id: row.id,
      schema: row.schema,
      table_name: row.table_name,
      column_name: row.column_name,
      condition: row.condition,
      ref_schema: row.ref_schema,
      ref_table: row.ref_table,
      ref_column: row.ref_column,
      relation_type: row.relation_type,
      created_time: row.created_time,
      updated_time: row.updated_time,
    };
  }
}
