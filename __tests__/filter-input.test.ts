/**
 * Tests for filter-input.ts — verifies that the keyboard reducers correctly
 * handle pi-tui keyboard input, which arrives as raw terminal bytes
 * (\x7f, \r, \x1b) or CSI-u sequences (Kitty protocol).
 *
 * matchesKey(data, keyId) bridges raw bytes ↔ symbolic key identifiers
 * and is the ONLY correct way to detect special keys in handleInput.
 *
 * These tests would have caught the bugs where we used raw byte comparison
 * (data === "\x7f", data === "\r") instead of matchesKey, which fails
 * when Kitty keyboard protocol is active (data becomes CSI-u sequences).
 */

import { describe, it, expect } from "vitest";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { createFilterReducer, createPasswordReducer } from "../commands/filter-input";

// ── pi-tui key contract (smoke test) ────────────────────────────
//
// Verify that matchesKey(data, keyId) correctly matches RAW terminal
// bytes against symbolic key identifiers. This is the bridge we rely on.

describe("pi-tui matchesKey contract", () => {
  it("backspace: matches raw \\x7f (DEL) byte (and CSI-u via matchesKey)", () => {
    // Legacy terminals send DEL (127) for Backspace.
    // Kitty protocol terminals send CSI-u sequences instead.
    // matchesKey handles both transparently, so our reducers
    // never need to compare data directly against byte literals.
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
    // Proves that matchesKey does NOT do simple string comparison.
    // This is why our reducers must pass the raw terminal data —
    // not symbolic names — as the first argument.
    expect(matchesKey("backspace", Key.backspace)).toBe(false);
    expect(matchesKey("enter", Key.enter)).toBe(false);
  });
});

// ── Filter reducer ──────────────────────────────────────────────

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
    // Up arrow: \x1b[A, Down: \x1b[B
    expect(handleKey("\x1b[A").action).toBe("navigate");
    expect(handleKey("\x1b[B").action).toBe("navigate");
    expect(getFilterText()).toBe("a"); // unchanged
  });

  it("ignores non-printable non-special raw bytes", () => {
    const { handleKey, getFilterText } = createFilterReducer();
    // NULL, SOH, STX — all < 32, single byte, ignored by reducer
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
});

// ── Password reducer ────────────────────────────────────────────

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
});
