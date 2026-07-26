/**
 * /db switch — environment → connection → database selection.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

export const STATUS_KEY = "db-workspace";

export async function showWorkspacePanel(
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

export async function handleSwitch(
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
  if (!envChoice) return;

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
  const conn = ws.getConnectionConfig(connectionId);
  const defaultDb = conn?.defaultDatabase;

  let database: string;

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

  ctx.ui.setStatus(STATUS_KEY, ws.statusLabel);
  ctx.ui.setWidget(STATUS_KEY, [`🗄 DB: ${env}/${database}`, `连接: ${connectionId}`]);

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
