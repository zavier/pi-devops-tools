/**
 * /db add —— 创建新数据库连接的交互向导。
 *
 * 通过顺序 UI 提示引导用户完成 环境 → 名称 → 主机 → 端口 → 凭据，
 * 然后写入 ~/.pi/database/connections.yaml 并热重载。
 * 凭据输入不涉及 LLM。
 *
 * 相对原版的改进（安全 / UX）：
 * - 掩码密码输入（TUI 中显示星号，存储真实值）
 * - 逐字段校验（端口范围、主机非空）
 * - 保存后可选的连接测试
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { withLoader } from "./utils";
import { createPasswordReducer } from "./filter-input";

// ── 掩码密码输入 ────────────────────────────────────────

/**
 * 掩码显示（星号）的密码输入。
 * 支持 ${ENV_VAR} 占位符——掩码仍然生效，但
 * 实际值原样保存。
 */
async function maskedPassword(
  ctx: ExtensionCommandContext,
  prompt: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const reducer = createPasswordReducer();
    const container = new Container();

    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    container.addChild(new Text(theme.fg("accent", theme.bold(`🔑 ${prompt}`)), 1, 0));

    const displayLine = new Text(theme.fg("muted", "> "), 1, 0);
    container.addChild(displayLine);

    container.addChild(
      new Text(theme.fg("dim", "支持 ${VAR} 占位符  ·  Esc 取消  ·  Enter 确认"), 1, 0),
    );

    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const result = reducer.handleKey(data);

        if (result.action === "submit") {
          done(result.password);
          return;
        }
        if (result.action === "cancel") {
          done(void 0);
          return;
        }
        if (result.action === "update") {
          displayLine.setText(theme.fg("muted", `> ${"*".repeat(result.password.length)}`));
          tui.requestRender();
        }
        // "none" → 忽略
      },
    };
  });
}

// ── 校验输入辅助 ──────────────────────────────────────

async function requiredInput(
  ctx: ExtensionCommandContext,
  prompt: string,
  placeholder?: string,
  label?: string,
): Promise<string | undefined> {
  const value = await ctx.ui.input(prompt, placeholder);
  if (value === undefined) return undefined;
  if (!value.trim()) {
    ctx.ui.notify(`${label ?? prompt} 不能为空`, "error");
    return await requiredInput(ctx, prompt, placeholder, label);
  }
  return value.trim();
}

async function portInput(
  ctx: ExtensionCommandContext,
  prompt: string,
  placeholder?: string,
): Promise<number | undefined> {
  const value = await ctx.ui.input(prompt, placeholder);
  if (value === undefined) return undefined;
  const port = parseInt(value, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    ctx.ui.notify("端口必须是 1-65535 的数字", "error");
    return await portInput(ctx, prompt, placeholder);
  }
  return port;
}

// ── 入口 ──────────────────────────────────────────────────

export async function handleAdd(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/db add 需要交互模式", "error");
    return;
  }

  // --- 环境 ---
  const envs = ws.getEnvironments();
  let env: string;
  if (envs.length === 0) {
    env = "default";
  } else {
    const choice = await ctx.ui.select("选择环境（新建连接加入此环境）", [...envs, "新建环境…"]);
    if (!choice) return;
    if (choice === "新建环境…") {
      const name = await requiredInput(ctx, "环境名称（如 prod / staging）", undefined, "环境名称");
      if (!name) return;
      env = name;
    } else {
      env = choice;
    }
  }

  // --- 连接名 ---
  const connName = await requiredInput(
    ctx,
    `连接名称（在 ${env} 环境下的唯一标识）`,
    undefined,
    "连接名称",
  );
  if (!connName) return;

  // --- 主机 ---
  const host = await requiredInput(ctx, "主机地址", "localhost", "主机地址");
  if (!host) return;

  // --- 端口（带范围校验）---
  const port = await portInput(ctx, "端口", "3306");
  if (port === undefined) return;

  // --- 用户名 ---
  const username = await requiredInput(ctx, "用户名", "root", "用户名");
  if (!username) return;

  // --- 密码（掩码）---
  const pwd = await maskedPassword(ctx, "密码（或 ${ENV_VAR} 占位符）");
  if (pwd === undefined) return;

  // --- 默认数据库（可选）---
  const database = await ctx.ui.input("默认数据库（可选，留空则每次选择）");
  if (database === undefined) return;
  const defaultDb = database?.trim() || undefined;

  // --- 确认 ---
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

  // --- 写入 ---
  try {
    ws.createConnection(connName, {
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

  // --- 可选的连接测试 ---
  ctx.ui.notify(`✅ 已添加连接 "${connName}" 到 ${env} 环境。`, "info");

  const test = await ctx.ui.confirm("测试连接", "是否立即测试连接？");
  if (test) {
    const dbs = await withLoader(
      ctx,
      `测试连接 ${connName}…`,
      (_signal) => ws.getDatabases(connName),
      (err) => ctx.ui.notify(`连接失败：${err.message}`, "error"),
    );
    if (dbs) {
      ctx.ui.notify(
        `✅ 连接成功，${connName} 上有 ${dbs.length} 个数据库。运行 /db switch 选择。`,
        "info",
      );
    }
  }
}
