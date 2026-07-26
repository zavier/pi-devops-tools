/**
 * /db tables — list all tables in the current database.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

export async function handleTables(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
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

  const text = [
    `═══ 表 — ${ws.current!.database} ═══`,
    "",
    ...tables.map((t, i) => `  ${i + 1}. ${t}`),
    "",
    `${tables.length} 个表`,
  ].join("\n");

  ctx.ui.notify(text, "info");
}
