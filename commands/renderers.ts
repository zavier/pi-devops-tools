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
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { formatTableDisplay, formatVerticalFull } from "../formatting/result-table";

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

  // ── db-workspace-panel：短预格式化文本——保持为消息渲染器 ──

  pi.registerMessageRenderer("db-workspace-panel", (message, _options, _theme) => {
    if (typeof message.content !== "string") return undefined;
    return new Text(message.content, 1, 0);
  });
}

// ====== 内部辅助 ======

/**
 * 关联表折叠态摘要——单行紧凑列出所有表名与行数。
 * 纯文本（无 theme），方便单独测试。
 */
export function formatRelatedSummary(related: RelatedTuiData[]): string {
  if (related.length === 0) return "";
  const parts = related.map((r) => `${r.table}（${r.rowCount} 行）`);
  return `📎 关联表：${parts.join("、")}`;
}

/**
 * 关联表展开态内容——每张表：标题行 + 关联路径 + 自适应宽度表格。
 * 纯文本（无 theme），方便单独测试。
 */
export function formatRelatedExpanded(related: RelatedTuiData[], width: number): string[] {
  const lines: string[] = [];
  for (const r of related) {
    lines.push("");
    lines.push(`── 📎 关联表 ${r.schema}.${r.table} — ${r.rowCount} 行（${r.elapsed}）──`);
    if (r.joinPath) lines.push(`   路径：${r.joinPath}`);
    lines.push("");
    if (r.rows.length > 0) {
      const table = formatTableDisplay({ columns: r.columns, rows: r.rows as any }, width);
      lines.push(...table.split("\n"));
    } else {
      lines.push("（空结果）");
    }
  }
  return lines;
}

function renderQueryResult(
  d: QueryResultEntryData,
  width: number,
  expanded: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: any,
): string[] {
  const lines: string[] = [];
  const w = Math.max(width, 40);

  // 表头
  lines.push(
    theme.fg("accent", theme.bold(`🗄 查询 — ${d.database}`)) +
      theme.fg("dim", `  ${d.rowCount} 行 (${d.elapsed})`),
  );
  lines.push(theme.fg("muted", `SQL: ${d.sql}`));
  lines.push("");

  if (d.rowCount === 0) {
    lines.push("（空结果）");
  } else if (expanded) {
    // 完整表格：全部行纵向，不截断
    lines.push(...formatVerticalFull(d.columns, d.rows as any));
    lines.push(`全部 ${d.rowCount} 行 × ${d.columns.length} 列`);
  } else {
    // 默认：自适应横向/转置/纵向
    const table = formatTableDisplay({ columns: d.columns, rows: d.rows as any }, w);
    lines.push(...table.split("\n"));

    if (d.rowCount > 20) {
      lines.push(
        "",
        theme.fg(
          "dim",
          `… 更多行在 LLM 上下文中（${keyHint("app.tools.expand", "查看完整结果")}）`,
        ),
      );
    }
  }

  // 关联表：折叠态显示摘要，展开态显示完整内容（与主表同一视图）。
  if (d.related.length > 0) {
    if (expanded) {
      lines.push("", theme.fg("accent", theme.bold(`📎 关联表（${d.related.length} 个）`)));
      lines.push(...formatRelatedExpanded(d.related, w));
    } else {
      lines.push("", theme.fg("dim", formatRelatedSummary(d.related)));
      lines.push(
        theme.fg(
          "dim",
          `（${keyHint("app.tools.expand", "展开查看完整内容")}，或 /db related 打开浏览器）`,
        ),
      );
    }
  }

  return lines;
}
