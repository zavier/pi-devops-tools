/**
 * /db refresh-schema — refresh the cached table schema from the database.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { SchemaSnapshot } from "../schema/cache";

export async function handleRefreshSchema(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  ctx.ui.notify("正在刷新表结构缓存...", "info");

  let snapshot: SchemaSnapshot;
  try {
    snapshot = await ws.refreshSchema();
  } catch (err: any) {
    ctx.ui.notify(`刷新表结构失败：${err.message}`, "error");
    return;
  }

  ctx.ui.notify(
    `已缓存 ${snapshot.tables.length} 个表结构（${ws.current!.database}）`,
    "info",
  );
}
