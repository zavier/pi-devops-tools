/**
 * /db sample —— 查看数据表样例数据（固定 10 行）。
 *
 * 交互与 /db schema 一致：不带参数时先弹表选择器（pickTableFuzzy），
 * 选定后再展示数据。只做最小 SQL 装配——只读守卫与 LIMIT 注入仍由
 * connection/sql-policy.ts 在执行器内强制，不新增查询路径。
 *
 * 结果复用 /db query 的展示通道（executeAndDisplay）：TUI 富表格条目 +
 * LLM 结果文档，行为与一次等价的手写查询完全一致。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { pickTableFuzzy } from "./utils";
import { executeAndDisplay } from "./query";

/** 样例数据的固定行数。 */
export const SAMPLE_ROW_LIMIT = 10;

/** 样例数据 SQL（纯函数，供测试）。 */
export function sampleDataSql(table: string): string {
  return `SELECT * FROM \`${table}\` LIMIT ${SAMPLE_ROW_LIMIT}`;
}

export async function handleSample(
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
    const picked = await pickTableFuzzy(ctx, ws, "选择数据表");
    if (!picked) return;
    table = picked;
  }

  await executeAndDisplay(ctx, ws, pi, sampleDataSql(table));
}
