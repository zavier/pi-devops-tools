/**
 * /db auto-approve —— 会话级"变更免确认"开关的命令面。
 *
 * 开启需要二次确认（开启即提权），关闭不需要。/db 面板状态行始终展示当前状态；
 * 状态栏与 widget 上的连接信息合并展示（仅开启时追加 `• 免确认` 后缀，
 * 默认关闭零噪音）。读写的是工厂注入的会话内存状态（不落盘），
 * 生命周期见 docs/session-auto-approve.md。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { SessionAutoApprove } from "../state/mutation-approval";
import { applyWorkspaceStatus } from "./switch";

/** 面板状态行——默认关闭也展示，让当前策略始终可见。 */
export function autoApprovePanelLine(approval: SessionAutoApprove): string {
  return approval.enabled ? "🔓 变更免确认：已开启（本会话）" : "🔒 变更免确认：关闭";
}

/**
 * 处理 `/db auto-approve [on|off]`。
 * 裸命令显示当前状态；on 需二次确认，off 直接关闭；非法参数只告警。
 */
export async function handleAutoApprove(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  approval: SessionAutoApprove,
  arg?: string,
): Promise<void> {
  const action = (arg ?? "").trim();

  if (!action) {
    ctx.ui.notify(
      approval.enabled
        ? "变更免确认：已开启（本会话）。AI 写操作不再弹确认；/db auto-approve off 关闭。"
        : "变更免确认：关闭（默认）。AI 写操作每次都会弹确认；/db auto-approve on 开启。",
      approval.enabled ? "warning" : "info",
    );
    return;
  }

  if (action === "on") {
    if (approval.enabled) {
      ctx.ui.notify("变更免确认已处于开启状态（本会话）。", "info");
      return;
    }
    const ok = await ctx.ui.confirm(
      "开启变更免确认？",
      [
        "本会话内 AI 执行 INSERT / UPDATE / DELETE / REPLACE 将不再弹出确认对话框，直接执行。",
        "",
        "· 仅对当前会话生效；/reload、/new、/resume 后自动恢复关闭",
        "· 该开关不能由模型自己打开，只响应用户命令",
        "",
        "确认开启？",
      ].join("\n"),
    );
    if (!ok) {
      ctx.ui.notify("已取消，变更仍需人工确认。", "info");
      return;
    }
    approval.setEnabled(true);
    applyWorkspaceStatus(ctx, ws, approval);
    ctx.ui.notify(
      "已开启变更免确认（本会话）。写操作将直接执行并在结果中标注「免人工确认」。",
      "warning",
    );
    return;
  }

  if (action === "off") {
    if (!approval.enabled) {
      ctx.ui.notify("变更免确认当前已是关闭状态。", "info");
      return;
    }
    approval.setEnabled(false);
    applyWorkspaceStatus(ctx, ws, approval);
    ctx.ui.notify("已关闭变更免确认，写操作恢复人工确认。", "info");
    return;
  }

  ctx.ui.notify(`未知参数：${action}。用法：/db auto-approve [on|off]`, "warning");
}
