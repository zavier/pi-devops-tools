import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readToggle, togglePath, writeToggle } from "../state/extension-toggle";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "db-ext-toggle-"));
}

describe("extension-toggle", () => {
  it("缺失文件回退默认启用", () => {
    expect(readToggle(makeDir())).toBe(true);
  });

  it("目录不存在时同样回退默认启用", () => {
    expect(readToggle(join(makeDir(), "no-such-dir"))).toBe(true);
  });

  it("writeToggle 往返：true → false → true", () => {
    const dir = makeDir();
    writeToggle(dir, true);
    expect(readToggle(dir)).toBe(true);
    writeToggle(dir, false);
    expect(readToggle(dir)).toBe(false);
    writeToggle(dir, true);
    expect(readToggle(dir)).toBe(true);
  });

  it("writeToggle 自动创建缺失目录", () => {
    const dir = join(makeDir(), "nested", "deep");
    writeToggle(dir, false);
    expect(readToggle(dir)).toBe(false);
  });

  it("损坏 JSON 回退默认启用", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "extension.json"), "{ not json", "utf8");
    expect(readToggle(dir)).toBe(true);
  });

  it("字段非法（非布尔）回退默认启用", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "extension.json"), JSON.stringify({ enabled: "yes" }), "utf8");
    expect(readToggle(dir)).toBe(true);
  });

  it("空对象视为启用", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "extension.json"), "{}", "utf8");
    expect(readToggle(dir)).toBe(true);
  });

  it("togglePath 拼接文件名", () => {
    expect(togglePath("/tmp/x")).toBe(join("/tmp/x", "extension.json"));
  });
});
