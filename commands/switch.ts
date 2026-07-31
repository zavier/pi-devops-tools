/**
 * /db switch —— 环境 → 连接 → 数据库选择。
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

  // 显示配置警告（如未解析的 env 变量）
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

  // 用户可见的面板（纯文本渲染器）。
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

  // 未配置连接时给 LLM 的静默提示。
  // display: false 让它不进聊天；triggerTurn 让 AI
  // 主动提议帮助建立第一个连接。
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
  // 如果尚未加载任何连接（例如 AI 刚创建了配置文件），
  // 从磁盘热重载，用户无需 /reload。
  if (!ws.isConfigured) {
    ws.reloadConfig();
  }

  // --- 第 1 步：选择环境 ---
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

  // --- 第 2 步：选择连接（同环境有多个时）---
  let connectionId: string;
  const connsInEnv = ws.getConnectionIdsForEnv(env);

  if (connsInEnv.length === 1) {
    connectionId = connsInEnv[0];
  } else {
    const connChoice = await ctx.ui.select("选择连接", connsInEnv);
    if (!connChoice) return;
    connectionId = connChoice;
  }

  // --- 第 3 步：选择数据库 ---
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

  // --- 第 4 步：持久化 ---
  ws.switchTo(env, connectionId, database);

  ctx.ui.setStatus(STATUS_KEY, ws.statusLabel);
  ctx.ui.setWidget(STATUS_KEY, [`🗄 ${env}/${database}  @${connectionId}`]);

  // 告知 LLM 当前激活的数据库，避免它猜测。
  // display: false 避免冗余消息污染聊天。
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
