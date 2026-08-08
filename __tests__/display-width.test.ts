import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  padToDisplayWidth,
  truncateToDisplayWidth,
  wrapToDisplayWidth,
} from "../formatting/display-width";

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

describe("wrapToDisplayWidth", () => {
  it("短文本不换行", () => {
    expect(wrapToDisplayWidth("hello", 20)).toEqual(["hello"]);
  });

  it("空字符串返回单个空行", () => {
    expect(wrapToDisplayWidth("", 10)).toEqual([""]);
  });

  it("ASCII 按列切分，每段 ≤ w 列", () => {
    const lines = wrapToDisplayWidth("A".repeat(25), 10);
    expect(lines).toEqual(["A".repeat(10), "A".repeat(10), "A".repeat(5)]);
  });

  it("中文按显示宽度切分（每字 2 列），不劈开字符", () => {
    // 10 列 = 5 个汉字；13 个汉字 → [5 字, 5 字, 3 字]
    const s = "产品名称订单详情编号测试好";
    const lines = wrapToDisplayWidth(s, 10);
    expect(lines.map((l) => visibleWidth(l))).toEqual([10, 10, 6]);
    expect(lines.join("")).toBe(s);
  });

  it("emoji（代理对）不被劈开", () => {
    const s = "ab📦cd";
    const lines = wrapToDisplayWidth(s, 4);
    expect(lines.join("")).toBe(s);
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(4);
    }
    // 📦 占 2 列且完整落在某一行，不产生替换符
    expect(lines.some((l) => l.includes("📦"))).toBe(true);
  });

  it("w < 1 时原样返回（退化兜底）", () => {
    expect(wrapToDisplayWidth("abc", 0)).toEqual(["abc"]);
  });

  it("混合中英文时每段 ≤ w 列且拼接还原", () => {
    const s = "UPDATE 产品表 SET 名称='新名称' WHERE id=12345";
    const lines = wrapToDisplayWidth(s, 12);
    expect(lines.join("")).toBe(s);
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(12);
    }
  });
});
