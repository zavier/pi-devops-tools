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

/** 存储中的一条表关系——camelCase 唯一形状（snake_case 只在 SQLite 边界映射）。 */
export interface StoredRelation {
  id: number;
  schema: string;
  table: string;
  column: string;
  condition: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  relationType: string;
  createdTime: string;
  updatedTime: string;
}

/** 关系输入/领域形状——StoredRelation 去掉持久化字段。 */
export type ColumnRelation = Omit<StoredRelation, "id" | "createdTime" | "updatedTime">;

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
