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
import type { HistoryEntry } from "../history/store";

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
      "Database workspace: /db (panel) | /db switch | /db tables | /db schema <table> | /db query [table] | /db history | /db refresh-schema",

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
        case "refresh-schema":
          await handleRefreshSchema(ctx, ws);
          break;
        default:
          ctx.ui.notify(
            `未知命令: ${sub}。可用：switch, tables, schema, query, history, refresh-schema`,
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
  const subcommands = ["switch", "tables", "schema", "query", "history", "refresh-schema"];
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

  let sql = `SELECT * FROM \`${table}\``;
  if (where.trim()) {
    sql += ` WHERE ${where.trim()}`;
  }
  sql += ` LIMIT 100`;

  await executeAndDisplay(ctx, ws, pi, sql);
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
