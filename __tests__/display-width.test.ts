import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { padToDisplayWidth, truncateToDisplayWidth } from "../formatting/display-width";

describe("truncateToDisplayWidth", () => {
  it("短文本原样返回", () => {
    expect(truncateToDisplayWidth("hello", 20)).toBe("hello");
  });

  it("超宽 ASCII 截断并加省略号", () => {
    const r = truncateToDisplayWidth("A".repeat(50), 20);
    expect(visibleWidth(r)).toBeLessThanOrEqual(20);
    expect(r.endsWith("…")).toBe(true);
  });

  it("中文按显示宽度截断（每字 2 列）", () => {
    const r = truncateToDisplayWidth("产品".repeat(30), 20);
    // 20 列 = 9 个汉字 + 省略号（1 列）→ 前缀 9 字
    expect(visibleWidth(r)).toBe(19);
    expect(r.endsWith("…")).toBe(true);
  });

  it("截断不注入 ANSI（纯文本契约）", () => {
    const r = truncateToDisplayWidth("产品".repeat(30), 20);
    expect(r).not.toContain("\x1b");
  });
});

describe("padToDisplayWidth", () => {
  it("ASCII 补齐到目标宽度", () => {
    expect(visibleWidth(padToDisplayWidth("ab", 10))).toBe(10);
  });

  it("中文按显示宽度补齐（不按码元）", () => {
    const padded = padToDisplayWidth("产品", 10);
    // “产品” 显示 4 列 → 补 6 个空格
    expect(visibleWidth(padded)).toBe(10);
    expect(padded.length).toBe(8);
  });

  it("超宽时不补齐原样返回", () => {
    expect(padToDisplayWidth("A".repeat(20), 10)).toBe("A".repeat(20));
  });
});
