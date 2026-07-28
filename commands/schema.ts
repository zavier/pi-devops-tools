/**
 * /db schema — view table structure (columns + indexes).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { SqlRow } from "../types";
import { formatSchemaMarkdown } from "../formatting/schema-table";
import { pickTable } from "./utils";

export async function handleSchema(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  table?: string,
): Promise<void> {
  if (!ws.isReady) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  if (!table) {
    const picked = await pickTable(ctx, ws, "选择表");
    if (!picked) return;
    table = picked;
  }

  let result: { columns: SqlRow[]; indexes: SqlRow[] };
  try {
    result = await ws.getTableSchema(table);
  } catch (err: any) {
    ctx.ui.notify(`加载表结构失败：${err.message}`, "error");
    return;
  }

  // display: true → persistent in the chat (default markdown rendering) and
  // visible to the LLM. deliverAs "followUp" commits immediately when the
  // agent is idle so the result renders without waiting for the next prompt.
  pi.sendMessage(
    {
      customType: "db-table-schema",
      content: formatSchemaMarkdown(table, ws.current!.database, result.columns, result.indexes),
      display: true,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}
