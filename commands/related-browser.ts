/**
 * /db related —— 关联表浏览器。
 *
 * 以 overlay 悬浮层浏览最近一次关联查询的关联表：
 * - ←/→ 或 Tab 切换关联表
 * - ↑/↓ 行级滚动，PgUp/PgDn 页级滚动
 * - Esc 关闭
 *
 * 数据来自 query.ts 的最近关联查询缓存（会话内有效）。
 *
 * 视觉层次（自上而下）：
 *   ┌ 边框（accent）──────────────┐
 *   │ 📎 关联表浏览器 — db（N 个）   │ ← 标题：accent+bold + dim 副标题
 *   │ ▶ users（2 行）  products     │ ← 表切换：当前表 accent+bold，其余 dim
 *   │ 路径：orders.user_id → users  │ ← muted
 *   │ ────────── 分隔线 ─────────   │
 *   │ (表格内容，滚动区)             │
 *   │ ←→ 切换 · ↑↓ 滚动 · Esc 关闭  [1-12/30 行] ← 底栏 dim + 滚动位置
 *   └──────────────────────────────┘
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Box, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatTableDisplay } from "../formatting/result-table";
import type { RelatedTuiData } from "./renderers";

// ── 缓存类型（query.ts 填充，db.ts 消费）─────────────

export interface RelatedBrowserCache {
  database: string;
  sql: string;
  related: RelatedTuiData[];
}

/**
 * 最近关联查询缓存的持有者——经调用链注入（db.ts 注册时创建、
 * 传给 query 路径写入、related 路径读取），替代 module 级单例。
 */
export class RelatedBrowserCacheStore {
  private current: RelatedBrowserCache | null = null;

  set(cache: RelatedBrowserCache): void {
    this.current = cache;
  }

  get(): RelatedBrowserCache | null {
    return this.current;
  }
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

/** 表切换行的一项。active 表示当前正在浏览的表。 */
export interface BrowserTab {
  label: string;
  active: boolean;
}

/** 浏览器内容的分段结构——组件渲染时对每段套不同样式。 */
interface BrowserContent {
  /** 副标题（数据库名 + 关联表数量），如 `shop（2 个关联表）`。 */
  title: string;
  /** 表切换行（当前表 active=true）。 */
  tabs: BrowserTab[];
  /** 当前表的关联路径；无则为空字符串。 */
  path: string;
  /** 当前表表格行（已按宽度自适应格式化）。 */
  table: string[];
  /** 当前表无数据。 */
  empty: boolean;
}

/** 表切换行最多展示的标签数，超出折叠为 `… 还有 N 个`。 */
const MAX_TABS = 6;

/**
 * 构建浏览器内容的分段结构。无 theme 依赖，方便单独测试。
 * 样式（颜色/加粗）由组件在渲染时应用。
 */
export function buildBrowserContent(
  cache: RelatedBrowserCache,
  index: number,
  width: number,
): BrowserContent {
  const r = cache.related[index];
  if (!r) {
    return { title: "", tabs: [], path: "", table: [], empty: true };
  }

  let tabs: BrowserTab[] = cache.related.map((x, i) => ({
    label: `${x.table}（${x.rowCount} 行）`,
    active: i === index,
  }));
  if (tabs.length > MAX_TABS) {
    tabs = tabs.slice(0, MAX_TABS);
    tabs.push({ label: `… 还有 ${cache.related.length - MAX_TABS} 个`, active: false });
  }

  const table =
    r.rows.length > 0
      ? formatTableDisplay(
          { columns: r.columns, rows: r.rows as any },
          Math.max(40, width - 4),
        ).split("\n")
      : [];

  return {
    title: `${cache.database}（${cache.related.length} 个关联表）`,
    tabs,
    path: r.joinPath,
    table,
    empty: r.rows.length === 0,
  };
}

/** 表格总行数超过可视高度时返回滚动位置文本（如 `1-12/30 行`），否则空。 */
export function formatScrollInfo(scroll: number, visible: number, total: number): string {
  if (total <= visible) return "";
  const end = Math.min(scroll + visible, total);
  return `${scroll + 1}-${end}/${total} 行`;
}

/** 底栏文本：快捷键提示 + 滚动位置（可测试的纯文本）。 */
export function formatBrowserFooter(scroll: number, visible: number, total: number): string {
  const hint = "←→ 切换 · ↑↓ 滚动 · PgUp/PgDn 翻页 · Esc 关闭";
  const info = formatScrollInfo(scroll, visible, total);
  return info ? `${hint}    ${info}` : hint;
}

// ── Overlay 组件 ─────────────────────────────────────

/** 内容区可视高度（边框+标题+切换行+路径+分隔线+底栏约占 6-7 行）。 */
function viewportHeight(termRows: number): number {
  return Math.max(5, Math.floor(termRows * 0.7) - 7);
}

/**
 * 打开关联表浏览器 overlay。
 *
 * 整个弹窗用 Box 包裹并以 customMessageBg 填充不透明背景，
 * 避免与下层聊天/编辑器内容混叠；边框用主题的 borderAccent 色。
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
      /** 最近一次渲染的 overlay 宽度——build 用它计算表格布局宽度。 */
      let lastWidth = 80;

