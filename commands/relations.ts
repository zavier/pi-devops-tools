/**
 * /db relations —— 表关系管理。
 *
 * 子命令：add、remove、discover（FK 同步）、er-diagram。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { SqlRow, StoredRelation } from "../types";
import { pickTableFuzzy, withLoader } from "./utils";

// ── 列表格式化 ─────────────────────────────────────────────

export function formatRelationsList(rows: StoredRelation[]): string {
  if (rows.length === 0) return "暂无表关联关系。";

  const lines = [`═══ 表关联关系 — ${rows.length} 条 ═══`, ""];

  for (const r of rows) {
    const src = `${r.schema}.${r.table}.${r.column}`;
    const ref = `${r.refSchema}.${r.refTable}.${r.refColumn}`;
    const cond = r.condition ? ` [${r.condition}]` : "";
    lines.push(`  #${String(r.id).padStart(3)} ${src} → ${ref} (${r.relationType})${cond}`);
  }

  return lines.join("\n");
}

// ── 入口 ─────────────────────────────────────────────────

export async function handleRelations(
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
      return await handleRelationsERDiagram(ctx, ws, pi, rest[1]);
    default:
      return await handleRelationsList(ctx, ws, pi);
  }
}

// ── 列表 ────────────────────────────────────────────────────────

async function handleRelationsList(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  _pi: ExtensionAPI,
): Promise<void> {
  const rows = ws.listRelations();

  if (rows.length === 0) {
    ctx.ui.notify(formatRelationsList([]), "info");
    return;
  }

  const labels = rows.map((r) => {
    const src = `${r.table}.${r.column}`;
    const ref = `${r.refTable}.${r.refColumn}`;
    const cond = r.condition ? ` [${r.condition}]` : "";
    return `#${String(r.id).padStart(3)} ${src.padEnd(24)} → ${ref} (${r.relationType})${cond}`;
  });

  const choice = await ctx.ui.select("选择一个关系", labels);
  if (!choice) return;

  const idx = labels.indexOf(choice);
  const entry = rows[idx];

  const action = await ctx.ui.select(
    `#${entry.id} ${entry.table}.${entry.column} → ${entry.refTable}.${entry.refColumn}`,
    ["🗑 删除", "取消"],
  );

  if (action === "🗑 删除") {
    const ok = await ctx.ui.confirm(
      "确认删除",
      `#${entry.id} ${entry.table}.${entry.column} → ${entry.refTable}.${entry.refColumn}`,
    );
    if (ok) {
      ws.removeRelation(entry.id);
      ctx.ui.notify(
        `已删除关系 #${entry.id} ${entry.table}.${entry.column} → ${entry.refTable}.${entry.refColumn}`,
        "info",
      );
    }
  }
}

// ── 添加 ─────────────────────────────────────────────────────────

async function handleRelationsAdd(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  _pi: ExtensionAPI,
): Promise<void> {
  if (!ws.isReady) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  const srcTable = await pickTableFuzzy(ctx, ws, "选择源表");
  if (!srcTable) return;

  let srcColumns: string[] = [];
  try {
    const schemaInfo = await ws.getTableSchema(srcTable);
    srcColumns = schemaInfo.columns.map((c: SqlRow) => c.COLUMN_NAME as string);
  } catch {
    ctx.ui.notify(`无法获取 ${srcTable} 的列信息`, "error");
    return;
  }

  const srcCol = await ctx.ui.select("选择源表列", srcColumns);
  if (!srcCol) return;

  const refTable = await pickTableFuzzy(ctx, ws, "选择关联表");
  if (!refTable) return;

  let refColumns: string[] = [];
  try {
    const schemaInfo = await ws.getTableSchema(refTable);
    refColumns = schemaInfo.columns.map((c: SqlRow) => c.COLUMN_NAME as string);
  } catch {
    ctx.ui.notify(`无法获取 ${refTable} 的列信息`, "error");
    return;
  }

  const refCol = await ctx.ui.select("选择关联表列", refColumns);
  if (!refCol) return;

  const condition = await ctx.ui.input("关联条件（可选，如 type=1，回车跳过）", "");
  if (condition === undefined) return;

  const relationType = await ctx.ui.select("关系类型", [
    "MANY_TO_ONE",
    "ONE_TO_MANY",
    "ONE_TO_ONE",
    "MANY_TO_MANY",
  ]);
  if (!relationType) return;

  const row = ws.upsertRelation(srcTable, srcCol, refTable, refCol, {
    condition: condition.trim() || undefined,
    relationType,
  });

  ctx.ui.notify(
    `已添加关系 #${row.id}: ${srcTable}.${srcCol} → ${refTable}.${refCol} (${relationType})`,
    "info",
  );
}

// ── 删除 ──────────────────────────────────────────────────────

async function handleRelationsRemove(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  _pi: ExtensionAPI,
): Promise<void> {
  const rows = ws.listRelations();
  if (rows.length === 0) {
    ctx.ui.notify("暂无表关联关系", "info");
    return;
  }

  const labels = rows.map((r) => {
    const src = `${r.table}.${r.column}`;
    const ref = `${r.refTable}.${r.refColumn}`;
    return `#${String(r.id).padStart(3)} ${src.padEnd(24)} → ${ref} (${r.relationType})`;
  });

  const choice = await ctx.ui.select("选择要删除的关系", labels);
  if (!choice) return;

  const idx = labels.indexOf(choice);
  const entry = rows[idx];

  const ok = await ctx.ui.confirm(
    "确认删除",
    `"${entry.table}.${entry.column} → ${entry.refTable}.${entry.refColumn}"？`,
  );

  if (ok) {
    ws.removeRelation(entry.id);
    ctx.ui.notify(`已删除关系 #${entry.id}`, "info");
  }
}

// ── Discover（FK 同步）─────────────────────────────────────────

async function handleRelationsDiscover(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  if (!ws.isReady) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  const schema = ws.current!.database;

  let fkCount = 0;
  const fkResult = await withLoader(
    ctx,
    "同步外键关系…",
    (_signal) => ws.discoverForeignKeys(),
    (err) => ctx.ui.notify(`外键同步失败：${err.message}`, "warning"),
  );
  if (fkResult !== undefined) fkCount = fkResult;

  const parts: string[] = [];
  if (fkCount > 0) parts.push(`发现 ${fkCount} 个外键关系，已自动保存`);
  else parts.push("未发现外键关系");

  const useAI = await ctx.ui.select("是否使用 AI 分析表关系？", ["🤖 是，AI 分析", "⏭ 跳过"]);

  if (useAI?.startsWith("🤖")) {
    let tables: string[];
    try {
      tables = await ws.getTables();
    } catch {
      tables = [];
    }

    if (tables.length > 0) {
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
          // 跳过
        }
      }

      if (tables.length > MAX_TABLES) {
        erLines.push(`  "…还有${tables.length - MAX_TABLES}张表" {}`);
      }

      const erDiagram = erLines.join("\n");

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
            `对每一对确认的关系，先调用 db_relation 工具保存（action="register", table / column / refTable / refColumn / relationType / condition）。`,
            `如果 db_relation 当前不可用，先调用 db_tools 工具（query: "relations"）启用它，再调用 db_relation。`,
            `仅当 db_tools 也不可用时，再以 JSON 数组格式输出，每个元素：`,
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

// ── ER 图 ──────────────────────────────────────────────────

async function handleRelationsERDiagram(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  table?: string,
): Promise<void> {
  if (!ws.isReady) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  if (!table) {
    const picked = await pickTableFuzzy(ctx, ws, "选择表");
    if (!picked) return;
    table = picked;
  }

  let tableColumns: SqlRow[] = [];
  try {
    const info = await ws.getTableSchema(table);
    tableColumns = info.columns;
  } catch {
    ctx.ui.notify(`无法获取 ${table} 的表结构`, "error");
    return;
  }

  const relations = ws.listRelations(table);
  const relatedTableNames = new Set<string>();
  for (const r of relations) {
    relatedTableNames.add(r.refTable);
    relatedTableNames.add(r.table);
  }

  const allColumns = new Map<string, SqlRow[]>();
  allColumns.set(table, tableColumns);
  for (const relatedTable of relatedTableNames) {
    if (relatedTable === table) continue;
    try {
      const info = await ws.getTableSchema(relatedTable);
      allColumns.set(relatedTable, info.columns);
    } catch {
      // 跳过
    }
  }

  const lines: string[] = ["erDiagram"];

  for (const r of relations) {
    const label = r.condition
      ? `${r.column} → ${r.refColumn} [${r.condition}]`
      : `${r.column} → ${r.refColumn}`;
    lines.push(`  "${r.table}" ||--o{ "${r.refTable}" : "${label}"`);
  }

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

  // display: true → 在聊天中持久显示；默认 markdown 渲染器
  // 把 mermaid 源码显示为代码块，LLM 也能读取。
  // deliverAs "followUp" 在 agent 空闲时立即提交。
  pi.sendMessage(
    {
      customType: "db-er-diagram",
      content: [`## ER 图 — ${table}`, "", "```mermaid", erDiagram, "```"].join("\n"),
      display: true,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}
