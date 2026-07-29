/**
 * Custom renderers for db-extension messages and entries.
 *
 * Query results now use a two-audience split:
 * - pi.appendEntry("db-query-result", data) → TUI-only rich rendering with
 *   adaptive widths (EntryRenderer + Component).
 * - pi.sendMessage({ display: false, ... }) → LLM context only, compact format.
 *
 * Panel (`db-workspace-panel`) stays as a message renderer — its content is
 * short pre-formatted text that's useful for the LLM too.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { formatTableDisplay, formatVerticalFull } from "../formatting/result-table";

// ====== Entry data ======

export interface QueryResultEntryData {
  database: string;
  sql: string;
  rowCount: number;
  elapsed: string;
  /** Column names for the visible result set. */
  columns: string[];
  /** Pre-sanitized rows: every value is string | null (no Buffer/Date objects). */
  rows: Record<string, string | null>[];
  /** Metadata to render the related-tables hint (related tables are in the LLM message). */
  relatedCount: number;
}

// ====== Entry renderer ======

export function registerRenderers(pi: ExtensionAPI): void {
  // ── db-query-result: TUI-only entry with adaptive-width table ──

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

  // ── db-workspace-panel: short pre-formatted text — keep as message renderer ──

  pi.registerMessageRenderer("db-workspace-panel", (message, _options, _theme) => {
    if (typeof message.content !== "string") return undefined;
    return new Text(message.content, 1, 0);
  });
}

// ====== Internal helpers ======

function renderQueryResult(
  d: QueryResultEntryData,
  width: number,
  expanded: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: any,
): string[] {
  const lines: string[] = [];

  // Header
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
    // Full table: all rows vertically, no truncation
    lines.push(...formatVerticalFull(d.columns, d.rows as any));
    lines.push(`全部 ${d.rowCount} 行 × ${d.columns.length} 列`);
  } else {
    // Default: adaptive horizontal/transposed/vertical
    const w = Math.max(width, 40);
    const table = formatTableDisplay({ columns: d.columns, rows: d.rows as any }, w);
    lines.push(...table.split("\n"));

    if (d.rowCount > 20) {
      lines.push("", theme.fg("dim", `… 更多行在 LLM 上下文中（ctrl+o 查看完整结果）`));
    }
  }

  // Related-tables hint
  if (d.relatedCount > 0) {
    if (expanded) {
      lines.push("", theme.fg("dim", `关联表（${d.relatedCount} 个）— 详情见 LLM 上下文`));
    } else {
      lines.push("", theme.fg("dim", `… ${d.relatedCount} 个关联表（ctrl+o 展开查看）`));
    }
  }

  return lines;
}
