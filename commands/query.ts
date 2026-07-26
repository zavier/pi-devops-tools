/**
 * /db query — execute SQL queries against the current database.
 *
 * Two modes: table-first (pick table → WHERE → auto-generate) and raw SQL.
 *
 * Read-only guard and LIMIT injection live in connection/sql-policy.ts and are
 * enforced by the executor — this module only uses READONLY_SQL_RE for dispatch
 * (is this argument a table name or SQL?).
 *
 * Exports:
 * - handleQuery     — entry point for /db query
 * - executeAndDisplay — shared by favorites handler
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { RelatedResult } from "../types";
import { READONLY_SQL_RE } from "../connection/sql-policy";
import { formatTableResult } from "../formatting/result-table";
import { pickTable } from "./utils";

interface ExecutedResult {
  columns: string[];
  rows: Record<string, any>[];
  elapsed: string;
  sql: string; // final SQL after policy (LIMIT may have been appended)
}

// ── Related results formatting ──────────────────────────────────

function formatRelatedResults(related: RelatedResult[]): string {
  if (related.length === 0) return "";

  const lines: string[] = ["", "────── 关联表 ──────", ""];
  for (const r of related) {
    lines.push(`### ${r.schema}.${r.table}`);
    lines.push(`关联路径：${r.joinPath}`);
    lines.push(`行数：${r.rowCount}（${r.elapsed}）`);
    lines.push("");
    if (r.rows.length > 0) {
      lines.push(formatTableResult({ columns: r.columns, rows: r.rows }));
    } else {
      lines.push("（空结果）");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Display (renders an already-executed result — never re-queries) ──

async function displayQueryResult(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  result: ExecutedResult,
  related: RelatedResult[] = [],
): Promise<void> {
  try { ws.saveHistory(result.sql, result.rows.length, result.elapsed); } catch { /* non-fatal */ }

  const lines = [
    `═══ 查询 — ${ws.current!.database} ═══`,
    `SQL：${result.sql}`,
    `行数：${result.rows.length}（${result.elapsed}）`,
    "",
    formatTableResult({ columns: result.columns, rows: result.rows }),
  ];
  if (related.length > 0) {
    lines.push(formatRelatedResults(related), `共查询 ${1 + related.length} 个表`);
  }

  ctx.ui.notify(lines.join("\n"), "info");

  pi.sendMessage(
    {
      customType: "db-query-result",
      content:
        `[DB Query] ${ws.current!.database}: ${result.sql} → ${result.rows.length} rows, ${result.columns.length} cols (${result.elapsed})` +
        (related.length > 0 ? ` + ${related.length} related tables` : ""),
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}

// ── Execute and display ─────────────────────────────────────────

export async function executeAndDisplay(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  sql: string,
): Promise<void> {
  let result: ExecutedResult;
  try {
    result = await ws.executeQuery(sql);
  } catch (err: any) {
    ctx.ui.notify(`查询出错：${err.message}`, "error");
    return;
  }

  await displayQueryResult(ctx, ws, pi, result);
}

// ── Table-first query ───────────────────────────────────────────

async function queryByTable(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  preSelectedTable?: string,
): Promise<void> {
  const table = preSelectedTable ?? await pickTable(ctx, ws, "选择数据表");
  if (!table) return;

  const where = await ctx.ui.input(
    `WHERE 条件（可选，回车跳过）`,
    "",
  );
  if (where === undefined) return;

  const hasRelations = ws.listRelations(table).length > 0;

  let autoJoin = false;
  if (hasRelations) {
    const choice = await ctx.ui.select(
      "查询关联表？",
      ["📎 是，一起查询关联表", "📋 否，只查主表"],
    );
    if (choice === undefined) return;
    autoJoin = choice.startsWith("📎");
  }

  // No LIMIT here — the executor appends the configured cap.
  let sql = `SELECT * FROM \`${table}\``;
  if (where.trim()) {
    sql += ` WHERE ${where.trim()}`;
  }

  if (autoJoin) {
    let result: ExecutedResult & { related: RelatedResult[] };
    try {
      result = await ws.executeQueryWithRelations(sql, table, true);
    } catch (err: any) {
      ctx.ui.notify(`查询出错：${err.message}`, "error");
      return;
    }
    await displayQueryResult(ctx, ws, pi, result, result.related);
  } else {
    await executeAndDisplay(ctx, ws, pi, sql);
  }
}

// ── Raw SQL input ───────────────────────────────────────────────

async function queryRaw(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  const sql = await ctx.ui.input("SQL", "SELECT * FROM ... LIMIT 10");
  if (!sql || !sql.trim()) return;

  // No pre-validation — the executor enforces the read-only guard.
  await executeAndDisplay(ctx, ws, pi, sql.trim());
}

// ── Entry point ─────────────────────────────────────────────────

export async function handleQuery(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  tableArg?: string,
): Promise<void> {
  if (!ws.isReady) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  if (tableArg) {
    let tables: string[];
    try { tables = await ws.getTables(); } catch { tables = []; }
    if (tables.includes(tableArg)) {
      return await queryByTable(ctx, ws, pi, tableArg);
    }
    if (READONLY_SQL_RE.test(tableArg)) {
      return await executeAndDisplay(ctx, ws, pi, tableArg);
    }
    ctx.ui.notify(`"${tableArg}" 不是已知表名或有效 SQL`, "warning");
    return;
  }

  const mode = await ctx.ui.select("查询方式", ["📋 选择数据表", "✏️ 输入 SQL"]);
  if (!mode) return;

  if (mode.startsWith("📋")) {
    return await queryByTable(ctx, ws, pi);
  } else {
    return await queryRaw(ctx, ws, pi);
  }
}
