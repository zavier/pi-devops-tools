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
  rows: Record<string, any>[];
  rowCount: number;
  joinPath: string;
  elapsed: string;
}
