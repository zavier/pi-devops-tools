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

      const lines = [
        theme.fg("accent", theme.bold(`🗄 查询 — ${d.database}`)) +
          theme.fg("dim", `  ${d.rowCount} 行 (${d.elapsed})`),
        theme.fg("muted", `SQL: ${d.sql}`),
        "",
        d.mainTable,
      ];

      if (d.relatedCount > 0) {
        if (expanded && d.relatedText) {
          lines.push("", d.relatedText);
        } else {
          lines.push("", theme.fg("dim", `… ${d.relatedCount} 个关联表（展开查看）`));
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
