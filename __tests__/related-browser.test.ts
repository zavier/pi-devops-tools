/**
 * commands/related-browser.ts 的测试——表切换 reducer、内容分段生成、
 * 滚动信息与底栏纯函数。
 *
 * reducer 接收原始终端字节（\x1b[D 等 CSI 序列或 Kitty CSI-u），
 * 通过 matchesKey 解码——与 filter-input 测试同一契约。
 */
import { describe, it, expect } from "vitest";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import {
  createBrowserNav,
  buildBrowserContent,
  formatScrollInfo,
  formatBrowserFooter,
} from "../commands/related-browser";
import type { RelatedBrowserCache } from "../commands/related-browser";

/** 构造一条浏览器缓存（两个关联表）。 */
function cache(over: Partial<RelatedBrowserCache> = {}): RelatedBrowserCache {
  return {
    database: "shop",
    sql: "SELECT * FROM `orders`",
    related: [
      {
        schema: "shop",
        table: "users",
        joinPath: "orders.user_id → users.id",
        rowCount: 1,
        elapsed: "0.001s",
        columns: ["id", "name"],
        rows: [{ id: "1", name: "alice" }],
      },
      {
        schema: "shop",
        table: "products",
        joinPath: "orders.product_id → products.id",
        rowCount: 2,
        elapsed: "0.002s",
        columns: ["id", "title"],
        rows: [
          { id: "10", title: "keyboard" },
          { id: "11", title: "mouse" },
        ],
      },
    ],
    ...over,
  };
}

// ====== createBrowserNav ======

describe("createBrowserNav", () => {
  it("初始 index 为 0", () => {
    const nav = createBrowserNav(2);
    expect(nav.getIndex()).toBe(0);
  });

  it("→ 切到下一张表", () => {
    const nav = createBrowserNav(2);
    expect(nav.handleKey("\x1b[C")).toEqual({ action: "switch", index: 1 });
    expect(nav.getIndex()).toBe(1);
  });

  it("← 切到上一张表", () => {
    const nav = createBrowserNav(2);
    nav.handleKey("\x1b[C");
    expect(nav.handleKey("\x1b[D")).toEqual({ action: "switch", index: 0 });
  });

  it("表切换循环：第一张表 ← 回到最后一张", () => {
    const nav = createBrowserNav(3);
    expect(nav.handleKey("\x1b[D")).toEqual({ action: "switch", index: 2 });
  });

  it("Tab 等价于 →，Shift+Tab 等价于 ←", () => {
    const nav = createBrowserNav(2);
    expect(nav.handleKey("\t")).toEqual({ action: "switch", index: 1 });
    expect(nav.handleKey("\x1b[Z")).toEqual({ action: "switch", index: 0 });
  });

  it("Esc 返回 close", () => {
    const nav = createBrowserNav(2);
    expect(nav.handleKey("\x1b")).toEqual({ action: "close", index: 0 });
  });

  it("其他键（含滚动键）原样透传为 none", () => {
    const nav = createBrowserNav(2);
    expect(nav.handleKey("\x1b[A")).toEqual({ action: "none", index: 0 });
    expect(nav.handleKey("\x1b[B")).toEqual({ action: "none", index: 0 });
    expect(nav.handleKey("a")).toEqual({ action: "none", index: 0 });
  });

  it("matchesKey 契约：方向键原始字节可识别", () => {
    expect(matchesKey("\x1b[D", Key.left)).toBe(true);
    expect(matchesKey("\x1b[C", Key.right)).toBe(true);
    expect(matchesKey("\t", Key.tab)).toBe(true);
    expect(matchesKey("\x1b[Z", "shift+tab")).toBe(true);
  });
});

// ====== buildBrowserContent ======

describe("buildBrowserContent", () => {
  it("title 包含数据库名与关联表数量", () => {
    const content = buildBrowserContent(cache(), 0, 80);
    expect(content.title).toContain("shop");
    expect(content.title).toContain("2 个关联表");
  });

  it("tabs：当前表 active 标记正确", () => {
    const content = buildBrowserContent(cache(), 1, 80);
    expect(content.tabs).toEqual([
      { label: "users（1 行）", active: false },
      { label: "products（2 行）", active: true },
    ]);
  });

  it("显示当前表的关联路径", () => {
    const content = buildBrowserContent(cache(), 0, 80);
    expect(content.path).toBe("orders.user_id → users.id");
  });

  it("渲染当前表的表格内容", () => {
    const content = buildBrowserContent(cache(), 1, 80);
    expect(content.empty).toBe(false);
    expect(content.table.join("\n")).toContain("keyboard");
    expect(content.table.join("\n")).toContain("mouse");
  });

  it("空表：empty=true 且无表格行", () => {
    const c = cache();
    c.related[0].rows = [];
    const content = buildBrowserContent(c, 0, 80);
    expect(content.empty).toBe(true);
    expect(content.table).toEqual([]);
  });

  it("index 越界返回空结构", () => {
    const content = buildBrowserContent(cache(), 99, 80);
    expect(content).toEqual({ title: "", tabs: [], path: "", table: [], empty: true });
  });

  it("关联表超过 6 个时折叠为 … 还有 N 个", () => {
    const c = cache();
    for (let i = 2; i < 9; i++) {
      c.related.push({
        schema: "shop",
        table: `t${i}`,
        joinPath: "",
        rowCount: 0,
        elapsed: "0.001s",
        columns: ["id"],
        rows: [],
      });
    }
    const content = buildBrowserContent(c, 0, 80);
    expect(content.tabs.length).toBe(7); // 6 个 + 折叠项
    expect(content.tabs[6]).toEqual({ label: "… 还有 3 个", active: false });
  });
});

// ====== formatScrollInfo / formatBrowserFooter ======

describe("formatScrollInfo", () => {
  it("内容不超可视高度时为空", () => {
    expect(formatScrollInfo(0, 20, 10)).toBe("");
  });

  it("有滚动时返回 起始-结束/总数 行", () => {
    expect(formatScrollInfo(0, 20, 30)).toBe("1-20/30 行");
    expect(formatScrollInfo(2, 20, 30)).toBe("3-22/30 行");
  });

  it("滚动到底部时结束值取总数", () => {
    expect(formatScrollInfo(25, 20, 30)).toBe("26-30/30 行");
  });
});

describe("formatBrowserFooter", () => {
  it("无滚动时只显示快捷键提示", () => {
    const text = formatBrowserFooter(0, 20, 10);
    expect(text).toContain("←→ 切换");
    expect(text).toContain("Esc 关闭");
    expect(text).not.toContain("行");
  });

  it("有滚动时附加位置信息", () => {
    expect(formatBrowserFooter(0, 20, 30)).toBe(
      "←→ 切换 · ↑↓ 滚动 · PgUp/PgDn 翻页 · Esc 关闭    1-20/30 行",
    );
  });
});
