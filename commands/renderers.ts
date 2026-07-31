/**
 * db 扩展消息与条目的自定义渲染器。
 *
 * 查询结果使用双受众拆分：
 * - pi.appendEntry("db-query-result", data) → 仅 TUI 的富渲染，带
 *   自适应宽度（EntryRenderer + Component）。
 * - pi.sendMessage({ display: false, ... }) → 仅 LLM 上下文，紧凑格式。
 *
 * 面板（`db-workspace-panel`）保持为消息渲染器——其内容是
 * 对 LLM 也有用的短预格式化文本。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { formatTableDisplay, formatVerticalFull } from "../formatting/result-table";

// ====== 条目数据 ======

export interface QueryResultEntryData {
  database: string;
  sql: string;
  rowCount: number;
  elapsed: string;
  /** 可见结果集的列名。 */
  columns: string[];
  /** 预清洗的行：每个值都是 string | null（无 Buffer/Date 对象）。 */
  rows: Record<string, string | null>[];
  /** 渲染关联表提示的元数据（关联表在 LLM 消息中）。 */
  relatedCount: number;
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

  // ── db-workspace-panel：短预格式化文本——保持为消息渲染器 ──

  pi.registerMessageRenderer("db-workspace-panel", (message, _options, _theme) => {
    if (typeof message.content !== "string") return undefined;
    return new Text(message.content, 1, 0);
  });
}

// ====== 内部辅助 ======

function renderQueryResult(
  d: QueryResultEntryData,
  width: number,
  expanded: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: any,
): string[] {
  const lines: string[] = [];

  // 表头
  lines.push(
    theme.fg("accent", theme.bold(`🗄 查询 — ${d.database}`)) +
      theme.fg("dim", `  ${d.rowCount} 行 (${d.elapsed})`),
  );
  lines.push(theme.fg("muted", `SQL: ${d.sql}`));
  lines.push("");

  if (d.rowCount === 0) {
    lines.push("（空结果）");
    return lines;
  }

  if (expanded) {
    // 完整表格：全部行纵向，不截断
    lines.push(...formatVerticalFull(d.columns, d.rows as any));
    lines.push(`全部 ${d.rowCount} 行 × ${d.columns.length} 列`);
  } else {
    // 默认：自适应横向/转置/纵向
    const w = Math.max(width, 40);
    const table = formatTableDisplay({ columns: d.columns, rows: d.rows as any }, w);
    lines.push(...table.split("\n"));

    if (d.rowCount > 20) {
      lines.push("", theme.fg("dim", `… 更多行在 LLM 上下文中（ctrl+o 查看完整结果）`));
    }
  }

  // 关联表提示
  if (d.relatedCount > 0) {
    if (expanded) {
      lines.push("", theme.fg("dim", `关联表（${d.relatedCount} 个）— 详情见 LLM 上下文`));
    } else {
      lines.push("", theme.fg("dim", `… ${d.relatedCount} 个关联表（ctrl+o 展开查看）`));
    }
  }

  return lines;
}
