/**
 * Custom message renderers for db-extension messages.
 *
 * Query results and panels are sent via pi.sendMessage({ display: true }) so
 * they persist in the session and reach the LLM context. Renderers keep the
 * chat view compact and theme-consistent:
 * - db-query-result: header + SQL + main table always; related tables only
 *   when the message is expanded.
 * - db-workspace-panel: raw text (the panel is preformatted, not markdown).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export interface QueryResultDetails {
  database: string;
  sql: string;
  rowCount: number;
  elapsed: string;
  /** Pre-formatted main result table (formatTableResult output). */
  mainTable: string;
  /** Pre-formatted related-tables section; empty string when none. */
  relatedText: string;
  relatedCount: number;
}

export function registerRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<QueryResultDetails>(
    "db-query-result",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined; // fall back to default rendering

      // TUI display caps (matching formatTableResult limits:
      // horizontal ≤8 cols → 20, transposed → 10, vertical → 5)
      const DISPLAY_CAP = 20;

      const lines = [
        theme.fg("accent", theme.bold(`🗄 查询 — ${d.database}`)) +
          theme.fg("dim", `  ${d.rowCount} 行 (${d.elapsed})`),
        theme.fg("muted", `SQL: ${d.sql}`),
        "",
        d.mainTable,
      ];

      // Hint when rows exceed the most generous TUI display cap
      if (d.rowCount > DISPLAY_CAP) {
        const hint = theme.fg(
          "dim",
          `… TUI 仅展示部分行（LLM 可读全部 ${d.rowCount} 行；手动加 LIMIT/OFFSET 翻页）`,
        );
        lines.push("", hint);
      }

      if (d.relatedCount > 0) {
        if (expanded && d.relatedText) {
          lines.push("", d.relatedText);
        } else {
          const hint = rawKeyHint("ctrl+o", "展开查看");
          lines.push("", theme.fg("dim", `… ${d.relatedCount} 个关联表（${hint}）`));
        }
      }

      return new Text(lines.join("\n"), 1, 0);
    },
  );

  pi.registerMessageRenderer("db-workspace-panel", (message, _options, _theme) => {
    if (typeof message.content !== "string") return undefined;
    return new Text(message.content, 1, 0);
  });
}
