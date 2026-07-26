/**
 * /db query — execute SQL queries against the current database.
 *
 * Two modes: table-first (pick table → WHERE → auto-generate) and raw SQL.
 *
 * Exports:
 * - handleQuery     — entry point for /db query
 * - executeAndDisplay — shared by favorites handler
 * - READONLY_SQL_RE — shared by favorites handler for validation
 * - formatRelatedResults — shared by favorites/relations
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { RelatedResult } from "../types";
import { formatTableResult } from "../formatting/result-table";
import { pickTable } from "./utils";

export const READONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i;

// ── Related results formatting ──────────────────────────────────

export function formatRelatedResults(related: RelatedResult[]): string {
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

// ── Execute and display ─────────────────────────────────────────

export async function executeAndDisplay(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  sql: string,
): Promise<void> {
  let result: { columns: string[]; rows: Record<string, any>[]; elapsed: string };
  try {
    result = await ws.executeQuery(sql);
  } catch (err: any) {
    ctx.ui.notify(`查询出错：${err.message}`, "error");
    return;
  }

  try { ws.saveHistory(sql, result.rows.length, result.elapsed); } catch { /* non-fatal */ }

  const text = [
    `═══ 查询 — ${ws.current!.database} ═══`,
    `SQL：${sql}`,
    `行数：${result.rows.length}（${result.elapsed}）`,
    "",
    formatTableResult({ columns: result.columns, rows: result.rows }),
  ].join("\n");

  ctx.ui.notify(text, "info");

  pi.sendMessage(
    {
      customType: "db-query-result",
      content: `[DB Query] ${ws.current!.database}: ${sql} → ${result.rows.length} rows, ${result.columns.length} cols (${result.elapsed})`,
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}

async function executeAndDisplayWithRelated(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  sql: string,
  related: RelatedResult[],
): Promise<void> {
  let result: { columns: string[]; rows: Record<string, any>[]; elapsed: string };
  try {
    result = await ws.executeQuery(sql);
  } catch (err: any) {
    ctx.ui.notify(`查询出错：${err.message}`, "error");
    return;
  }

  try { ws.saveHistory(sql, result.rows.length, result.elapsed); } catch { /* non-fatal */ }

  const text = [
    `═══ 查询 — ${ws.current!.database} ═══`,
    `SQL：${sql}`,
    `行数：${result.rows.length}（${result.elapsed}）`,
    "",
    formatTableResult({ columns: result.columns, rows: result.rows }),
    formatRelatedResults(related),
    `共查询 ${1 + related.length} 个表`,
  ].join("\n");

  ctx.ui.notify(text, "info");

  pi.sendMessage(
    {
      customType: "db-query-result",
      content: `[DB Query] ${ws.current!.database}: ${sql} → ${result.rows.length} rows + ${related.length} related tables (${result.elapsed})`,
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
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

  const hasRelations = ws.getRelations(table).length > 0;

  let autoJoin = false;
  if (hasRelations) {
    const choice = await ctx.ui.select(
      "查询关联表？",
      ["📎 是，一起查询关联表", "📋 否，只查主表"],
    );
    if (choice === undefined) return;
    autoJoin = choice.startsWith("📎");
  }

  let sql = `SELECT * FROM \`${table}\``;
  if (where.trim()) {
    sql += ` WHERE ${where.trim()}`;
  }
  sql += ` LIMIT 100`;

  if (autoJoin) {
    const { columns, rows, elapsed, related } = await ws.executeQueryWithRelations(sql, table, true);
    await executeAndDisplayWithRelated(ctx, ws, pi, sql, related);
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

  if (!READONLY_SQL_RE.test(sql.trim())) {
    ctx.ui.notify(
      `仅允许只读 SQL（SELECT、SHOW、DESCRIBE、EXPLAIN）`,
      "error",
    );
    return;
  }

  await executeAndDisplay(ctx, ws, pi, sql.trim());
}

// ── Entry point ─────────────────────────────────────────────────

export async function handleQuery(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  tableArg?: string,
): Promise<void> {
  if (!ws.isReady()) {
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
