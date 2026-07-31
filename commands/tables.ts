/**
 * /db tables —— 列出当前数据库的所有表。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

export async function handleTables(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
): Promise<void> {
  if (!ws.isReady) {
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

  const content = [
    `### 表 — ${ws.current!.database}（${tables.length}）`,
    "",
    ...tables.map((t) => `- ${t}`),
  ].join("\n");

  pi.sendMessage(
    { customType: "db-tables", content, display: true },
    { deliverAs: "followUp", triggerTurn: false },
  );
}
