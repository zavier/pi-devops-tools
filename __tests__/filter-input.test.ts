/**
 * filter-input.ts 的测试——验证键盘 reducer 正确处理
 * pi-tui 键盘输入（以原始终端字节到达）
 * （\x7f、\r、\x1b）或 CSI-u 序列（Kitty 协议）。
 *
 * matchesKey(data, keyId) 在原始字节 ↔ 符号键标识之间搭桥，
 * 是在 handleInput 中检测特殊键的唯一正确方式。
 *
 * 这些测试本可以抓住我们曾用原始字节比较的 bug
 * （data === "\x7f"、data === "\r"）而不是 matchesKey——在
 * Kitty 键盘协议激活时（data 变成 CSI-u 序列）会失败。
 */

import { describe, it, expect } from "vitest";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { createFilterReducer, createPasswordReducer } from "../commands/filter-input";

// ── pi-tui 按键契约（冒烟测试）───────────────────────────
//
// 验证 matchesKey(data, keyId) 正确匹配原始终端字节与符号键标识——这是我们依赖的桥梁。
//

describe("pi-tui matchesKey contract", () => {
  it("backspace: matches raw \\x7f (DEL) byte (and CSI-u via matchesKey)", () => {
    // 传统终端用 DEL (127) 发送 Backspace。
    // Kitty 协议终端则发送 CSI-u 序列。
    // matchesKey 透明地处理两者，因此我们的 reducer
    // 永远不需要直接拿 data 与字节字面量比较。
    expect(matchesKey("\x7f", Key.backspace)).toBe(true);
  });

  it("enter: matches raw \\r (CR) byte", () => {
    expect(matchesKey("\r", Key.enter)).toBe(true);
  });

  it("escape: matches raw \\x1b (ESC) byte", () => {
    expect(matchesKey("\x1b", Key.escape)).toBe(true);
  });

  it("delete: matches raw \\x1b[3~ (VT-style) sequence", () => {
    expect(matchesKey("\x1b[3~", Key.delete)).toBe(true);
  });

  it("printable chars do NOT match special keys", () => {
    expect(matchesKey("a", Key.backspace)).toBe(false);
    expect(matchesKey("a", Key.enter)).toBe(false);
    expect(matchesKey("a", Key.escape)).toBe(false);
  });

  it("symbolic names do NOT match (matchesKey expects raw bytes)", () => {
    // 证明 matchesKey 不做简单的字符串比较。
    // 这就是为什么 reducer 必须把原始终端数据——
    // 而不是符号名——作为第一个参数。
    expect(matchesKey("backspace", Key.backspace)).toBe(false);
    expect(matchesKey("enter", Key.enter)).toBe(false);
  });
});

// ── 过滤 reducer ──────────────────────────────────────────────

describe("createFilterReducer", () => {
  it("accumulates printable characters", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    handleKey("u");
    handleKey("s");
    handleKey("e");
    handleKey("r");
    expect(getFilterText()).toBe("user");
  });

  it("handles CJK characters", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    handleKey("用");
    handleKey("户");
    expect(getFilterText()).toBe("用户");
  });

  it("removes last character on backspace (raw \\x7f)", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    handleKey("a");
    handleKey("b");
    handleKey("c");
    expect(getFilterText()).toBe("abc");

    const result = handleKey("\x7f"); // raw DEL byte
    expect(result.action).toBe("filter");
    expect(getFilterText()).toBe("ab");
  });

  it("removes last character on delete (raw \\x1b[3~)", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    handleKey("x");
    handleKey("y");
    expect(getFilterText()).toBe("xy");

    handleKey("\x1b[3~");
    expect(getFilterText()).toBe("x");
  });

  it("backspace on empty filter is a no-op", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    const result = handleKey("\x7f");
    expect(result.action).toBe("filter");
    expect(getFilterText()).toBe("");
  });

  it("passes through enter (raw \\r) as navigate action", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    handleKey("t");
    const result = handleKey("\r");
    expect(result.action).toBe("navigate");
    expect(getFilterText()).toBe("t"); // filterText unchanged
  });

  it("passes through escape (raw \\x1b) as navigate action", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    const result = handleKey("\x1b");
    expect(result.action).toBe("navigate");
    expect(getFilterText()).toBe("");
  });

  it("passes through arrow keys as navigate action", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    handleKey("a");
    // 上箭头：\x1b[A，下箭头：\x1b[B
    expect(handleKey("\x1b[A").action).toBe("navigate");
    expect(handleKey("\x1b[B").action).toBe("navigate");
    expect(getFilterText()).toBe("a"); // unchanged
  });

  it("ignores non-printable non-special raw bytes", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    // NULL、SOH、STX —— 都 < 32，单字节，reducer 忽略
    expect(handleKey("\x00").action).toBe("navigate");
    expect(handleKey("\x01").action).toBe("navigate");
    expect(getFilterText()).toBe("");
  });

  it("multiple backspaces work in sequence", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    for (const ch of "hello") handleKey(ch);
    expect(getFilterText()).toBe("hello");

    handleKey("\x7f");
    handleKey("\x7f");
    handleKey("\x7f");
    expect(getFilterText()).toBe("he");
  });

  describe("bracketed paste", () => {
    it("extracts and appends pasted content", () => {
      const { handleKey, getFilterText } = createFilterReducer();
      // pi 用 \x1b[200~ ... \x1b[201~ 包裹粘贴内容
      handleKey("\x1b[200~user\x1b[201~");
      expect(getFilterText()).toBe("user");
    });

    it("filters out non-printable chars from paste", () => {
      const { handleKey, getFilterText } = createFilterReducer();
      // 粘贴内容中的 Tab 和换行会被剥掉
      handleKey("\x1b[200~a\tb\nc\x1b[201~");
      expect(getFilterText()).toBe("abc");
    });

    it("appends paste to existing filter text", () => {
      const { handleKey, getFilterText } = createFilterReducer();
      handleKey("h");
      handleKey("e");
      handleKey("\x1b[200~llo\x1b[201~");
      expect(getFilterText()).toBe("hello");
    });

    it("handles CJK paste content", () => {
      const { handleKey, getFilterText } = createFilterReducer();
      handleKey("\x1b[200~用户\x1b[201~");
      expect(getFilterText()).toBe("用户");
    });
  });
});

