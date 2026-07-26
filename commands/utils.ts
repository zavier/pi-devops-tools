/**
 * Shared command utilities — pickTable and other helpers used across handlers.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

/**
 * Interactive table picker: fuzzy filter → select.
 * Shared by schema, query, relations-add, and relations-er-diagram handlers.
 */
export async function pickTable(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  prompt: string,
): Promise<string | undefined> {
  let tables: string[];
  try {
    tables = await ws.getTables();
  } catch (err: any) {
    ctx.ui.notify(`加载表列表失败：${err.message}`, "error");
    return undefined;
  }
  if (tables.length === 0) {
    ctx.ui.notify(`${ws.current!.database} 中没有表`, "warning");
    return undefined;
  }

  const keyword = await ctx.ui.input(`筛选表名（回车显示全部）`, "");
  if (keyword === undefined) return undefined;

  const filtered = keyword?.trim()
    ? tables.filter((t) => t.toLowerCase().includes(keyword.toLowerCase()))
    : tables;

  if (filtered.length === 0) {
    ctx.ui.notify(`未找到匹配 "${keyword}" 的表`, "warning");
    return undefined;
  }

  return await ctx.ui.select(prompt, filtered);
}
