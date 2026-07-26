// ====== 配置类型 ======

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;  // ${ENV_VAR} 已替换后的明文
  dbs: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  jumpHost: string | null;
}

export interface ServiceConfig {
  server: string;
  logPath: string;
  errorLogPath?: string;
  accessLogPath?: string;
}

export interface AppConfig {
  databases: Record<string, DatabaseConfig>;
  servers: Record<string, ServerConfig>;
  services: Record<string, ServiceConfig>;
}

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

export interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  elapsed: string;
  sql: string;
}

export interface RelatedResult {
  schema: string;
  table: string;
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  joinPath: string;
  elapsed: string;
}

export interface AutoJoinResult {
  primary: QueryResult;
  related: RelatedResult[];
}

export interface LogQueryResult {
  service: string;
  server: string;
  logFile: string;
  lines: string[];
  lineCount: number;
  elapsed: string;
}
