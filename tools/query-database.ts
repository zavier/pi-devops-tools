import { Type } from "@sinclair/typebox";
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { RowDataPacket } from "mysql2/promise";
import type { AppConfig, QueryResult, AutoJoinResult, RelatedResult } from "../types";
import type { ConnectionManager } from "../connections";
import type { RelationGraph } from "../relation-graph";
import { formatTableResult } from "../formatting/result-table";

const READONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i;

function ensureLimit(sql: string, limit: number): string {
  const upper = sql.trim().toUpperCase();
  if (/\bLIMIT\s+\d+\s*$/.test(upper)) return sql.trim();
  if (/\bLIMIT\s+\d+\s*;?\s*$/.test(upper)) return sql.trim();
  // Remove trailing semicolon before appending LIMIT
  const cleaned = sql.trim().replace(/;+\s*$/, "");
  return `${cleaned} LIMIT ${limit}`;
}

function formatRelatedResults(related: RelatedResult[]): string {
  if (related.length === 0) return "";

  const lines: string[] = ["", "## 关联表", ""];
  for (const r of related) {
    lines.push(`### ${r.schema}.${r.table}`);
    lines.push(`关联路径：${r.joinPath}`);
    lines.push(`行数：${r.rowCount}（${r.elapsed}）`);
    lines.push("");
    lines.push(formatTableResult({
      columns: r.columns,
      rows: r.rows,
      rowCount: r.rowCount,
      elapsed: r.elapsed,
      sql: "",
    }));
    lines.push("");
  }
  return lines.join("\n");
}

export function createQueryDatabaseTool(
  config: AppConfig,
  connections: ConnectionManager,
  graph: RelationGraph
) {
  return defineTool({
    name: "query_database",
    label: "Query Database",
    description:
      "Execute a read-only SQL query against a MySQL database cluster. " +
      "Supports automatic related-table lookup via pre-configured table relations. " +
      "Use this to inspect data, verify query results, or look up records.",
    parameters: Type.Object({
      cluster: Type.String({ description: "Cluster name from config.json databases" }),
      database: Type.String({ description: "Database name within the cluster" }),
      sql: Type.String({ description: "SQL SELECT statement (read-only)" }),
      autoJoin: Type.Optional(Type.Boolean({
        description: "Automatically query related tables using BFS (default: false)",
        default: false,
      })),
      maxDepth: Type.Optional(Type.Number({
        description: "Maximum BFS depth for auto-join (default: 2, max: 5)",
        default: 2,
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum rows to return (default: 100, max: 500)",
        default: 100,
      })),
    }),
    async execute(
      _toolCallId: string,
      params: { cluster: string; database: string; sql: string; autoJoin?: boolean; maxDepth?: number; limit?: number },
      _signal?: AbortSignal,
      _onUpdate?: any,
      _ctx?: any,
    ) {
      try {
        // Validate SQL
        if (!READONLY_SQL_RE.test(params.sql.trim())) {
          return {
            content: [{
              type: "text" as const,
              text: `错误：仅允许只读 SQL（SELECT、SHOW、DESCRIBE、EXPLAIN）。收到：${params.sql.trim().slice(0, 50)}...`,
            }],
            details: undefined,
          };
        }

        const limit = Math.min(params.limit ?? 100, 500);
        const maxDepth = Math.min(params.maxDepth ?? 2, 5);

        const pool = connections.getMySQLPool(params.cluster);

        // Switch to the target database
        await pool.query(`USE \`${params.database}\``);

        const safeSql = ensureLimit(params.sql, limit);

        const start = Date.now();
        const [rows] = await pool.query<RowDataPacket[]>({ sql: safeSql, timeout: 30000 });
        const elapsed = `${((Date.now() - start) / 1000).toFixed(3)}s`;

        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const primary: QueryResult = {
          columns,
          rows,
          rowCount: rows.length,
          elapsed,
          sql: safeSql,
        };

        // Extract table name from SQL for BFS
        const tableMatch = params.sql.match(/FROM\s+`?(\w+)`?/i);
        const table = tableMatch ? tableMatch[1] : params.database;

        if (params.autoJoin && rows.length > 0) {
          const related = await graph.bfsQuery(
            pool, params.database, table, rows, maxDepth, limit
          );

          const autoJoinResult: AutoJoinResult = { primary, related };

          return {
            content: [{
              type: "text" as const,
              text: [
                `## 主表：${params.database}.${table}`,
                `行数：${primary.rowCount}（${primary.elapsed}）`,
                `SQL：${safeSql}`,
                "",
                formatTableResult(primary),
                formatRelatedResults(related),
                "",
                `共查询 ${1 + related.length} 个表`,
              ].join("\n"),
            }],
            details: autoJoinResult,
          };
        }

        const autoJoinResult: AutoJoinResult = { primary, related: [] };

        return {
          content: [{
            type: "text" as const,
            text: [
              `## ${params.cluster}/${params.database}`,
              `行数：${primary.rowCount}（${primary.elapsed}）`,
              `SQL：${safeSql}`,
              "",
              formatTableResult(primary),
            ].join("\n"),
          }],
          details: autoJoinResult,
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `查询出错：${err.message}`,
          }],
          details: undefined,
        };
      }
    },
  });
}
