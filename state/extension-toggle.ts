/**
 * 扩展开关状态读写（纯函数，路径注入）。
 *
 * 开关状态存 <baseDir>/extension.json（生产为 ~/.pi/database，与 StateStore
 * 默认基目录一致）。扩展工厂执行时同步读取——一次性决定注册哪些资源
 * （tools / skills / renderers / 命令），配合 /db on|off 命令 + ctx.reload()
 * 实现会话内开关（见 docs/extension-toggle.md）。
 *
 * 容错策略：文件缺失、JSON 损坏、字段非法一律回退默认启用——升级兼容优先，
 * "禁用"必须来自显式的 { enabled: false }。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 开关状态文件路径。 */
export function togglePath(baseDir: string): string {
  return join(baseDir, "extension.json");
}

/** 读取开关状态；仅显式 { enabled: false } 视为禁用，其余（含缺失/损坏）默认启用。 */
export function readToggle(baseDir: string): boolean {
  try {
    const raw = readFileSync(togglePath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}

/** 原子写开关状态（临时文件 + rename），目录不存在时自动创建。 */
export function writeToggle(baseDir: string, enabled: boolean): void {
  const path = togglePath(baseDir);
  mkdirSync(baseDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ enabled }), "utf8");
  renameSync(tmp, path);
}
