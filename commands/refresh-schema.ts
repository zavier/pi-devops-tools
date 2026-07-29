/**
 * /db refresh-schema — refresh the cached table schema from the database.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { withLoader } from "./utils";

export async function handleRefreshSchema(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<void> {
  if (!ws.isReady) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  const snapshot = await withLoader(ctx, "刷新表结构缓存…", (_signal) => ws.refreshSchema());
  if (!snapshot) return;

  ctx.ui.notify(`已缓存 ${snapshot.tables.length} 个表结构（${ws.current!.database}）`, "info");
}
