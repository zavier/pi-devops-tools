import { Type } from "@sinclair/typebox";
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { RowDataPacket } from "mysql2/promise";
import type { AppConfig, QueryResult, AutoJoinResult, RelatedResult } from "../types";
import type { ConnectionManager } from "../connections";
import type { RelationGraph } from "../relation-graph";

const READONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i;

function ensureLimit(sql: string, limit: number): string {
  const upper = sql.trim().toUpperCase();
  if (/\bLIMIT\s+\d+\s*$/.test(upper)) return sql.trim();
  if (/\bLIMIT\s+\d+\s*;?\s*$/.test(upper)) return sql.trim();
  // Remove trailing semicolon before appending LIMIT
  const cleaned = sql.trim().replace(/;+\s*$/, "");
  return `${cleaned} LIMIT ${limit}`;
}

// ── Column analysis ──────────────────────────────────────────────

interface ColumnStats {
  visible: string[];
  allNull: string[];
  allSame: { col: string; value: string }[];
}

function analyzeColumns(columns: string[], rows: Record<string, any>[]): ColumnStats {
  const visible: string[] = [];
  const allNull: string[] = [];
  const allSame: { col: string; value: string }[] = [];

  for (const col of columns) {
    let firstVal: any = undefined;
    let firstSet = false;
    let isAllNull = true;
    let isAllSame = true;

    for (const row of rows) {
      const val = row[col];
      if (val !== null && val !== undefined) {
        isAllNull = false;
        if (!firstSet) { firstVal = val; firstSet = true; }
        else if (String(val) !== String(firstVal)) { isAllSame = false; break; }
      }
    }

    if (isAllNull) allNull.push(col);
    else if (isAllSame) allSame.push({ col, value: String(firstVal) });
    else visible.push(col);
  }

  return { visible, allNull, allSame };
}

function hiddenNote(stats: ColumnStats): string {
  const parts: string[] = [];
  if (stats.allNull.length > 0) parts.push(`${stats.allNull.length} 列全为 NULL`);
  if (stats.allSame.length > 0) {
    const sample = stats.allSame.slice(0, 2).map(s => `${s.col}=${s.value}`).join(", ");
    const trail = stats.allSame.length > 2 ? "，…" : "";
    parts.push(`${stats.allSame.length} 列值相同：${sample}${trail}`);
  }
  return parts.length > 0 ? `  ⓘ ${parts.join("  |  ")}` : "";
}

// ── Horizontal table (≤ 8 cols) ──────────────────────────────────

function formatHorizontal(columns: string[], rows: Record<string, any>[], totalRows: number, note: string): string {
  const MAX_COL = 22;
  const MAX_DISPLAY = 20;
  const displayRows = rows.slice(0, MAX_DISPLAY);

  const widths = columns.map(col => {
    let max = Math.min(col.length, MAX_COL);
    for (const row of displayRows) {
      const len = row[col] === null ? 4 : String(row[col]).length;
      if (len > max) max = len;
    }
    return Math.min(max, MAX_COL);
  });

  const cell = (val: unknown, w: number): string => {
    const s = val === null ? "NULL" : String(val);
    if (s.length > w) return s.slice(0, w - 1) + "…";
    return s.padEnd(w);
  };

  const lines: string[] = [];
  lines.push("| " + columns.map((c, i) => cell(c, widths[i])).join(" | ") + " |");
  lines.push("|" + widths.map(w => "-".repeat(w + 2)).join("|") + "|");
  for (const row of displayRows) {
    lines.push("| " + columns.map((c, i) => cell(row[c], widths[i])).join(" | ") + " |");
  }
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ── Transposed (columns→rows, rows→columns) ──────────────────────

function formatTransposed(columns: string[], rows: Record<string, any>[], totalRows: number, note: string): string {
  const MAX_COL_NAME = 24;
  const MAX_CELL = 36;
  const MAX_DISPLAY = 10;
  const displayRows = rows.slice(0, MAX_DISPLAY);

  // Build row headers: #1, #2, … with optional identifier
  const rowHeaders = displayRows.map((row, i) => {
    const id = pickId(row, columns);
    const label = id ? `#${i + 1} ${id}` : `#${i + 1}`;
    return label.length > 22 ? label.slice(0, 19) + "…" : label;
  });

  const colWidth = Math.min(MAX_COL_NAME, Math.max(...columns.map(c => c.length)));
  const cellWidths = rowHeaders.map(h => Math.min(MAX_CELL, h.length));

  const cell = (val: unknown, w: number): string => {
    const s = val === null ? "NULL" : String(val);
    if (s.length > w) return s.slice(0, w - 1) + "…";
    return s.padEnd(w);
  };

  const lines: string[] = [];

  // Header row: blank │ row1 │ row2 │ …
  lines.push("  " + "".padEnd(colWidth) + " │ " + rowHeaders.map((h, i) => cell(h, cellWidths[i])).join(" │ "));
  // Separator
  lines.push("  " + "─".repeat(colWidth) + "─┼─" + cellWidths.map(w => "─".repeat(w)).join("─┼─"));

  // One row per column
  for (const col of columns) {
    const vals = displayRows.map((row, i) => cell(row[col], cellWidths[i]));
    lines.push("  " + col.padEnd(colWidth) + " │ " + vals.join(" │ "));
  }

  lines.push("");
  lines.push(`显示 ${totalRows} 行 × ${columns.length} 列`);
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ── Vertical key-value per row (> 8 cols & > 10 rows) ────────────

function formatVertical(columns: string[], rows: Record<string, any>[], totalRows: number, note: string): string {
  const MAX_DISPLAY = 5;
  const displayRows = rows.slice(0, MAX_DISPLAY);
  const labelWidth = Math.min(28, Math.max(...columns.map(c => c.length)));

  const lines: string[] = [];
  for (let i = 0; i < displayRows.length; i++) {
    const row = displayRows[i];
    const id = pickId(row, columns);
    lines.push(`─── Row ${i + 1}${id ? `  [${id}]` : ""} ───`);
    for (const col of columns) {
      const val = row[col];
      const s = val === null ? "NULL" : String(val);
      const display = s.length > 60 ? s.slice(0, 57) + "…" : s;
      lines.push(`  ${col.padEnd(labelWidth)} │ ${display}`);
    }
    lines.push("");
  }
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ── Pick a human-readable row identifier ─────────────────────────

function pickId(row: Record<string, any>, columns: string[]): string {
  const candidates = ["id", "name", "host", "user", "username", "email", "key", "code"];
  for (const c of candidates) {
    const match = columns.find(col => col.toLowerCase() === c);
    if (match && row[match] != null) return String(row[match]);
  }
  return "";
}

// ── Main entry point ─────────────────────────────────────────────

function formatTableResult(result: QueryResult): string {
  if (result.rows.length === 0) return "（空结果）";

  const stats = analyzeColumns(result.columns, result.rows);
  const note = hiddenNote(stats);
  const cols = stats.visible.length > 0 ? stats.visible : result.columns; // fallback: all cols hidden
  const totalRows = result.rows.length;

  if (cols.length <= 8) {
    return formatHorizontal(cols, result.rows, totalRows, note);
  }
  if (result.rows.length <= 10) {
    return formatTransposed(cols, result.rows, totalRows, note);
  }
  return formatVertical(cols, result.rows, totalRows, note);
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
