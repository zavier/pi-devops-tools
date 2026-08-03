/**
 * 变更确认对话框 —— LLM 调用 db_mutate 时显示的 overlay UI。
 *
 * 显示带颜色编码的操作类型、连接/数据库上下文和缺少 WHERE 的警告。
 * 用户按 Enter 确认或 Esc 取消。非 TUI 模式回退到 ctx.ui.confirm()。
 *
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer, matchesKey, Key, visibleWidth } from "@earendil-works/pi-tui";
import type { MutationApprovalRequest } from "../state/workspace";
import { padToDisplayWidth, truncateToDisplayWidth } from "../formatting/display-width";

type StyleColor = "success" | "warning" | "error";

const OP_STYLE: Record<string, { icon: string; color: StyleColor }> = {
  INSERT: { icon: "🟢", color: "success" },
  UPDATE: { icon: "🟡", color: "warning" },
  DELETE: { icon: "🔴", color: "error" },
  REPLACE: { icon: "🟠", color: "warning" },
};

const DEFAULT_WARNING = "该操作将永久修改数据，无法撤销";

/**
 * 显示变更确认对话框，用户确认时返回 true。
 *
 * TUI 模式下渲染带边框框的 overlay，SQL 按操作类型颜色编码。
 * 非 TUI 模式回退为普通 confirm() 对话框。
 *
 */
export async function showMutationConfirm(
  ctx: ExtensionContext,
  params: MutationApprovalRequest,
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
    (_tui, theme, _kb, done) => {
      const container = new Container();

      // ── 上边框 ──
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Spacer(0));

      // ── 标题 ──
      container.addChild(new Text(theme.fg("accent", theme.bold("  ⚠️ 数据修改确认")), 2, 0));
      container.addChild(new Spacer(0));

      // ── 元信息 ──
      const opLabel = `${style.icon} ${params.operation}`;
      container.addChild(new Text(`  操作类型：  ${theme.fg(style.color, opLabel)}`, 2, 0));
      container.addChild(
        new Text(`  目标数据库：${params.database} @ ${params.connectionId}`, 2, 0),
      );
      container.addChild(new Spacer(0));

      // ── SQL 框 ──
      const sqlLines = params.sql.split("\n");
      const maxSqlLen = Math.max(...sqlLines.map((l) => l.length));
      const boxInnerWidth = Math.min(maxSqlLen + 2, 78);

      // 上边缘
      container.addChild(new Text(theme.fg(style.color, `  ┌${"─".repeat(boxInnerWidth)}┐`), 2, 0));

      // 空填充行
      container.addChild(
        new Text(
          `${theme.fg(style.color, "  │")}${" ".repeat(boxInnerWidth)}${theme.fg(style.color, "│")}`,
          2,
          0,
        ),
      );

      // SQL 内容——按显示宽度截断/补齐（中文/emoji 占 2 列，
      // 按码元 slice/padEnd 会让中文 SQL 行超宽）。
      for (const line of sqlLines) {
        const trimmed = line.trim();
        const maxContent = boxInnerWidth - 2;
        const display =
          visibleWidth(trimmed) > maxContent
            ? truncateToDisplayWidth(trimmed, maxContent - 1) + "…"
            : padToDisplayWidth(trimmed, maxContent);
        container.addChild(
          new Text(
            `${theme.fg(style.color, "  │ ")}${display}${theme.fg(style.color, " │")}`,
            2,
            0,
          ),
        );
      }

      // 空填充行
      container.addChild(
        new Text(
          `${theme.fg(style.color, "  │")}${" ".repeat(boxInnerWidth)}${theme.fg(style.color, "│")}`,
          2,
          0,
        ),
      );

      // 下边缘
      container.addChild(new Text(theme.fg(style.color, `  └${"─".repeat(boxInnerWidth)}┘`), 2, 0));

      container.addChild(new Spacer(0));

      // ── 警告 ──
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

      // ── 按键提示 ──
      container.addChild(
        new Text(
          `  ${theme.fg("accent", "Enter 确认执行")}    ${theme.fg("dim", "Esc 取消")}`,
          2,
          0,
        ),
      );

      container.addChild(new Spacer(0));

      // ── 下边框 ──
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
          // 忽略其他所有输入
        },
      };
    },
    { overlay: true },
  );

  return result ?? false;
}
