/**
 * /db switch —— 环境 → 连接 → 数据库选择。
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { SessionAutoApprove } from "../state/mutation-approval";
import { withLoader } from "./utils";
import type { DbStatusNotifier } from "./llm-context";

export const STATUS_KEY = "db-workspace";

/** 免确认后缀——只在开启时出现，与连接信息合并展示（pi footer 按 key 排序、空格拼接，
 * 单一组合标签才能得到 `• ` 分段效果，且默认关闭时零噪音）。 */
const AUTO_APPROVE_SUFFIX = " • 免确认";

/** 状态栏标签：连接信息 + 免确认后缀。 */
export function dbStatusLabel(ws: DatabaseWorkspaceService, approval: SessionAutoApprove): string {
  return approval.enabled ? `${ws.statusLabel}${AUTO_APPROVE_SUFFIX}` : ws.statusLabel;
}

/** widget 行：连接信息（含 connection id）+ 免确认后缀。 */
export function dbWidgetLine(ws: DatabaseWorkspaceService, approval: SessionAutoApprove): string {
  const { environment, connectionId, database } = ws.current!;
  const base = `🗄 ${environment}/${database}  @${connectionId}`;
  return approval.enabled ? `${base}${AUTO_APPROVE_SUFFIX}` : base;
}

/** 写入状态栏与 widget；未选择数据库时不动（没有连接信息可组合）。 */
export function applyWorkspaceStatus(
  ctx: ExtensionContext,
  ws: DatabaseWorkspaceService,
  approval: SessionAutoApprove,
): void {
  if (!ws.isReady) return;
  ctx.ui.setStatus(STATUS_KEY, dbStatusLabel(ws, approval));
  ctx.ui.setWidget(STATUS_KEY, [dbWidgetLine(ws, approval)]);
}

export async function handleSwitch(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  notifier: DbStatusNotifier,
  approval: SessionAutoApprove,
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

  applyWorkspaceStatus(ctx, ws, approval);

  // 告知 LLM 当前激活的数据库（未选择时不注入；状态未变不重复注入）。
  // display: false 避免冗余消息污染聊天。
  notifier.notifyIfChanged();

  ctx.ui.notify(`已连接：${env}/${database} @ ${connectionId}`, "info");
}