// ── 密码 reducer ────────────────────────────────────────────

describe("createPasswordReducer", () => {
  it("accumulates password characters", () => {
    const { handleKey, getPassword } = createPasswordReducer();
    handleKey("s");
    handleKey("e");
    handleKey("c");
    expect(getPassword()).toBe("sec");
  });

  it("deletes last character on backspace (raw \\x7f)", () => {
    const { handleKey, getPassword } = createPasswordReducer();
    handleKey("a");
    handleKey("b");
    const result = handleKey("\x7f");
    expect(result.action).toBe("update");
    expect(getPassword()).toBe("a");
  });

  it("returns submit action on enter (raw \\r)", () => {
    const reducer = createPasswordReducer();
    reducer.handleKey("p");
    reducer.handleKey("w");
    const result = reducer.handleKey("\r");
    expect(result.action).toBe("submit");
    expect(result.password).toBe("pw");
  });

  it("returns cancel action on escape (raw \\x1b)", () => {
    const reducer = createPasswordReducer();
    reducer.handleKey("x");
    const result = reducer.handleKey("\x1b");
    expect(result.action).toBe("cancel");
    expect(result.password).toBe("x");
  });

  it("ignores navigation keys like arrows", () => {
    const { handleKey, getPassword } = createPasswordReducer();
    handleKey("a");
    expect(handleKey("\x1b[A").action).toBe("none");
    expect(handleKey("\x1b[B").action).toBe("none");
    expect(getPassword()).toBe("a");
  });

  it("supports ${VAR} placeholder syntax", () => {
    const { handleKey, getPassword } = createPasswordReducer();
    for (const ch of "${DB_PASS}") {
      handleKey(ch);
    }
    expect(getPassword()).toBe("${DB_PASS}");
  });

  it("handles empty password submit (allows empty)", () => {
    const { handleKey } = createPasswordReducer();
    const result = handleKey("\r");
    expect(result.action).toBe("submit");
    expect(result.password).toBe("");
  });

  describe("bracketed paste", () => {
    it("extracts and appends pasted password content", () => {
      const { handleKey, getPassword } = createPasswordReducer();
      handleKey("\x1b[200~MyP@ssw0rd!\x1b[201~");
      expect(getPassword()).toBe("MyP@ssw0rd!");
    });

    it("treats paste as update action", () => {
      const { handleKey } = createPasswordReducer();
      const result = handleKey("\x1b[200~abc\x1b[201~");
      expect(result.action).toBe("update");
    });

    it("appends paste after manual typing", () => {
      const { handleKey, getPassword } = createPasswordReducer();
      handleKey("$");
      handleKey("{");
      handleKey("\x1b[200~DB_PASS\x1b[201~");
      handleKey("}");
      expect(getPassword()).toBe("${DB_PASS}");
    });
  });
});
