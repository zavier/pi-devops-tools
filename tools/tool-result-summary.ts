/**
 * 数据库工具结果的折叠态摘要——纯函数，无 pi 导入、无 I/O。
 *
 * db-tools.ts 中常驻工具的 renderResult 用它生成默认（折叠）展示的
 * 一行摘要；用户按 ctrl+o（app.tools.expand）展开后展示 content 全文。
 * 摘要按各工具的 details 形状生成，未知工具或未知形状返回 undefined，
 * 由调用方回退到完整内容。
 */

/** db_query 的 details 形状。 */
export interface DbQueryDetails {
  connection: string;
  database: string;
  rowCount: number;
  elapsed: string;
}

/** db_tables 的 details 形状（列表 / schema 两种模式仅设置不同字段）。 */
export interface DbTablesDetails {
  connection: string;
  database: string;
  /** schema 模式：目标表名。 */
  table?: string;
  /** 列表模式：全部表名。 */
  tables?: string[];
  /** schema 模式：列数。 */
  columnCount?: number;
  /** schema 模式：索引数。 */
  indexCount?: number;
}

/** db_discover 的 details 形状。 */
export interface DbDiscoverDetails {
  connections: string[];
  connection: string;
  /** 目标连接上的数据库数（未指定 connection 时缺省）。 */
  databaseCount?: number;
}

/** db_tools loader 的 details 形状。 */
export interface DbToolsDetails {
  matches: string[];
  added: string[];
}

/** 带折叠摘要的常驻工具名。 */
export type SummarizableDbTool = "db_query" | "db_tables" | "db_discover" | "db_tools";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 生成工具结果的折叠态摘要（中文，用户可见）。
 *
 * 返回 undefined 表示该工具或 details 形状没有已知摘要——
 * 调用方应回退到完整内容展示。
 */
export function summarizeDbToolResult(toolName: string, details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  switch (toolName) {
    case "db_query": {
      if (typeof details.rowCount !== "number") return undefined;
      const d = details as unknown as Partial<DbQueryDetails>;
      return `db_query：${d.rowCount} 行 · ${d.elapsed ?? ""}（${d.connection ?? "?"}/${d.database ?? "?"}）`;
    }
    case "db_tables": {
      const d = details as unknown as Partial<DbTablesDetails>;
      if (d.table !== undefined) {
        if (typeof d.columnCount !== "number" || typeof d.indexCount !== "number") {
          return undefined;
        }
        return `db_tables：${d.database ?? "?"}.${d.table} 结构（${d.columnCount} 列 / ${d.indexCount} 索引）`;
      }
      if (!Array.isArray(d.tables)) return undefined;
      return `db_tables：${d.database ?? "?"} 表列表（${d.tables.length} 个）`;
    }
    case "db_discover": {
      const d = details as unknown as Partial<DbDiscoverDetails>;
      if (!Array.isArray(d.connections)) return undefined;
      const base = `db_discover：${d.connections.length} 个连接`;
      return typeof d.databaseCount === "number" ? `${base} · ${d.databaseCount} 个数据库` : base;
    }
    case "db_tools": {
      const d = details as unknown as Partial<DbToolsDetails>;
      if (!Array.isArray(d.added) || !Array.isArray(d.matches)) return undefined;
      if (d.added.length > 0) return `db_tools：已启用 ${d.added.join("、")}`;
      if (d.matches.length > 0) return `db_tools：已激活 ${d.matches.join("、")}`;
      return "db_tools：无匹配工具";
    }
    default:
      return undefined;
  }
}
