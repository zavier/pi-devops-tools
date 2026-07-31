/**
 * /db query —— 对当前数据库执行 SQL 查询。
 *
 * 两种模式：表优先（选表 → WHERE → 自动生成）和裸 SQL。
 *
 * 只读守卫和 LIMIT 注入在 connection/sql-policy.ts，由执行器强制——
 * 本模块只用 READONLY_SQL_RE 做分发判断（参数是表名还是 SQL？）。
 *
 *
 * 导出：
 * - handleQuery     —— /db query 入口
 * - executeAndDisplay —— favorites 处理器共用
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { RelatedResult, SqlRow } from "../types";
import { READONLY_SQL_RE } from "../connection/sql-policy";
import { formatTableCompact } from "../formatting/result-table";
import { pickTableFuzzy, withLoader } from "./utils";
import type { QueryResultEntryData } from "./renderers";

interface ExecutedResult {
  columns: string[];
  rows: SqlRow[];
  elapsed: string;
  sql: string; // final SQL after policy (LIMIT may have been appended)
}

// ── 行清洗 ────────────────────────────────────────────

/** 将 SqlRow 值转为 string|null —— 保证条目中 JSON 序列化安全。 */
function sanitizeRows(rows: SqlRow[]): Record<string, string | null>[] {
  return rows.map((row) => {
    const obj: Record<string, string | null> = {};
    for (const key of Object.keys(row)) {
      const val = row[key];
      obj[key] = val === null || val === undefined ? null : String(val);
    }
    return obj;
  });
}

// ── 关联结果格式化 ──────────────────────────────────

function formatRelatedResults(related: RelatedResult[]): string {
  if (related.length === 0) return "";

  const lines: string[] = ["", "────── 关联表 ──────", ""];
  for (const r of related) {
    lines.push(`### ${r.schema}.${r.table}`);
    lines.push(`关联路径：${r.joinPath}`);
    lines.push(`行数：${r.rowCount}（${r.elapsed}）`);
    lines.push("");
    if (r.rows.length > 0) {
      lines.push(formatTableCompact({ columns: r.columns, rows: r.rows }));
    } else {
      lines.push("（空结果）");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── 展示（双受众：TUI 条目 + LLM 上下文）──────────

async function displayQueryResult(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  result: ExecutedResult,
  related: RelatedResult[] = [],
): Promise<void> {
  const database = ws.current!.database;
  try {
    ws.saveHistory(result.sql, result.rows.length, result.elapsed);
  } catch {
    /* 非致命 */
  }

  // ── TUI：自适应宽度表格（条目，不进 LLM 上下文）───────

  pi.appendEntry("db-query-result", {
    database,
    sql: result.sql,
    rowCount: result.rows.length,
    elapsed: result.elapsed,
    columns: result.columns,
    rows: sanitizeRows(result.rows),
    relatedCount: related.length,
  } satisfies QueryResultEntryData);

  // ── LLM 上下文：紧凑表格 + 元数据（display: false）───────

  const compact = formatTableCompact({ columns: result.columns, rows: result.rows });
  const relatedText = related.length > 0 ? formatRelatedResults(related) : "";

  const content = [
    `## 数据库查询结果`,
    ``,
    `**数据库**：${database}`,
    `**SQL**：${result.sql}`,
    `**行数**：${result.rows.length}（${result.elapsed}）`,
    ``,
    compact,
  ];
  if (related.length > 0) {
    content.push(``, `### 关联表（${related.length} 个）`, ``, relatedText);
  }

  pi.sendMessage(
    {
      customType: "db-query-result",
      content: content.join("\n"),
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}

// ── 执行并展示 ─────────────────────────────────────────

export async function executeAndDisplay(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  sql: string,
): Promise<void> {
  const result = await withLoader(
    ctx,
    "执行查询…",
    (_signal) => ws.executeQuery(sql),
    (err) => ctx.ui.notify(`查询出错：${err.message}`, "error"),
  );
  if (!result) return;

  await displayQueryResult(ctx, ws, pi, result);
}

// ── 表优先查询 ───────────────────────────────────────────

async function queryByTable(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  preSelectedTable?: string,
): Promise<void> {
  const table = preSelectedTable ?? (await pickTableFuzzy(ctx, ws, "选择数据表"));
  if (!table) return;

  const where = await ctx.ui.input(`WHERE 条件（可选，回车跳过）`, "");
  if (where === undefined) return;

  const hasRelations = ws.listRelations(table).length > 0;

  let autoJoin = false;
  if (hasRelations) {
    const choice = await ctx.ui.select("查询关联表？", [
      "📎 是，一起查询关联表",
      "📋 否，只查主表",
    ]);
    if (choice === undefined) return;
    autoJoin = choice.startsWith("📎");
  }

  // 这里不加 LIMIT——执行器追加配置的上限。
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

// ── 裸 SQL 输入 ───────────────────────────────────────────────

async function queryRaw(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  const sql = await ctx.ui.editor("SQL（只读查询，支持多行）", "");
  if (!sql || !sql.trim()) return;

  // 不做预校验——执行器强制只读守卫。
  await executeAndDisplay(ctx, ws, pi, sql.trim());
}

// ── 入口 ─────────────────────────────────────────────────

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
    try {
      tables = await ws.getTables();
    } catch {
      tables = [];
    }
    if (tables.includes(tableArg)) {
      return await queryByTable(ctx, ws, pi, tableArg);
    }
    if (READONLY_SQL_RE.test(tableArg)) {
      return await executeAndDisplay(ctx, ws, pi, tableArg);
    }
    ctx.ui.notify(`"${tableArg}" 不是已知表名或有效 SQL`, "warning");
    return;
  }

  // 统一选择器：表 + 第一个选项是 SQL 输入
  const sqlEntry: SelectItem = { value: "__sql__", label: "✏️ 直接输入 SQL…" };
  const choice = await pickTableFuzzy(ctx, ws, "选择数据表 或 直接输入 SQL", [sqlEntry]);
  if (!choice) return;

  if (choice === "__sql__") {
    return await queryRaw(ctx, ws, pi);
  }
  return await queryByTable(ctx, ws, pi, choice);
}