      // Box 提供不透明背景（selectedBg：两主题下均为中性蓝灰，
      // 与聊天区/终端底色区分明显）与统一内边距。
      const box = new Box(1, 1, (s) => theme.bg("selectedBg", s));
      box.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));

      const titleText = new Text("", 0, 0);
      box.addChild(titleText);

      const tabsText = new Text("", 0, 0);
      box.addChild(tabsText);

      const pathText = new Text("", 0, 0);
      box.addChild(pathText);

      const separatorText = new Text("", 0, 0);
      box.addChild(separatorText);

      const tableText = new Text("", 0, 0);
      box.addChild(tableText);

      const footerText = new Text("", 0, 0);
      box.addChild(footerText);

      box.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));

      /** 重建各段文本：按当前表、滚动位置与 overlay 宽度应用样式。 */
      const build = (): void => {
        // Box 左右 padding 各 1，内容可用宽度 = overlay 宽度 - 2。
        const contentWidth = Math.max(40, lastWidth - 2);
        const content = buildBrowserContent(cache, nav.getIndex(), contentWidth);
        const viewport = viewportHeight(tui.terminal.rows);
        const maxScroll = Math.max(0, content.table.length - viewport);
        scroll = Math.min(scroll, maxScroll);

        // 所有行都用 truncateToWidth 截断到内容宽度——长表名/长路径/窄终端
        // 下 Text 不会自动截断，超宽行会触发 TUI 的宽度断言崩溃。
        titleText.setText(
          truncateToWidth(
            theme.fg("accent", theme.bold("📎 关联表浏览器")) +
              theme.fg("dim", ` — ${content.title}`),
            contentWidth,
          ),
        );

        tabsText.setText(
          truncateToWidth(
            content.tabs
              .map((t) =>
                t.active
                  ? theme.fg("accent", theme.bold(`▶ ${t.label}`))
                  : theme.fg("dim", `   ${t.label}`),
              )
              .join("  "),
            contentWidth,
          ),
        );

        pathText.setText(
          truncateToWidth(
            content.path ? theme.fg("muted", `路径：${content.path}`) : " ",
            contentWidth,
          ),
        );

        separatorText.setText(theme.fg("dim", "─".repeat(Math.max(10, contentWidth))));

        if (content.empty) {
          tableText.setText(theme.fg("warning", "（空结果）"));
        } else {
          // 表格行是纯文本（无 ANSI）——显式套主题 text 前景色，
          // 避免继承终端默认前景色（浅色主题下会出现白字浅底）。
          tableText.setText(
            content.table
              .slice(scroll, scroll + viewport)
              .map((line) => truncateToWidth(theme.fg("text", line), contentWidth))
              .join("\n"),
          );
        }

        footerText.setText(
          truncateToWidth(
            theme.fg("dim", formatBrowserFooter(scroll, viewport, content.table.length)),
            contentWidth,
          ),
        );
      };

      build();

      return {
        render: (w) => {
          lastWidth = w;
          return box.render(w);
        },
        invalidate: () => {
          build();
          box.invalidate();
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
          const content = buildBrowserContent(cache, nav.getIndex(), Math.max(40, lastWidth - 2));
          const viewport = viewportHeight(tui.terminal.rows);
          const maxScroll = Math.max(0, content.table.length - viewport);

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
