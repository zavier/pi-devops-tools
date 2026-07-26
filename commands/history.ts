/**
 * /db history — browse query execution history.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { HistoryEntry } from "../history/store";

export async function handleHistory(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  keyword?: string,
): Promise<void> {
  try {
    const filter: { limit: number; keyword?: string } = { limit: 20 };
    if (keyword) filter.keyword = keyword;

    let entries: HistoryEntry[];
    if (ws.current) {
      entries = ws.history.list({ ...filter, database: ws.current.database });
    } else {
      entries = ws.history.list(filter);
    }

    if (entries.length === 0) {
      ctx.ui.notify(
        keyword ? `未找到包含 "${keyword}" 的查询历史` : "暂无查询历史",
        "info",
      );
      return;
    }

    const rows = entries.map((e) => {
      const sql = e.sql.length > 50 ? e.sql.slice(0, 47) + "..." : e.sql.padEnd(50);
      const time = e.createdTime.replace("T", " ").slice(0, 19);
      return `  ${String(e.id).padEnd(4)}${time}  ${e.database.padEnd(16)}${sql}${String(e.rowCount).padStart(5)}  ${e.elapsed}`;
    });

    const text = [
      keyword
        ? `═══ History — "${keyword}" (${entries.length}) ═══`
        : `═══ History (${entries.length}) ═══`,
      "",
      `  #    时间                 数据库            SQL                                              行数  耗时`,
      `  ---- ------------------- ---------------- -------------------------------------------------- ---- -----`,
      ...rows,
    ].join("\n");

    ctx.ui.notify(text, "info");
  } catch (err: any) {
    ctx.ui.notify(`历史查询出错：${err.message}`, "error");
  }
}
