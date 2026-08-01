/**
 * commands/related-browser.ts 的测试——表切换 reducer 与内容生成纯函数。
 *
 * reducer 接收原始终端字节（\x1b[D 等 CSI 序列或 Kitty CSI-u），
 * 通过 matchesKey 解码——与 filter-input 测试同一契约。
 */
import { describe, it, expect } from "vitest";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { createBrowserNav, formatBrowserContent } from "../commands/related-browser";
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

// ====== formatBrowserContent ======

describe("formatBrowserContent", () => {
  it("标题行包含数据库名与关联表数量", () => {
    const lines = formatBrowserContent(cache(), 0, 80);
    expect(lines[0]).toContain("shop");
    expect(lines[0]).toContain("2 个");
  });

  it("表切换行：当前表带 ▶ 标记", () => {
    const lines = formatBrowserContent(cache(), 1, 80);
    const tabs = lines[1];
    expect(tabs).toContain("▶ products（2 行）");
    expect(tabs).toContain("  users（1 行）");
  });

  it("显示当前表的关联路径", () => {
    const lines = formatBrowserContent(cache(), 0, 80);
    expect(lines.join("\n")).toContain("路径：orders.user_id → users.id");
  });

  it("渲染当前表的表格内容", () => {
    const lines = formatBrowserContent(cache(), 1, 80);
    const text = lines.join("\n");
    expect(text).toContain("keyboard");
    expect(text).toContain("mouse");
  });

  it("空表输出（空结果）占位", () => {
    const c = cache();
    c.related[0].rows = [];
    const lines = formatBrowserContent(c, 0, 80);
    expect(lines.join("\n")).toContain("（空结果）");
  });

  it("index 越界返回空数组", () => {
    expect(formatBrowserContent(cache(), 99, 80)).toEqual([]);
  });
});
