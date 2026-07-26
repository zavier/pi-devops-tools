// ====== 通用类型 ======

/** MySQL/SQLite 查询结果中单个字段的运行时类型。 */
export type SqlValue = string | number | boolean | null;

/** 查询结果行 — 列名到 SqlValue 的映射。 */
export type SqlRow = Record<string, SqlValue>;

// ====== 关系图类型 ======

export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
  condition?: string;
}

export interface ColumnRelation {
  schema: string;
  table: string;
  column: string;
  condition: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  relationType: string;
}

// ====== 查询结果类型 ======

export interface RelatedResult {
  schema: string;
  table: string;
  columns: string[];
  rows: SqlRow[];
  rowCount: number;
  joinPath: string;
  elapsed: string;
}
