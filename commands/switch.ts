/**
 * /db switch —— 环境 → 连接 → 数据库选择。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { withLoader } from "./utils";
import { sendActiveDb } from "./llm-context";

export const STATUS_KEY = "db-workspace";

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
  sendActiveDb(pi, ws);

  ctx.ui.notify(`已连接：${env}/${database} @ ${connectionId}`, "info");
}
