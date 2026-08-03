/**
 * 显示宽度（终端列数）的纯函数工具——纯函数，无 I/O。
 *
 * TUI 的宽度断言（doRender）以 pi-tui 的 visibleWidth 为基准，
 * 布局/截断必须与它同一把尺子：中文、emoji 等宽字符占 2 列，
 * 按 UTF-16 码元（s.length）截断/补齐会让行超宽并崩溃。
 *
 * 注意：本模块处理的是纯文本（无 ANSI）——样式化文本请用
 * pi-tui 的 truncateToWidth（它感知 ANSI 序列）。
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * 纯文本按显示宽度截断，超出部分替换为省略号。
 *
 * 不用 pi-tui 的 truncateToWidth——它会注入 \x1b[0m reset，
 * 破坏表格行等处的纯文本契约。
 */
export function truncateToDisplayWidth(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  let w = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const cw = visibleWidth(s[i]);
    if (w + cw > max - 1) break;
    w += cw;
  }
  return s.slice(0, i) + "…";
}

/** 按显示宽度右补齐到 w 列（超出时不补齐，原样返回）。 */
export function padToDisplayWidth(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - visibleWidth(s)));
}
