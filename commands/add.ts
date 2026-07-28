/**
 * /db add — interactive wizard to create a new database connection.
 *
 * Walks the user through environment → name → host → port → credentials
 * via sequential UI prompts, then writes to ~/.pi/database/connections.yaml
 * and hot-reloads. No LLM involved for credential entry.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

export async function handleAdd(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/db add 需要交互模式", "error");
    return;
  }

  // --- Environment ---
  const envs = ws.getEnvironments();
  let env: string;
  if (envs.length === 0) {
    env = "default";
  } else {
    const choice = await ctx.ui.select("选择环境（新建连接加入此环境）", [...envs, "新建环境…"]);
    if (!choice) return;
    if (choice === "新建环境…") {
      const name = await ctx.ui.input("环境名称（如 prod / staging）");
      if (!name) return;
      env = name.trim();
    } else {
      env = choice;
    }
  }

  // --- Connection name ---
  const name = await ctx.ui.input(`连接名称（在 ${env} 环境下的唯一标识）`);
  if (!name) return;
  const connName = name.trim();

  // --- Host / Port ---
  const host = await ctx.ui.input("主机地址", "localhost");
  if (!host) return;

  const portStr = await ctx.ui.input("端口", "3306");
  if (!portStr) return;
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    ctx.ui.notify("端口必须是 1-65535 的数字", "error");
    return;
  }

  // --- Credentials ---
  const username = await ctx.ui.input("用户名", "root");
  if (!username) return;

  const password = await ctx.ui.input("密码（或 ${ENV_VAR} 占位符）");
  // Allow empty password for local dev.
  const pwd = password ?? "";

  // --- Default database (optional) ---
  const database = await ctx.ui.input("默认数据库（可选，留空则每次选择）");
  const defaultDb = database?.trim() || undefined;

  // --- Confirm ---
  const summary = [
    `环境:    ${env}`,
    `名称:    ${connName}`,
    `主机:    ${host}:${port}`,
    `用户名:  ${username}`,
    `密码:    ${pwd ? (pwd.includes("${") ? pwd : "***") : "(空)"}`,
    defaultDb ? `默认数据库: ${defaultDb}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  const ok = await ctx.ui.confirm("确认创建连接？", summary);
  if (!ok) return;

  // --- Write ---
  try {
    ws.createConnection(env, connName, {
      environment: env,
      type: "mysql",
      host,
      port,
      username,
      password: pwd,
      defaultDatabase: defaultDb,
    });
  } catch (err: any) {
    ctx.ui.notify(`写入配置失败：${err.message}`, "error");
    return;
  }

  ctx.ui.notify(`✅ 已添加连接 "${connName}" 到 ${env} 环境。运行 /db switch 连接它。`);
}
