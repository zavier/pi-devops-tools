/**
 * /db related —— 关联表浏览器。
 *
 * 以 overlay 悬浮层浏览最近一次关联查询的关联表：
 * - ←/→ 或 Tab 切换关联表
 * - ↑/↓ 行级滚动，PgUp/PgDn 页级滚动
 * - Esc 关闭
 *
 * 数据来自 query.ts 的最近关联查询缓存（会话内有效）。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { formatTableDisplay } from "../formatting/result-table";
import type { RelatedTuiData } from "./renderers";

// ── 缓存类型（query.ts 填充，db.ts 消费）─────────────

export interface RelatedBrowserCache {
  database: string;
  sql: string;
  related: RelatedTuiData[];
}

// ── 表切换 reducer（纯函数，可单测）────────────────

export interface BrowserNav {
  action: "switch" | "close" | "none";
  index: number;
}

/**
 * 关联表切换的纯 reducer。
 *
 * ← / Tab 上一张表，→ / Shift+Tab 下一张表（循环），Esc 关闭，
 * 其余键原样透传（滚动键由组件自己处理——clamp 需要内容高度）。
 */
export function createBrowserNav(total: number): {
  handleKey: (data: string) => BrowserNav;
  getIndex: () => number;
} {
  let index = 0;

  function handleKey(data: string): BrowserNav {
    if (matchesKey(data, Key.escape)) {
      return { action: "close", index };
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.tab)) {
      index = (index - 1 + total) % total;
      return { action: "switch", index };
    }

    if (matchesKey(data, Key.right) || matchesKey(data, "shift+tab")) {
      index = (index + 1) % total;
      return { action: "switch", index };
    }

    return { action: "none", index };
  }

  return { handleKey, getIndex: () => index };
}

// ── 内容生成（纯函数，可单测）──────────────────────

/**
 * 生成浏览器内容行：标题 + 表切换行 + 关联路径 + 当前表表格。
 * 无 theme 依赖，方便单独测试。
 */
export function formatBrowserContent(
  cache: RelatedBrowserCache,
  index: number,
  width: number,
): string[] {
  const r = cache.related[index];
  if (!r) return [];

  const lines: string[] = [];

  // 标题行（含操作提示）
  lines.push(
    `📎 关联表浏览器 — ${cache.database}（${cache.related.length} 个）  [←→ 切换 · ↑↓ 滚动 · Esc 关闭]`,
  );

  // 表切换行：当前表 ▶ 高亮
  const tabs = cache.related
    .map((x, i) =>
      i === index ? `▶ ${x.table}（${x.rowCount} 行）` : `  ${x.table}（${x.rowCount} 行）`,
    )
    .join("  ");
  lines.push(tabs);

  // 关联路径
  if (r.joinPath) lines.push(`路径：${r.joinPath}`);
  lines.push("");

  // 当前表内容
  if (r.rows.length > 0) {
    const table = formatTableDisplay(
      { columns: r.columns, rows: r.rows as any },
      Math.max(40, width - 4),
    );
    lines.push(...table.split("\n"));
  } else {
    lines.push("（空结果）");
  }

  return lines;
}

// ── Overlay 组件 ─────────────────────────────────────

/** 内容区可视高度（标题/tabs/路径/空行占 3-4 行）。 */
function viewportHeight(termRows: number): number {
  return Math.max(5, Math.floor(termRows * 0.7) - 3);
}

/**
 * 打开关联表浏览器 overlay。
 * 切换表时重置滚动；滚动按内容行数与可视高度 clamp。
 */
export async function openRelatedBrowser(
  ctx: ExtensionCommandContext,
  cache: RelatedBrowserCache,
): Promise<void> {
  if (cache.related.length === 0) {
    ctx.ui.notify("没有关联表可浏览", "info");
    return;
  }

  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const nav = createBrowserNav(cache.related.length);
      let scroll = 0;

      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      const contentText = new Text("", 1, 0);
      container.addChild(contentText);

      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      /** 重建内容文本：按当前表与滚动位置切片。 */
      const build = (): void => {
        const viewport = viewportHeight(tui.terminal.rows);
        const lines = formatBrowserContent(cache, nav.getIndex(), tui.terminal.columns);
        const maxScroll = Math.max(0, lines.length - viewport);
        scroll = Math.min(scroll, maxScroll);
        contentText.setText(lines.slice(scroll, scroll + viewport).join("\n"));
      };

      build();

      return {
        render: (w) => container.render(w),
        invalidate: () => {
          build();
          container.invalidate();
        },
        handleInput: (data: string) => {
          const navResult = nav.handleKey(data);
          if (navResult.action === "close") {
            done(null);
            return;
          }
          if (navResult.action === "switch") {
            scroll = 0;
            build();
            tui.requestRender();
            return;
          }

          // 滚动：需要内容高度计算 maxScroll
          const viewport = viewportHeight(tui.terminal.rows);
          const lines = formatBrowserContent(cache, nav.getIndex(), tui.terminal.columns);
          const maxScroll = Math.max(0, lines.length - viewport);

          if (matchesKey(data, Key.up)) {
            scroll = Math.max(0, scroll - 1);
          } else if (matchesKey(data, Key.down)) {
            scroll = Math.min(maxScroll, scroll + 1);
          } else if (matchesKey(data, Key.pageUp)) {
            scroll = Math.max(0, scroll - viewport);
          } else if (matchesKey(data, Key.pageDown)) {
            scroll = Math.min(maxScroll, scroll + viewport);
          } else {
            return;
          }

          build();
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "92%", maxHeight: "75%", margin: 2 },
    },
  );
}
