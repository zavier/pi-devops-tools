/**
 * 自定义 TUI 组件的纯键盘输入 reducer。
 *
 * pi-tui 的 handleInput() 接收原始终端字节（\x7f、\r、\x1b）
 * 或 CSI-u 序列（Kitty 键盘协议）。用 matchesKey(data, keyId)
 * 解码特殊键——绝不直接拿 data 与字节字面量比较，因为 Kitty 协议
 * 发送的是多字节转义序列。
 *
 * 这些 reducer 封装了该契约，可以用原始字节输入独立做单元测试。
 *
 */

import { matchesKey, Key } from "@earendil-works/pi-tui";

// ── 括号粘贴 ─────────────────────────────────────────────
//
// pi 在终端中启用括号粘贴模式。用户粘贴时，终端会用这些转义序列
// 包裹内容。我们提取载荷，把每个可打印字符喂给 reducer。
//

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** 从括号粘贴转义序列中提取粘贴载荷。 */
function extractPaste(data: string): string | null {
  if (!data.includes(PASTE_START)) return null;
  const startIdx = data.indexOf(PASTE_START) + PASTE_START.length;
  const endIdx = data.lastIndexOf(PASTE_END);
  return endIdx > startIdx ? data.slice(startIdx, endIdx) : data.slice(startIdx);
}

// ── 过滤 reducer（用于模糊表选择器）────────────────────

export interface FilterResult {
  filterText: string;
  action: "filter" | "navigate" | "none";
}

/**
 * 模糊表选择器过滤栏的纯 reducer。
 *
 * 累积可打印字符，Backspace/Delete 删除，
 * 导航键（Enter、Esc、方向键等）直接透传。
 */
export function createFilterReducer(): {
  handleKey: (data: string) => FilterResult;
  getFilterText: () => string;
} {
  let filterText = "";

  function handleKey(data: string): FilterResult {
    // 先处理特殊键——在可打印字符判断之前，因为
    // 某些原始字节（如 DEL = 127）≥ 32，否则会被误判为可打印。
    //
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      filterText = filterText.slice(0, -1);
      return { filterText, action: "filter" };
    }

    // 括号粘贴——提取载荷并追加所有可打印字符。
    // pi 用 \x1b[200~ ... \x1b[201~ 包裹粘贴内容。
    const pasted = extractPaste(data);
    if (pasted !== null) {
      for (const ch of pasted) {
        if (ch.charCodeAt(0) >= 32) filterText += ch;
      }
      return { filterText, action: "filter" };
    }

    // 可打印字符：单个码点，码值 ≥ 32
    const code = data.charCodeAt(0);
    if (data.length === 1 && code >= 32) {
      filterText += data;
      return { filterText, action: "filter" };
    }

    // 导航键（enter、esc、方向键、tab）——原样透传
    return { filterText, action: "navigate" };
  }

  return { handleKey, getFilterText: () => filterText };
}

// ── 密码 reducer（掩码输入用）────────────────────────

export interface PasswordResult {
  password: string;
  action: "submit" | "cancel" | "update" | "none";
}

/**
 * 掩码密码输入的纯 reducer。
 *
 * Enter → 提交，Escape → 取消，Backspace → 删除最后一个字符，
 * 可打印字符 → 追加。
 */
export function createPasswordReducer(): {
  handleKey: (data: string) => PasswordResult;
  getPassword: () => string;
} {
  let password = "";

  function handleKey(data: string): PasswordResult {
    if (matchesKey(data, Key.enter)) {
      return { password, action: "submit" };
    }

    if (matchesKey(data, Key.escape)) {
      return { password, action: "cancel" };
    }

    if (matchesKey(data, Key.backspace)) {
      password = password.slice(0, -1);
      return { password, action: "update" };
    }

    // 括号粘贴——提取载荷并追加所有可打印字符。
    const pasted = extractPaste(data);
    if (pasted !== null) {
      for (const ch of pasted) {
        if (ch.charCodeAt(0) >= 32) password += ch;
      }
      return { password, action: "update" };
    }

    const code = data.charCodeAt(0);
    if (data.length === 1 && code >= 32) {
      password += data;
      return { password, action: "update" };
    }

    return { password, action: "none" };
  }

  return { handleKey, getPassword: () => password };
}
