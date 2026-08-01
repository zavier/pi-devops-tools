/**
 * /db schema —— 查看表结构（列 + 索引）。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { TableSchema } from "../types";
import { formatSchemaMarkdown } from "../formatting/schema-table";
import { pickTableFuzzy } from "./utils";

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
    const picked = await pickTableFuzzy(ctx, ws, "选择表");
    if (!picked) return;
    table = picked;
  }

  let result: TableSchema;
  try {
    result = await ws.getTableSchema(table);
  } catch (err: any) {
    ctx.ui.notify(`加载表结构失败：${err.message}`, "error");
    return;
  }

  // display: true → 在聊天中持久显示（默认 markdown 渲染）且
  // 对 LLM 可见。deliverAs "followUp" 在 agent 空闲时立即提交，
  // 结果无需等待下一个提示即可渲染。
  pi.sendMessage(
    {
      customType: "db-table-schema",
      content: formatSchemaMarkdown(table, ws.current!.database, result.columns, result.indexes),
      display: true,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}
