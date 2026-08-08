/**
 * 变更确认对话框 —— LLM 调用 db_mutate 时显示的 overlay UI。
 *
 * 显示带颜色编码的操作类型、连接/数据库上下文和缺少 WHERE 的警告。
 * 用户按 Enter 确认或 Esc 取消。非 TUI 模式回退到 ctx.ui.confirm()。
 *
 * SQL 框宽度在 render(w) 时按真实渲染宽度自适应：pi-tui overlay 的
 * 默认宽度是 min(80, termWidth)，构造期写死宽度会让长 SQL 行被
 * Text 组件折行、框线崩坏。长 SQL 在框内按显示宽度软换行（不截断，
 * 确认破坏性操作需要看到完整 WHERE），行数超限时折叠为省略提示。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer, matchesKey, Key, visibleWidth } from "@earendil-works/pi-tui";
import type { MutationApprovalRequest } from "../state/workspace";
import { padToDisplayWidth, wrapToDisplayWidth } from "../formatting/display-width";

type StyleColor = "success" | "warning" | "error";

const OP_STYLE: Record<string, { icon: string; color: StyleColor }> = {
  INSERT: { icon: "🟢", color: "success" },
  UPDATE: { icon: "🟡", color: "warning" },
  DELETE: { icon: "🔴", color: "error" },
  REPLACE: { icon: "🟠", color: "warning" },
};

const DEFAULT_WARNING = "该操作将永久修改数据，无法撤销";

/** SQL 框内容宽度下限——超窄终端的兜底，防止框宽坍缩为负。 */
const MIN_SQL_CONTENT = 10;
/** SQL 框内容宽度上限——宽终端下的美学上限，避免框体铺满全屏。 */
const MAX_SQL_CONTENT = 88;
/** SQL 物理行数上限，超出部分折叠为一条省略提示。 */
const MAX_SQL_LINES = 12;

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
      // 宽度变化（含首次渲染、终端 resize）时重建内容。
      let lastWidth = -1;
      let container = new Container();

      const build = (w: number): void => {
        container = new Container();

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
        // 内容预算 = w − Text 左右 margin(2+2) − 框线 "  │ "/" │" (4+2)，
        // 保证框体任何一行都不超过 Text 的折行宽度 w−4。
        const logicalLines = params.sql.split("\n").map((l) => l.trim());
        const maxLineWidth = Math.max(...logicalLines.map((l) => visibleWidth(l)));
        const availContent = Math.max(MIN_SQL_CONTENT, w - 10);
        const contentWidth = Math.min(
          Math.max(maxLineWidth, MIN_SQL_CONTENT),
          MAX_SQL_CONTENT,
          availContent,
        );
        const boxInnerWidth = contentWidth + 2;

        const addBoxLine = (content: string) => {
          container.addChild(
            new Text(
              `${theme.fg(style.color, "  │ ")}${content}${theme.fg(style.color, " │")}`,
              2,
              0,
            ),
          );
        };

        // 上边缘
        container.addChild(
          new Text(theme.fg(style.color, `  ┌${"─".repeat(boxInnerWidth)}┐`), 2, 0),
        );

        // 空填充行
        addBoxLine(" ".repeat(contentWidth));

        // SQL 内容——按显示宽度软换行为多条物理行（中文/emoji 占 2 列，
        // 按码元切会让中文 SQL 行超宽折行）；软换行保证每条物理行
        // ≤ contentWidth，只需右补齐即可让框线对齐。
        const physicalLines = logicalLines.flatMap((l) => wrapToDisplayWidth(l, contentWidth));
        const hiddenCount = Math.max(0, physicalLines.length - MAX_SQL_LINES);
        const shownLines = physicalLines.slice(0, physicalLines.length - hiddenCount);
        for (const line of shownLines) {
          addBoxLine(padToDisplayWidth(line, contentWidth));
        }
        if (hiddenCount > 0) {
          // 先按显示宽度补齐再上色——display-width 工具只接受纯文本
          const note = padToDisplayWidth(`… 省略 ${hiddenCount} 行`, contentWidth);
          addBoxLine(theme.fg("dim", note));
        }

        // 空填充行
        addBoxLine(" ".repeat(contentWidth));

        // 下边缘
        container.addChild(
          new Text(theme.fg(style.color, `  └${"─".repeat(boxInnerWidth)}┘`), 2, 0),
        );

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
      };

      return {
        render: (w: number) => {
          if (w !== lastWidth) {
            build(w);
            lastWidth = w;
          }
          return container.render(w);
        },
        invalidate: () => {
          lastWidth = -1;
          container.invalidate();
        },
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
