/**
 * Mutation confirmation dialog — overlay UI shown when the LLM calls db_mutate.
 *
 * Displays the SQL with color-coded operation type, connection/database context,
 * and WHERE-missing warnings. User presses Enter to confirm or Esc to cancel.
 * In non-TUI modes falls back to ctx.ui.confirm().
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer, matchesKey, Key } from "@earendil-works/pi-tui";

export interface MutationConfirmParams {
  sql: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  warning?: string;
  connectionId: string;
  database: string;
}

type StyleColor = "success" | "warning" | "error";

const OP_STYLE: Record<string, { icon: string; color: StyleColor }> = {
  INSERT: { icon: "🟢", color: "success" },
  UPDATE: { icon: "🟡", color: "warning" },
  DELETE: { icon: "🔴", color: "error" },
  REPLACE: { icon: "🟠", color: "warning" },
};

const DEFAULT_WARNING = "该操作将永久修改数据，无法撤销";

/**
 * Show the mutation confirmation dialog and return true if the user confirmed.
 *
 * In TUI mode this renders an overlay with the SQL in a bordered box,
 * color-coded by operation type. In non-TUI modes it falls back to a plain
 * confirm() dialog.
 */
export async function showMutationConfirm(
  ctx: ExtensionContext,
  params: MutationConfirmParams,
): Promise<boolean> {
  if (ctx.mode !== "tui") {
    const label = `${OP_STYLE[params.operation]?.icon ?? "⚠️"} ${params.operation}`;
    const warningLine = params.warning ? `\n\n${params.warning}` : `\n\n${DEFAULT_WARNING}`;
    const ok = await ctx.ui.confirm(
      `数据修改确认 — ${label}`,
      `即将在 ${params.connectionId}/${params.database} 执行：\n\n${params.sql}${warningLine}`,
    );
    return ok;
  }

  const style = OP_STYLE[params.operation] ?? OP_STYLE.UPDATE;
  const warningText = params.warning ?? DEFAULT_WARNING;

  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _kb, done) => {
      const container = new Container();

      // ── Top border ──
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Spacer(0));

      // ── Title ──
      container.addChild(new Text(theme.fg("accent", theme.bold("  ⚠️ 数据修改确认")), 2, 0));
      container.addChild(new Spacer(0));

      // ── Meta info ──
      const opLabel = `${style.icon} ${params.operation}`;
      container.addChild(new Text(`  操作类型：  ${theme.fg(style.color, opLabel)}`, 2, 0));
      container.addChild(
        new Text(`  目标数据库：${params.database} @ ${params.connectionId}`, 2, 0),
      );
      container.addChild(new Spacer(0));

      // ── SQL box ──
      const sqlLines = params.sql.split("\n");
      const maxSqlLen = Math.max(...sqlLines.map((l) => l.length));
      const boxInnerWidth = Math.min(maxSqlLen + 2, 78);

      // Top edge
      container.addChild(new Text(theme.fg(style.color, `  ┌${"─".repeat(boxInnerWidth)}┐`), 2, 0));

      // Empty padding line
      container.addChild(
        new Text(
          `${theme.fg(style.color, "  │")}${" ".repeat(boxInnerWidth)}${theme.fg(style.color, "│")}`,
          2,
          0,
        ),
      );

      // SQL content
      for (const line of sqlLines) {
        const trimmed = line.trim();
        const maxContent = boxInnerWidth - 2;
        const display =
          trimmed.length > maxContent
            ? trimmed.slice(0, maxContent - 1) + "…"
            : trimmed.padEnd(maxContent);
        container.addChild(
          new Text(
            `${theme.fg(style.color, "  │ ")}${display}${theme.fg(style.color, " │")}`,
            2,
            0,
          ),
        );
      }

      // Empty padding line
      container.addChild(
        new Text(
          `${theme.fg(style.color, "  │")}${" ".repeat(boxInnerWidth)}${theme.fg(style.color, "│")}`,
          2,
          0,
        ),
      );

      // Bottom edge
      container.addChild(new Text(theme.fg(style.color, `  └${"─".repeat(boxInnerWidth)}┘`), 2, 0));

      container.addChild(new Spacer(0));

      // ── Warning ──
      container.addChild(
        new Text(
          params.warning
            ? `  ${theme.fg("warning", warningText)}`
            : `  ${theme.fg("dim", `⚠️ ${warningText}`)}`,
          2,
          0,
        ),
      );

      container.addChild(new Spacer(0));

      // ── Key hints ──
      container.addChild(
        new Text(
          `  ${theme.fg("accent", "Enter 确认执行")}    ${theme.fg("dim", "Esc 取消")}`,
          2,
          0,
        ),
      );

      container.addChild(new Spacer(0));

      // ── Bottom border ──
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.enter)) {
            done(true);
          } else if (matchesKey(data, Key.escape)) {
            done(false);
          }
          // Ignore all other input
        },
      };
    },
    { overlay: true },
  );

  return result ?? false;
}
