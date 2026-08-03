/**
 * db 扩展消息与条目的自定义渲染器。
 *
 * 查询结果使用双受众拆分：
 * - pi.appendEntry("db-query-result", data) → 仅 TUI 的富渲染，带
 *   自适应宽度（EntryRenderer + Component）。
 * - pi.sendMessage({ display: false, ... }) → 仅 LLM 上下文，紧凑格式。
 *
 * 文档文本由 formatting/result-document.ts 统一装配（纯函数），
 * 本模块只做两件事：把 DocLine 的 style 映射为 theme 颜色、
 * 追加依赖 pi keyHint 的交互提示行。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { QueryResultDoc } from "../formatting/result-document";
import { renderQueryDocument } from "../formatting/result-document";

// ====== 条目数据 ======

/** TUI 可读的关联表数据（值已清洗为 string|null，JSON 序列化安全）。 */
export interface RelatedTuiData {
  schema: string;
  table: string;
  /** 关联路径，如 `orders.user_id → users.id`。 */
  joinPath: string;
  rowCount: number;
  elapsed: string;
  columns: string[];
  rows: Record<string, string | null>[];
}

export interface QueryResultEntryData {
  database: string;
  sql: string;
  rowCount: number;
  elapsed: string;
  /** 可见结果集的列名。 */
  columns: string[];
  /** 预清洗的行：每个值都是 string | null（无 Buffer/Date 对象）。 */
  rows: Record<string, string | null>[];
  /** 关联表数据——折叠态渲染摘要，展开态渲染完整内容。 */
  related: RelatedTuiData[];
}

// ====== 条目渲染器 ======

export function registerRenderers(pi: ExtensionAPI): void {
  // ── db-query-result：仅 TUI 的条目，自适应宽度表格 ──

  pi.registerEntryRenderer<QueryResultEntryData>("db-query-result", (entry, opts, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const { expanded } = opts;

    return {
      render(width: number): string[] {
        return renderQueryResult(data, width, expanded, theme);
      },
      invalidate() {},
    } satisfies Component;
  });
}

// ====== 内部辅助 ======

/**
 * 装配文档 + 映射颜色 + 追加 keyHint 交互提示。
 *
 * 导出供测试（fake theme 可测）。
 */
export function renderQueryResult(
  d: QueryResultEntryData,
  width: number,
  expanded: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: any,
): string[] {
  const doc: QueryResultDoc = {
    database: d.database,
    sql: d.sql,
    rowCount: d.rowCount,
    elapsed: d.elapsed,
    columns: d.columns,
    rows: d.rows,
    related: d.related,
  };

  return renderQueryDocument(doc, { audience: "tui-zh", width, expanded }).map((l) => {
    let text = l.text;
    if (l.hint === "expand-rows") {
      text += `（${keyHint("app.tools.expand", "查看完整结果")}）`;
    } else if (l.hint === "expand-related") {
      text = `（${keyHint("app.tools.expand", "展开查看完整内容")}，或 /db related 打开浏览器）`;
    }
    let styled: string;
    if (l.style === "accent") styled = theme.fg("accent", theme.bold(text));
    else if (l.style === "dim") styled = theme.fg("dim", text);
    else if (l.style === "muted") styled = theme.fg("muted", text);
    else styled = text;
    // 最后防线：任何一行都不超过渲染宽度——长 SQL、展开态长值、
    // 中文单元格表格都可能超宽，Text 不自动截断，超宽行会触发
    // TUI 的宽度断言崩溃（Rendered line N exceeds terminal width）。
    return truncateToWidth(styled, Math.max(1, width), "…");
  });
}
