/**
 * /db switch — environment → connection → database selection.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { withLoader } from "./utils";

export const STATUS_KEY = "db-workspace";

export async function showWorkspacePanel(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi?: ExtensionAPI,
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
    if (ws.isConfigured) {
      lines.push(`可用环境：${ws.getEnvironments().join(", ")}`);
    } else {
      lines.push("⚠️  尚未配置数据库连接");
      lines.push("");
      lines.push(`配置文件：${ws.configPath}`);
      lines.push("");
      lines.push("配置示例：");
      lines.push("  connections:");
      lines.push("    my-db:");
      lines.push("      environment: prod");
      lines.push("      type: mysql");
      lines.push("      host: 127.0.0.1");
      lines.push("      port: 3306");
      lines.push("      username: root");
      lines.push("      password: ${DB_PASSWORD}");
    }
  }

  // Show config warnings (e.g. unresolved env vars)
  const warnings = ws.getConfigWarnings();
  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) {
      lines.push(`⚠ ${w}`);
    }
  }

  lines.push("");
  lines.push("命令：");
  lines.push("  /db switch          选择环境和数据库");
  lines.push("  /db add             添加新连接");
  lines.push("  /db tables          列出所有表");
  lines.push("  /db schema <表名>   查看表结构");
  lines.push("  /db query [表名]    选表 → WHERE → 查询");
  lines.push("  /db history         查询历史");
  lines.push("  /db favorite        收藏的查询模板");
  lines.push("  /db relations       表关联关系管理");

  // Visible panel for the user (raw-text renderer).
  if (pi) {
    pi.sendMessage(
      {
        customType: "db-workspace-panel",
        content: lines.join("\n"),
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
  }

  // Silent hint for the LLM when no connections are configured.
  // display: false keeps it out of the chat; triggerTurn makes the AI
  // proactively offer to help set up the first connection.
  if (!ws.isConfigured && pi) {
    pi.sendMessage(
      {
        customType: "db-hint",
        content: `No database connections are configured yet. Help the user create their first connection in ${ws.configPath}. Ask for host, port, username, password, and default database name. After the config file is written, tell the user to run /db switch to connect.`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }
}

export async function handleSwitch(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  // If no connections are loaded yet (e.g. config file was just created by AI),
  // hot-reload from disk so the user doesn't need /reload.
  if (!ws.isConfigured) {
    ws.reloadConfig();
  }

  // --- Step 1: Pick environment ---
  const environments = ws.getEnvironments();
  if (environments.length === 0) {
    ctx.ui.notify(
      "未配置数据库连接。\n请在 ~/.pi/database/connections.yaml 中配置连接信息。",
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

  let database: string | undefined;

  if (defaultDb) {
    const useDefault = await ctx.ui.confirm(
      "默认数据库",
      `连接 "${connectionId}" 配置了默认数据库 "${defaultDb}"。\n\n是否直接使用？\n选"否"则手动选择其他数据库。`,
    );
    if (useDefault === undefined) return; // Esc
    if (useDefault) {
      database = defaultDb;
    }
  }

  if (!database) {
    const databases = await withLoader(
      ctx,
      "加载数据库列表…",
      (_signal) => ws.getDatabases(connectionId),
      (err) => ctx.ui.notify(`连接失败：${err.message}`, "error"),
    );
    if (!databases) return;

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
  ctx.ui.setWidget(STATUS_KEY, [`🗄 ${env}/${database}  @${connectionId}`]);

  // Tell the LLM which database is active so it doesn't have to guess.
  // display: false avoids cluttering the chat with a redundant message.
  pi.sendMessage(
    {
      customType: "db-active-db",
      content: `Current database: ${database} (connection: ${connectionId}, environment: ${env}). Use db_query and db_tables to query this database.`,
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );

  ctx.ui.notify(`已连接：${env}/${database} @ ${connectionId}`, "info");
}
