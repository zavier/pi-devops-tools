/**
 * 表关系存储 —— 基于 SQLite 的表列关系持久化。
 *
 * 表：table_relations（在同一个 state.db 中）
 */

import Database from "better-sqlite3";
import type { ColumnRelation, StoredRelation } from "../types";

// ====== 存储 ======

export class RelationStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
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

    // 加唯一约束前去重——保留 id 最小的行
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
  }

  // ── CRUD ──────────────────────────────────────────────────────

  /** 幂等保存关系。冲突时创建或更新。返回该行。 */
  upsert(rel: Omit<ColumnRelation, "id">): StoredRelation {
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

  private findByColumns(
    schema: string,
    table: string,
    column: string,
    condition: string,
    refSchema: string,
    refTable: string,
    refColumn: string,
  ): StoredRelation | undefined {
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

  /** 列出所有关系，可选过滤。 */
  list(filter?: {
    schema?: string;
    table?: string;
    refSchema?: string;
    refTable?: string;
  }): StoredRelation[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.schema) {
      conditions.push("schema = ?");
      params.push(filter.schema);
    }
    if (filter?.table) {
      // "involving" 语义: 匹配源表或被引用表(图是双向的, 查询/关联提示
      // 需要能看到"被引用"方向的关系——如 /db query t_customers 的关联提示)
      conditions.push("(table_name = ? OR ref_table = ?)");
      params.push(filter.table, filter.table);
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

  /** 按 ID 删除关系。 */
  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM table_relations WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** 按精确列对删除关系。返回是否删除了行。 */
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

  // ── 辅助 ───────────────────────────────────────────────────

  private rowToRelation(row: Record<string, any>): StoredRelation {
    return {
      id: row.id,
      schema: row.schema,
      table: row.table_name,
      column: row.column_name,
      condition: row.condition,
      refSchema: row.ref_schema,
      refTable: row.ref_table,
      refColumn: row.ref_column,
      relationType: row.relation_type,
      createdTime: row.created_time,
      updatedTime: row.updated_time,
    };
  }
}
