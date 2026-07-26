/**
 * /db favorite — manage saved query templates.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { FavoriteEntry } from "../history/store";
import { READONLY_SQL_RE } from "../connection/sql-policy";
import { executeAndDisplay } from "./query";

// ── List formatting ─────────────────────────────────────────────

function formatFavoriteList(entries: FavoriteEntry[], currentDb?: string): string {
  if (entries.length === 0) {
    return currentDb
      ? `暂无收藏（${currentDb}）。使用 /db favorite add 添加。`
      : "暂无收藏。使用 /db favorite add 添加。";
  }

  const scope = currentDb ? `（${currentDb} + 全局）` : "（全局）";
  const lines = [`═══ 收藏查询 ${scope} — ${entries.length} 条 ═══`, ""];

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

// ── Entry point ─────────────────────────────────────────────────

export async function handleFavorite(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  rest: string[],
): Promise<void> {
  const action = rest[0];

  if (action === "add") {
    return await handleFavoriteAdd(ctx, ws, pi, rest.slice(1));
  }

  return await handleFavoriteList(ctx, ws, pi);
}

// ── Add ─────────────────────────────────────────────────────────

async function handleFavoriteAdd(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  args: string[],
): Promise<void> {
  let name: string | undefined;
  let sql: string | undefined;

  if (args.length >= 2) {
    name = args[0];
    sql = args.slice(1).join(" ");
  } else if (args.length === 1) {
    const nameOrSql = args[0];
    if (READONLY_SQL_RE.test(nameOrSql)) {
      sql = nameOrSql;
    } else {
      name = nameOrSql;
    }
  }

  if (!name) {
    name = await ctx.ui.input("收藏名称", "");
    if (!name || !name.trim()) return;
    name = name.trim();
  }

  if (!sql) {
    sql = await ctx.ui.input("SQL 模板", ws.lastSql ?? "SELECT * FROM ...");
    if (!sql || !sql.trim()) return;
    sql = sql.trim();
  }

  const description = await ctx.ui.input("描述（可选，回车跳过）", "");
  if (description === undefined) return;

  const entry = ws.saveFavorite(name, sql, description?.trim());

  ctx.ui.notify(
    `已收藏 #${entry.id} "${entry.name}"${entry.database ? ` [${entry.database}]` : " [🌐 全局]"}`,
    "info",
  );
}

// ── List & select ───────────────────────────────────────────────

async function handleFavoriteList(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  const entries = ws.listFavorites();

  if (entries.length === 0) {
    ctx.ui.notify(formatFavoriteList([], ws.current?.database), "info");
    return;
  }

  const labels = entries.map((e) => {
    const sql = e.sql.length > 40 ? e.sql.slice(0, 37) + "..." : e.sql.padEnd(40);
    return `#${String(e.id).padStart(3)} ${e.name.padEnd(18)} ${sql}`;
  });

  const choice = await ctx.ui.select("选择一个收藏", labels);
  if (!choice) return;

  const idx = labels.indexOf(choice);
  const entry = entries[idx];

  const action = await ctx.ui.select(`#${entry.id} ${entry.name}`, [
    "▶ 直接执行",
    "✏️ 编辑后执行",
    "🗑 删除",
  ]);
  if (!action) return;

  if (action === "▶ 直接执行") {
    await executeAndDisplay(ctx, ws, pi, entry.sql);
  } else if (action === "✏️ 编辑后执行") {
    ctx.ui.notify(`原始 SQL：\n${entry.sql}`, "info");
    const editedSql = await ctx.ui.input("编辑 SQL（对照上方原文修改）");
    if (!editedSql || !editedSql.trim()) return;
    // No pre-validation — the executor enforces the read-only guard.
    await executeAndDisplay(ctx, ws, pi, editedSql.trim());
  } else if (action === "🗑 删除") {
    const confirm = await ctx.ui.select(`确认删除 "${entry.name}"？`, ["取消", "确认删除"]);
    if (confirm === "确认删除") {
      ws.deleteFavorite(entry.id);
      ctx.ui.notify(`已删除收藏 #${entry.id} "${entry.name}"`, "info");
    }
  }
}
