/**
 * /db switch — environment → connection → database selection.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

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
  lines.push("  /db tables          列出所有表");
  lines.push("  /db schema <表名>   查看表结构");
  lines.push("  /db query [表名]    选表 → WHERE → 查询");
  lines.push("  /db history         查询历史");
  lines.push("  /db favorite        收藏的查询模板");
  lines.push("  /db relations       表关联关系管理");
  lines.push("  /db refresh-schema  刷新表结构缓存");

  const displayText = lines.join("\n");
  ctx.ui.notify(displayText, "info");

  // Inject into AI context so the model sees the current workspace state.
  // When no connections are configured, the AI can proactively help the user
  // create the config file and suggest reloading the extension.
  if (pi) {
    const contextLines = [...lines];

    if (!ws.isConfigured) {
      contextLines.push(
        "",
        "---",
        "",
        "💡 **提示给 AI**：如果你正在协助用户，可以帮他们：",
        "1. 询问数据库连接信息（host、port、username、password、数据库名）",
        `2. 在 ${ws.configPath} 中创建或更新连接配置`,
        "3. 配置完成后让用户执行 `/db switch` 即可连接，无需 reload",
        "",
        "如果用户已经告诉你连接信息，请主动帮他们生成配置文件。",
      );
    }

    // When no connections exist, trigger a turn so the AI proactively
    // asks the user for connection details and helps create the config.
    const shouldTriggerTurn = !ws.isConfigured;

    pi.sendMessage(
      {
        customType: "db-workspace-panel",
        content: contextLines.join("\n"),
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: shouldTriggerTurn },
    );
  }
}

export async function handleSwitch(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  _pi: ExtensionAPI,
): Promise<void> {
  // Reload config to pick up changes made without /reload (e.g. AI-created file)
  ws.reloadConfig();

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
