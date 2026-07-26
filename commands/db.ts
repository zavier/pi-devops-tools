/**
 * /db command — Database Workspace entry point.
 *
 * Subcommands:
 *   /db              Show workspace panel with current state
 *   /db switch       Select environment → database interactively
 *
 * Registered via pi.registerCommand("db", ...) in index.ts.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { HistoryEntry, FavoriteEntry } from "../history/store";
import type { RelationRow } from "../relation/store";
import type { RelatedResult } from "../types";

// AutocompleteItem matches @earendil-works/pi-tui's interface.
// Defined locally to avoid a direct dependency on pi-tui.
interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

// ====== Status bar key ======

const STATUS_KEY = "db-workspace";

// ====== Command registration ======

export function registerDbCommand(
  pi: ExtensionAPI,
  ws: DatabaseWorkspaceService,
): void {
  pi.registerCommand("db", {
    description:
      "Database workspace: /db (panel) | /db switch | /db tables | /db schema <table> | /db query [table] | /db history | /db favorite | /db relations | /db refresh-schema",

    getArgumentCompletions: async (prefix) => {
      return getCompletions(prefix, ws);
    },

    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      switch (sub) {
        case undefined:
          await showWorkspacePanel(ctx, ws);
          break;
        case "switch":
          await handleSwitch(ctx, ws, pi);
          break;
        case "tables":
          await handleTables(ctx, ws);
          break;
        case "schema":
          await handleSchema(ctx, ws, rest[0]);
          break;
        case "query":
          await handleQuery(ctx, ws, pi, rest[0]);
          break;
        case "history":
          await handleHistory(ctx, ws, rest[0]);
          break;
        case "favorite":
          await handleFavorite(ctx, ws, pi, rest);
          break;
        case "relations":
          await handleRelations(ctx, ws, pi, rest);
          break;
        case "refresh-schema":
          await handleRefreshSchema(ctx, ws);
          break;
        default:
          ctx.ui.notify(
            `未知命令: ${sub}。可用：switch, tables, schema, query, history, favorite, relations, refresh-schema`,
            "warning",
          );
      }
    },
  });
}

// ====== Argument completions ======

async function getCompletions(
  prefix: string,
  ws: DatabaseWorkspaceService,
): Promise<AutocompleteItem[] | null> {
  const subcommands = ["switch", "tables", "schema", "query", "history", "favorite", "relations", "refresh-schema"];
  const parts = prefix.trim().split(/\s+/);
  const hasTrailingSpace = prefix.endsWith(" ");

  // First token: subcommand name (skip if user already typed space → completing next arg)
  if (parts.length === 1 && !hasTrailingSpace && prefix.length > 1) {
    return subcommands
      .filter((s) => s.startsWith(parts[0]))
      .map((s) => ({ value: s + " ", label: s }));
  }

  // /db schema <table> | /db query <table> — complete table names
  // IMPORTANT: value must include the subcommand prefix because pi replaces
  // the ENTIRE prefix with value, not just the current token.
  if (parts.length >= 1 && (parts[0] === "schema" || parts[0] === "query") && ws.isReady()) {
    try {
      const tables = await ws.getTables();
      const partial = hasTrailingSpace ? "" : (parts[1] ?? "");
      const sub = parts[0];
      return tables
        .filter((t) => t.toLowerCase().startsWith(partial.toLowerCase()))
        .map((t) => ({ value: `${sub} ${t}`, label: t }));
    } catch {
      return null;
    }
  }

  return null;
}

// ====== Workspace panel ======

async function showWorkspacePanel(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<void> {
  const lines: string[] = [];

  lines.push("═══ 数据库工作区 ═══");
  lines.push("");

  if (ws.current) {
    const conn = ws.getCurrentConnection();
    lines.push(`环境   ：${ws.current.environment}`);
    lines.push(`连接   ：${ws.current.connectionId}（${conn?.host ?? "?"}）`);
    lines.push(`数据库 ：${ws.current.database}`);
  } else {
    lines.push("未选择数据库，使用 /db switch 连接");
    lines.push("");
    lines.push(
      `可用环境：${ws.getEnvironments().join(", ") || "（未配置）"}`,
    );
  }

  lines.push("");
  lines.push("命令：");
  lines.push("  /db switch          选择环境和数据库");
  lines.push("  /db tables          列出所有表");
  lines.push("  /db schema <表名>   查看表结构");
  lines.push("  /db query [表名]    选表 → WHERE → 查询");
  lines.push("  /db history         查询历史");
  lines.push("  /db favorite        收藏的查询模板");
  lines.push("  /db relations       表关联关系管理");
  lines.push("  /db refresh-schema  刷新表结构缓存");

  ctx.ui.notify(lines.join("\n"), "info");
}

// ====== Switch flow ======

async function handleSwitch(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  // --- Step 1: Pick environment ---
  const environments = ws.getEnvironments();
  if (environments.length === 0) {
    ctx.ui.notify(
      "未配置数据库连接。\n" +
        "请在 ~/.pi/database/connections.yaml 中配置连接信息。",
      "error",
    );
    return;
  }

  const envLabels = environments.map((e) => {
    const conns = ws.getConnectionIdsForEnv(e);
    const detail = conns.length === 1 ? ` (${conns[0]})` : ` (${conns.length} connections)`;
    return e + detail;
  });

  const envChoice = await ctx.ui.select("选择环境", envLabels);
  if (!envChoice) return; // user cancelled

  // Extract the bare environment name (strip the detail suffix)
  const env = environments[envLabels.indexOf(envChoice)];

  // --- Step 2: Pick connection (if multiple in same env) ---
  let connectionId: string;
  const connsInEnv = ws.getConnectionIdsForEnv(env);

  if (connsInEnv.length === 1) {
    connectionId = connsInEnv[0];
  } else {
    const connChoice = await ctx.ui.select("选择连接", connsInEnv);
    if (!connChoice) return;
    connectionId = connChoice;
  }

  // --- Step 3: Pick database ---
  const conn = ws.manager.getConfig(connectionId);
  const defaultDb = conn?.defaultDatabase;

  let database: string;

  // Only use default on first connect; re-running /db switch shows full picker
  if (defaultDb && !ws.current) {
    database = defaultDb;
  } else {
    ctx.ui.notify("加载数据库列表...", "info");
    let databases: string[];
    try {
      databases = await ws.getDatabases(connectionId);
    } catch (err: any) {
      ctx.ui.notify(`连接失败：${err.message}`, "error");
      return;
    }

    if (databases.length === 0) {
      ctx.ui.notify(`${connectionId} 上没有找到数据库`, "warning");
      return;
    }

    const choice = await ctx.ui.select("选择数据库", databases);
    if (!choice) return;
    database = choice;
  }

  // --- Step 4: Persist ---
  ws.switchTo(env, connectionId, database);

  // Update status bar + widget
  ctx.ui.setStatus(STATUS_KEY, ws.statusLabel);
  ctx.ui.setWidget(STATUS_KEY, [`🗄 DB: ${env}/${database}`, `连接: ${connectionId}`]);

  // Auto-load or refresh schema cache in background
  const cache = ws.autoLoadSchema();
  if (cache) {
    ctx.ui.notify(
      `已连接：${env}/${database} @ ${connectionId}（缓存 ${cache.tables.length} 个表结构）`,
      "info",
    );
  } else {
    ctx.ui.notify(
      `已连接：${env}/${database} @ ${connectionId}。执行 /db refresh-schema 缓存表结构。`,
      "info",
    );
  }
}

// ====== Tables list ======

async function handleTables(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  let tables: string[];
  try {
    tables = await ws.getTables();
  } catch (err: any) {
    ctx.ui.notify(`加载表列表失败：${err.message}`, "error");
    return;
  }

  if (tables.length === 0) {
    ctx.ui.notify(`${ws.current!.database} 中没有表`, "info");
    return;
  }

  const text = [
    `═══ 表 — ${ws.current!.database} ═══`,
    "",
    ...tables.map((t, i) => `  ${i + 1}. ${t}`),
    "",
    `${tables.length} 个表`,
  ].join("\n");

  ctx.ui.notify(text, "info");
}

// ====== Schema view ======

async function handleSchema(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  table?: string,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  // If no table specified, show tables with optional search filter
  if (!table) {
    let tables: string[];
    try {
      tables = await ws.getTables();
    } catch (err: any) {
      ctx.ui.notify(`加载表列表失败：${err.message}`, "error");
      return;
    }

    if (tables.length === 0) {
      ctx.ui.notify(`${ws.current!.database} 中没有表`, "info");
      return;
    }

    // Search filter
    const keyword = await ctx.ui.input("筛选表名（回车显示全部）", "");
    if (keyword === undefined) return; // user cancelled

    const filtered = keyword?.trim()
      ? tables.filter((t) => t.toLowerCase().includes(keyword.toLowerCase()))
      : tables;

    if (filtered.length === 0) {
      ctx.ui.notify(`未找到匹配 "${keyword}" 的表`, "warning");
      return;
    }

    const choice = await ctx.ui.select(
      `选择表（${filtered.length}/${tables.length}）`,
      filtered,
    );
    if (!choice) return;
    table = choice;
  }

  let result: { columns: Record<string, any>[]; indexes: Record<string, any>[] };
  try {
    result = await ws.getTableSchema(table);
  } catch (err: any) {
    ctx.ui.notify(`加载表结构失败：${err.message}`, "error");
    return;
  }

  // Format columns
  const colRows = result.columns.map((c) => {
    const nullable = c.IS_NULLABLE === "YES" ? "N" : "";
    const key = c.COLUMN_KEY === "PRI" ? "PK" : c.COLUMN_KEY === "MUL" ? "FK" : c.COLUMN_KEY === "UNI" ? "UQ" : "";
    const def = c.COLUMN_DEFAULT ?? "";
    const extra = c.EXTRA ?? "";
    const comment = c.COLUMN_COMMENT ?? "";
    const name = (c.COLUMN_NAME as string).padEnd(25);
    const type = (c.COLUMN_TYPE as string).padEnd(16);
    return `  ${name}${type}${nullable.padEnd(4)}${key.padEnd(3)}${def.padEnd(12)}${extra.padEnd(10)}${comment}`;
  });

  // Group indexes by name
  const idxMap = new Map<string, string[]>();
  for (const idx of result.indexes) {
    const name = idx.INDEX_NAME as string;
    if (!idxMap.has(name)) idxMap.set(name, []);
    idxMap.get(name)!.push(idx.COLUMN_NAME as string);
  }

  const text = [
    `═══ ${table} — ${ws.current!.database} ═══`,
    "",
    "列：",
    `  ${"Name".padEnd(25)}${"Type".padEnd(16)}Null Key Default     Extra     Comment`,
    `  ${"".padEnd(25)}${"".padEnd(16)}---- --- ---------- ---------- -------`,
    ...colRows,
    "",
    `索引（${idxMap.size}）：`,
    ...([...idxMap.entries()].map(([name, cols]) => {
      const unique = result.indexes.find((i) => i.INDEX_NAME === name)?.NON_UNIQUE === 0 ? " [UNIQUE]" : "";
      return `  ${name}${unique}: ${cols.join(", ")}`;
    })),
    "",
  ].join("\n");

  ctx.ui.notify(text, "info");
}

// ====== SQL Query ======

const READONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i;

// ── Column analysis ──────────────────────────────────────────────

interface ColStats { visible: string[]; allNull: string[]; allSame: { col: string; value: string }[] }

function analyzeCols(columns: string[], rows: Record<string, any>[]): ColStats {
  const visible: string[] = [];
  const allNull: string[] = [];
  const allSame: { col: string; value: string }[] = [];
  for (const col of columns) {
    let firstVal: any = undefined, firstSet = false, isAllNull = true, isAllSame = true;
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

function hiddenMsg(stats: ColStats): string {
  const parts: string[] = [];
  if (stats.allNull.length > 0) parts.push(`${stats.allNull.length} cols all-NULL`);
  if (stats.allSame.length > 0) {
    const s = stats.allSame.slice(0, 2).map(x => `${x.col}=${x.value}`).join(", ");
    parts.push(`${stats.allSame.length} cols all-same: ${s}${stats.allSame.length > 2 ? ", …" : ""}`);
  }
  return parts.length > 0 ? `  ⓘ ${parts.join("  |  ")}` : "";
}

function pickId(row: Record<string, any>, cols: string[]): string {
  for (const c of ["id","name","host","user","username","email","key","code"]) {
    const m = cols.find(x => x.toLowerCase() === c);
    if (m && row[m] != null) return String(row[m]);
  }
  return "";
}

function formatResultTable(columns: string[], rows: Record<string, any>[]): string {
  if (rows.length === 0) return "(empty result)";

  const stats = analyzeCols(columns, rows);
  const note = hiddenMsg(stats);
  const cols = stats.visible.length > 0 ? stats.visible : columns;
  const total = rows.length;

  if (cols.length <= 8) return hTable(cols, rows, total, note);
  if (rows.length <= 10) return tTable(cols, rows, total, note);
  return vTable(cols, rows, total, note);
}

// ── Horizontal (≤ 8 cols) ───────────────────────────────────────

function hTable(cols: string[], rows: Record<string, any>[], total: number, note: string): string {
  const MAX_C = 22, MAX_D = 20;
  const dr = rows.slice(0, MAX_D);
  const widths = cols.map(c => {
    let max = Math.min(c.length, MAX_C);
    for (const r of dr) { const l = r[c] === null ? 4 : String(r[c]).length; if (l > max) max = l; }
    return Math.min(max, MAX_C);
  });
  const cell = (v: unknown, w: number) => { const s = v === null ? "NULL" : String(v); return s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w); };

  const lines: string[] = [];
  lines.push("| " + cols.map((c, i) => cell(c, widths[i])).join(" | ") + " |");
  lines.push("|" + widths.map(w => "-".repeat(w + 2)).join("|") + "|");
  for (const r of dr) lines.push("| " + cols.map((c, i) => cell(r[c], widths[i])).join(" | ") + " |");
  if (total > MAX_D) lines.push(`… and ${total - MAX_D} more rows`);
  if (note) lines.push(note);
  return lines.join("\n");
}

// ── Transposed (cols→rows, rows→cols; > 8 cols & ≤ 10 rows) ────

function tTable(cols: string[], rows: Record<string, any>[], total: number, note: string): string {
  const MAX_C = 24, MAX_CELL = 36, MAX_D = 10;
  const dr = rows.slice(0, MAX_D);
  const headers = dr.map((r, i) => {
    const id = pickId(r, cols);
    const label = id ? `#${i + 1} ${id}` : `#${i + 1}`;
    return label.length > 22 ? label.slice(0, 19) + "…" : label;
  });
  const cw = Math.min(MAX_C, Math.max(...cols.map(c => c.length)));
  const cellW = headers.map(h => Math.min(MAX_CELL, h.length));
  const cell = (v: unknown, w: number) => { const s = v === null ? "NULL" : String(v); return s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w); };

  const lines: string[] = [];
  lines.push("  " + "".padEnd(cw) + " │ " + headers.map((h, i) => cell(h, cellW[i])).join(" │ "));
  lines.push("  " + "─".repeat(cw) + "─┼─" + cellW.map(w => "─".repeat(w)).join("─┼─"));
  for (const c of cols) {
    lines.push("  " + c.padEnd(cw) + " │ " + dr.map((r, i) => cell(r[c], cellW[i])).join(" │ "));
  }
  lines.push("");
  lines.push(`${total} rows × ${cols.length} cols shown`);
  if (total > MAX_D) lines.push(`… and ${total - MAX_D} more rows`);
  if (note) lines.push(note);
  return lines.join("\n");
}

// ── Vertical key-value per row (> 8 cols & > 10 rows) ───────────

function vTable(cols: string[], rows: Record<string, any>[], total: number, note: string): string {
  const MAX_D = 5;
  const dr = rows.slice(0, MAX_D);
  const lw = Math.min(28, Math.max(...cols.map(c => c.length)));
  const lines: string[] = [];
  for (let i = 0; i < dr.length; i++) {
    const id = pickId(dr[i], cols);
    lines.push(`─── Row ${i + 1}${id ? `  [${id}]` : ""} ───`);
    for (const c of cols) {
      const v = dr[i][c];
      const s = v === null ? "NULL" : String(v);
      lines.push(`  ${c.padEnd(lw)} │ ${s.length > 60 ? s.slice(0, 57) + "…" : s}`);
    }
    lines.push("");
  }
  if (total > MAX_D) lines.push(`… and ${total - MAX_D} more rows`);
  if (note) lines.push(note);
  return lines.join("\n");
}

// ── Shared: pick a table from the current database ──────────────

async function pickTable(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  prompt: string,
): Promise<string | undefined> {
  let tables: string[];
  try {
    tables = await ws.getTables();
  } catch (err: any) {
    ctx.ui.notify(`加载表列表失败：${err.message}`, "error");
    return undefined;
  }
  if (tables.length === 0) {
    ctx.ui.notify(`${ws.current!.database} 中没有表`, "warning");
    return undefined;
  }

  // First: fuzzy filter via text input (same UX as /db schema)
  const keyword = await ctx.ui.input(`筛选表名（回车显示全部）`, "");
  if (keyword === undefined) return undefined; // cancelled

  const filtered = keyword?.trim()
    ? tables.filter((t) => t.toLowerCase().includes(keyword.toLowerCase()))
    : tables;

  if (filtered.length === 0) {
    ctx.ui.notify(`未找到匹配 "${keyword}" 的表`, "warning");
    return undefined;
  }

  return await ctx.ui.select(prompt, filtered);
}

// ── Execute a query and display / inject results ────────────────

function formatRelatedResults(related: RelatedResult[]): string {
  if (related.length === 0) return "";

  const lines: string[] = ["", "────── 关联表 ──────", ""];
  for (const r of related) {
    lines.push(`### ${r.schema}.${r.table}`);
    lines.push(`关联路径：${r.joinPath}`);
    lines.push(`行数：${r.rowCount}（${r.elapsed}）`);
    lines.push("");
    if (r.rows.length > 0) {
      lines.push(formatResultTable(r.columns, r.rows));
    } else {
      lines.push("（空结果）");
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function executeAndDisplay(
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
    formatResultTable(result.columns, result.rows),
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
    formatResultTable(result.columns, result.rows),
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

// ── Table-first query: pick table → WHERE → auto-generate SQL ───

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
  if (where === undefined) return; // cancelled

  // Check if there are relations for this table
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

// ── /db query entry point ───────────────────────────────────────

async function handleQuery(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  tableArg?: string,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  // /db query <table> — fast path: skip picker, go straight to WHERE
  if (tableArg) {
    let tables: string[];
    try { tables = await ws.getTables(); } catch { tables = []; }
    if (tables.includes(tableArg)) {
      return await queryByTable(ctx, ws, pi, tableArg);
    }
    // Not a table — treat as raw SQL
    if (READONLY_SQL_RE.test(tableArg)) {
      return await executeAndDisplay(ctx, ws, pi, tableArg);
    }
    ctx.ui.notify(`"${tableArg}" 不是已知表名或有效 SQL`, "warning");
    return;
  }

  // No arg → choose mode
  const mode = await ctx.ui.select("查询方式", ["📋 选择数据表", "✏️ 输入 SQL"]);
  if (!mode) return;

  if (mode.startsWith("📋")) {
    return await queryByTable(ctx, ws, pi);
  } else {
    return await queryRaw(ctx, ws, pi);
  }
}

// ====== History ======

async function handleHistory(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  keyword?: string,
): Promise<void> {
  try {
    const filter: { limit: number; keyword?: string } = { limit: 20 };
    if (keyword) filter.keyword = keyword;

    // Scope to current database if connected
    let entries: HistoryEntry[];
    if (ws.current) {
      entries = ws.history.list({ ...filter, database: ws.current.database });
    } else {
      entries = ws.history.list(filter);
    }

    ctx.ui.notify(`History count: ${entries.length}, ws.current=${JSON.stringify(ws.current)}`, "info");

    if (entries.length === 0) {
      ctx.ui.notify(
        keyword ? `未找到包含 "${keyword}" 的查询历史` : "暂无查询历史",
        "info",
      );
      return;
    }

    const rows = entries.map((e) => {
      const sql = e.sql.length > 50 ? e.sql.slice(0, 47) + "..." : e.sql.padEnd(50);
      const time = e.createdTime.replace("T", " ").slice(0, 19);
      return `  ${String(e.id).padEnd(4)}${time}  ${e.database.padEnd(16)}${sql}${String(e.rowCount).padStart(5)}  ${e.elapsed}`;
    });

    const text = [
      keyword
        ? `═══ History — "${keyword}" (${entries.length}) ═══`
        : `═══ History (${entries.length}) ═══`,
      "",
      `  #    时间                 数据库            SQL                                              行数  耗时`,
      `  ---- ------------------- ---------------- -------------------------------------------------- ---- -----`,
      ...rows,
    ].join("\n");

    ctx.ui.notify(text, "info");
  } catch (err: any) {
    ctx.ui.notify(`历史查询出错：${err.message}`, "error");
  }
}



// ====== Schema refresh ======

async function handleRefreshSchema(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  ctx.ui.notify("正在刷新表结构缓存...", "info");

  let snapshot: import("../schema/cache").SchemaSnapshot;
  try {
    snapshot = await ws.refreshSchema();
  } catch (err: any) {
    ctx.ui.notify(`刷新表结构失败：${err.message}`, "error");
    return;
  }

  ctx.ui.notify(
    `已缓存 ${snapshot.tables.length} 个表结构（${ws.current!.database}）`,
    "info",
  );
}

// ====== Favorites ======

function formatFavoriteList(entries: FavoriteEntry[], currentDb?: string): string {
  if (entries.length === 0) {
    return currentDb
      ? `暂无收藏（${currentDb}）。使用 /db favorite add 添加。`
      : "暂无收藏。使用 /db favorite add 添加。";
  }

  const scope = currentDb ? `（${currentDb} + 全局）` : "（全局）";
  const lines = [
    `═══ 收藏查询 ${scope} — ${entries.length} 条 ═══`,
    "",
  ];

  for (const e of entries) {
    const sql = e.sql.length > 55 ? e.sql.slice(0, 52) + "..." : e.sql;
    const dbTag = e.database ? `[${e.database}]` : "[🌐 全局]";
    const desc = e.description ? ` — ${e.description.slice(0, 30)}` : "";
    lines.push(`  #${String(e.id).padStart(3)} ${e.name.padEnd(18)}${dbTag.padEnd(14)}${sql}`);
    if (desc) lines.push(`       ${desc}`);
  }

  lines.push("");
  lines.push("选择一个 # 执行、编辑或删除。");

  return lines.join("\n");
}

async function handleFavorite(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  rest: string[],
): Promise<void> {
  const action = rest[0];

  // /db favorite add [name] [sql]
  if (action === "add") {
    return await handleFavoriteAdd(ctx, ws, pi, rest.slice(1));
  }

  // /db favorite — list and select
  return await handleFavoriteList(ctx, ws, pi);
}

async function handleFavoriteAdd(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  args: string[],
): Promise<void> {
  let name: string | undefined;
  let sql: string | undefined;

  // Fast path: /db favorite add <name> <sql>
  if (args.length >= 2) {
    name = args[0];
    sql = args.slice(1).join(" ");
  } else if (args.length === 1) {
    // One arg — could be name or sql, ambiguous; prompt for both
    const nameOrSql = args[0];
    // If it looks like SQL, treat as sql and prompt for name
    if (/^(SELECT|SHOW|DESCRIBE|EXPLAIN)/i.test(nameOrSql)) {
      sql = nameOrSql;
    } else {
      name = nameOrSql;
    }
  }

  // Prompt for name if not provided
  if (!name) {
    name = await ctx.ui.input("收藏名称", "");
    if (!name || !name.trim()) return;
    name = name.trim();
  }

  // Prompt for SQL if not provided — prefill with last executed SQL
  if (!sql) {
    sql = await ctx.ui.input("SQL 模板", ws.lastSql ?? "SELECT * FROM ...");
    if (!sql || !sql.trim()) return;
    sql = sql.trim();
  }

  // Optional description
  const description = await ctx.ui.input("描述（可选，回车跳过）", "");
  if (description === undefined) return; // cancelled

  const entry = ws.saveFavorite(name, sql, description?.trim());

  ctx.ui.notify(
    `已收藏 #${entry.id} "${entry.name}"${entry.database ? ` [${entry.database}]` : " [🌐 全局]"}`,
    "info",
  );
}

async function handleFavoriteList(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  const entries = ws.getFavorites();

  if (entries.length === 0) {
    ctx.ui.notify(
      formatFavoriteList([], ws.current?.database),
      "info",
    );
    return;
  }

  const text = formatFavoriteList(entries, ws.current?.database);

  // Build selection labels: id + name + sql preview
  const labels = entries.map((e) => {
    const sql = e.sql.length > 40 ? e.sql.slice(0, 37) + "..." : e.sql.padEnd(40);
    return `#${String(e.id).padStart(3)} ${e.name.padEnd(18)} ${sql}`;
  });

  const choice = await ctx.ui.select("选择一个收藏", labels);
  if (!choice) return;

  const idx = labels.indexOf(choice);
  const entry = entries[idx];

  // Show actions
  const action = await ctx.ui.select(
    `#${entry.id} ${entry.name}`,
    ["▶ 直接执行", "✏️ 编辑后执行", "🗑 删除"],
  );
  if (!action) return;

  if (action === "▶ 直接执行") {
    await executeAndDisplay(ctx, ws, pi, entry.sql);
  } else if (action === "✏️ 编辑后执行") {
    ctx.ui.notify(`原始 SQL：\n${entry.sql}`, "info");
    const editedSql = await ctx.ui.input("编辑 SQL（对照上方原文修改）");
    if (!editedSql || !editedSql.trim()) return;
    if (!READONLY_SQL_RE.test(editedSql.trim())) {
      ctx.ui.notify(
        `仅允许只读 SQL（SELECT、SHOW、DESCRIBE、EXPLAIN）`,
        "error",
      );
      return;
    }
    await executeAndDisplay(ctx, ws, pi, editedSql.trim());
  } else if (action === "🗑 删除") {
    const confirm = await ctx.ui.select(
      `确认删除 "${entry.name}"？`,
      ["取消", "确认删除"],
    );
    if (confirm === "确认删除") {
      ws.favorites.delete(entry.id);
      ctx.ui.notify(`已删除收藏 #${entry.id} "${entry.name}"`, "info");
    }
  }
}

// ====== Relations ======

function formatRelationsList(rows: RelationRow[]): string {
  if (rows.length === 0) return "暂无表关联关系。";

  const lines = [
    `═══ 表关联关系 — ${rows.length} 条 ═══`,
    "",
  ];

  for (const r of rows) {
    const src = `${r.schema}.${r.table_name}.${r.column_name}`;
    const ref = `${r.ref_schema}.${r.ref_table}.${r.ref_column}`;
    const cond = r.condition ? ` [${r.condition}]` : "";
    lines.push(`  #${String(r.id).padStart(3)} ${src} → ${ref} (${r.relation_type})${cond}`);
  }

  return lines.join("\n");
}

async function handleRelations(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  rest: string[],
): Promise<void> {
  const sub = rest[0];

  switch (sub) {
    case "add":
      return await handleRelationsAdd(ctx, ws, pi);
    case "remove":
      return await handleRelationsRemove(ctx, ws, pi);
    case "discover":
      return await handleRelationsDiscover(ctx, ws, pi);
    case "er-diagram":
      return await handleRelationsERDiagram(ctx, ws, rest[1]);
    default:
      return await handleRelationsList(ctx, ws, pi);
  }
}

async function handleRelationsList(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  const rows = ws.getRelations();

  if (rows.length === 0) {
    ctx.ui.notify(
      formatRelationsList([]),
      "info",
    );
    return;
  }

  // Build labels for selection
  const labels = rows.map((r) => {
    const src = `${r.table_name}.${r.column_name}`;
    const ref = `${r.ref_table}.${r.ref_column}`;
    const cond = r.condition ? ` [${r.condition}]` : "";
    return `#${String(r.id).padStart(3)} ${src.padEnd(24)} → ${ref} (${r.relation_type})${cond}`;
  });

  const choice = await ctx.ui.select("选择一个关系", labels);
  if (!choice) return;

  const idx = labels.indexOf(choice);
  const entry = rows[idx];

  const action = await ctx.ui.select(
    `#${entry.id} ${entry.table_name}.${entry.column_name} → ${entry.ref_table}.${entry.ref_column}`,
    ["🗑 删除", "取消"],
  );

  if (action === "🗑 删除") {
    const confirm = await ctx.ui.select(
      `确认删除这个关系？`,
      ["取消", "确认删除"],
    );
    if (confirm === "确认删除") {
      ws.relationGraph.removeById(entry.id);
      ctx.ui.notify(
        `已删除关系 #${entry.id} ${entry.table_name}.${entry.column_name} → ${entry.ref_table}.${entry.ref_column}`,
        "info",
      );
    }
  }
}

async function handleRelationsAdd(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  const schema = ws.current!.database;

  // Step 1: pick source table
  const srcTable = await pickTable(ctx, ws, "选择源表");
  if (!srcTable) return;

  // Step 2: pick source column (from schema cache)
  let srcColumns: string[] = [];
  try {
    const schemaInfo = await ws.getTableSchema(srcTable);
    srcColumns = schemaInfo.columns.map((c: Record<string, any>) => c.COLUMN_NAME as string);
  } catch {
    ctx.ui.notify(`无法获取 ${srcTable} 的列信息`, "error");
    return;
  }

  const srcCol = await ctx.ui.select("选择源表列", srcColumns);
  if (!srcCol) return;

  // Step 3: pick target table
  const refTable = await pickTable(ctx, ws, "选择关联表");
  if (!refTable) return;

  // Step 4: pick target column
  let refColumns: string[] = [];
  try {
    const schemaInfo = await ws.getTableSchema(refTable);
    refColumns = schemaInfo.columns.map((c: Record<string, any>) => c.COLUMN_NAME as string);
  } catch {
    ctx.ui.notify(`无法获取 ${refTable} 的列信息`, "error");
    return;
  }

  const refCol = await ctx.ui.select("选择关联表列", refColumns);
  if (!refCol) return;

  // Step 5: optional condition
  const condition = await ctx.ui.input("关联条件（可选，如 type=1，回车跳过）", "");
  if (condition === undefined) return;

  // Step 6: relation type
  const relationType = await ctx.ui.select(
    "关系类型",
    ["MANY_TO_ONE", "ONE_TO_MANY", "ONE_TO_ONE", "MANY_TO_MANY"],
  );
  if (!relationType) return;

  const row = ws.relationGraph.register(
    { schema, table: srcTable, column: srcCol, condition: condition.trim() || undefined },
    { schema, table: refTable, column: refCol },
    relationType,
  );

  ctx.ui.notify(
    `已添加关系 #${row.id}: ${srcTable}.${srcCol} → ${refTable}.${refCol} (${relationType})`,
    "info",
  );
}

async function handleRelationsRemove(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  const rows = ws.getRelations();
  if (rows.length === 0) {
    ctx.ui.notify("暂无表关联关系", "info");
    return;
  }

  const labels = rows.map((r) => {
    const src = `${r.table_name}.${r.column_name}`;
    const ref = `${r.ref_table}.${r.ref_column}`;
    return `#${String(r.id).padStart(3)} ${src.padEnd(24)} → ${ref} (${r.relation_type})`;
  });

  const choice = await ctx.ui.select("选择要删除的关系", labels);
  if (!choice) return;

  const idx = labels.indexOf(choice);
  const entry = rows[idx];

  const confirm = await ctx.ui.select(
    `确认删除 "${entry.table_name}.${entry.column_name} → ${entry.ref_table}.${entry.ref_column}"？`,
    ["取消", "确认删除"],
  );

  if (confirm === "确认删除") {
    ws.relationGraph.removeById(entry.id);
    ctx.ui.notify(
      `已删除关系 #${entry.id}`,
      "info",
    );
  }
}

async function handleRelationsDiscover(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  const schema = ws.current!.database;
  const connectionId = ws.current!.connectionId;

  // Step 1: Sync foreign keys from information_schema
  let fkCount = 0;
  try {
    const pool = ws.manager.getPool(connectionId);
    const fkSql = `
      SELECT
        TABLE_SCHEMA,
        TABLE_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_SCHEMA,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND REFERENCED_COLUMN_NAME IS NOT NULL
    `;
    const [rows] = await pool.query(fkSql, [schema]) as [Record<string, any>[], any];

    const fkRelations: import("../types").ColumnRelation[] = rows.map((row: Record<string, any>) => ({
      schema: row.TABLE_SCHEMA as string,
      table: row.TABLE_NAME as string,
      column: row.COLUMN_NAME as string,
      condition: "",
      refSchema: (row.REFERENCED_TABLE_SCHEMA ?? schema) as string,
      refTable: row.REFERENCED_TABLE_NAME as string,
      refColumn: row.REFERENCED_COLUMN_NAME as string,
      relationType: "MANY_TO_ONE",
    }));

    fkCount = ws.relationGraph.mergeForeignKeys(fkRelations);
  } catch (err: any) {
    ctx.ui.notify(`外键同步失败：${err.message}`, "warning");
    // Continue to AI analysis even if FK sync fails
  }

  const parts: string[] = [];
  if (fkCount > 0) parts.push(`发现 ${fkCount} 个外键关系，已自动保存`);
  else parts.push("未发现外键关系");

  // Step 2: AI analysis via pi model
  const useAI = await ctx.ui.select(
    "是否使用 AI 分析表关系？",
    ["🤖 是，AI 分析", "⏭ 跳过"],
  );

  if (useAI?.startsWith("🤖")) {
    // Build mermaid ER diagram
    let tables: string[];
    try { tables = await ws.getTables(); } catch { tables = []; }

    if (tables.length > 0) {
      // Generate simple ER diagram (tables with columns, no relation lines)
      const erLines: string[] = ["erDiagram"];
      const MAX_TABLES = 30;
      const sampleTables = tables.slice(0, MAX_TABLES);

      for (const t of sampleTables) {
        try {
          const info = await ws.getTableSchema(t);
          erLines.push(`  "${t}" {`);
          for (const col of info.columns) {
            const colName = col.COLUMN_NAME as string;
            const colType = col.COLUMN_TYPE as string;
            const comment = col.COLUMN_COMMENT ? ` "${col.COLUMN_COMMENT}"` : "";
            erLines.push(`    ${colType} ${colName}${comment}`);
          }
          erLines.push(`  }`);
        } catch {
          // skip tables we can't read
        }
      }

      if (tables.length > MAX_TABLES) {
        erLines.push(`  "…还有${tables.length - MAX_TABLES}张表" {}`);
      }

      const erDiagram = erLines.join("\n");

      // Send to AI for analysis
      ctx.ui.notify("正在通过 AI 分析表关系…", "info");

      pi.sendMessage(
        {
          customType: "db-relation-discover",
          content: [
            `请分析以下数据库 ${schema} 的 mermaid ER 图，找出表之间可能的关联关系。`,
            ``,
            `规则：`,
            `1. 根据列名匹配（如 users.id ↔ orders.user_id, dept_no ↔ dept_no）`,
            `2. 根据列注释或列名语义推断`,
            `3. 每对关系推断一个 relationType：MANY_TO_ONE / ONE_TO_MANY / ONE_TO_ONE / MANY_TO_MANY`,
            `4. 如果有分类型关联条件（如 type=1），请标注 condition`,
            ``,
            `请以 JSON 数组格式输出，每个元素：`,
            `{"table":"源表","column":"源列","refTable":"目标表","refColumn":"目标列","relationType":"MANY_TO_ONE","condition":""}`,
            ``,
            `ER 图：`,
            "```mermaid",
            erDiagram,
            "```",
          ].join("\n"),
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  }

  ctx.ui.notify(parts.join("\n"), "info");
}

async function handleRelationsERDiagram(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  table?: string,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  const schema = ws.current!.database;

  // If no table specified, pick one
  if (!table) {
    const picked = await pickTable(ctx, ws, "选择表");
    if (!picked) return;
    table = picked;
  }

  // Get table schema info
  let tableColumns: Record<string, any>[] = [];
  try {
    const info = await ws.getTableSchema(table);
    tableColumns = info.columns;
  } catch {
    ctx.ui.notify(`无法获取 ${table} 的表结构`, "error");
    return;
  }

  // Get relations
  const relations = ws.getRelations(table);
  const relatedTableNames = new Set<string>();
  for (const r of relations) {
    relatedTableNames.add(r.ref_table);
    relatedTableNames.add(r.table_name);
  }

  // Fetch schemas for all related tables
  const allColumns = new Map<string, Record<string, any>[]>();
  allColumns.set(table, tableColumns);
  for (const relatedTable of relatedTableNames) {
    if (relatedTable === table) continue;
    try {
      const info = await ws.getTableSchema(relatedTable);
      allColumns.set(relatedTable, info.columns);
    } catch {
      // skip
    }
  }

  // Build mermaid ER diagram
  const lines: string[] = ["erDiagram"];

  // Relations
  for (const r of relations) {
    const label = r.condition
      ? `${r.column_name} → ${r.ref_column} [${r.condition}]`
      : `${r.column_name} → ${r.ref_column}`;
    lines.push(`  "${r.table_name}" ||--o{ "${r.ref_table}" : "${label}"`);
  }

  // Table definitions
  const drawn = new Set<string>();
  for (const [tbl, cols] of allColumns) {
    if (drawn.has(tbl)) continue;
    drawn.add(tbl);
    lines.push(`  "${tbl}" {`);
    for (const col of cols) {
      const colName = col.COLUMN_NAME as string;
      const colType = col.COLUMN_TYPE as string;
      const comment = col.COLUMN_COMMENT ? ` "${col.COLUMN_COMMENT}"` : "";
      lines.push(`    ${colType} ${colName}${comment}`);
    }
    lines.push(`  }`);
  }

  const erDiagram = lines.join("\n");

  ctx.ui.notify(
    `═══ ER 图 — ${table} ═══\n\n${erDiagram}`,
    "info",
  );
}

// ====== Status bar helpers ======

/** Restore status bar on session start. */
export function restoreStatusBar(ws: DatabaseWorkspaceService, ctx: { ui: { setStatus(key: string, text: string | undefined): void; setWidget(key: string, lines: string[] | undefined): void } }): void {
  if (ws.isReady()) {
    ctx.ui.setStatus(STATUS_KEY, ws.statusLabel);
    ctx.ui.setWidget(STATUS_KEY, [
      `🗄 DB：${ws.current!.environment}/${ws.current!.database}`,
      `连接：${ws.current!.connectionId}`,
    ]);
  }
}
