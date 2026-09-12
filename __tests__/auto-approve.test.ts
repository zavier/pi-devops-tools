import { describe, it, expect, vi, type Mock } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { autoApprovePanelLine, handleAutoApprove } from "../commands/auto-approve";
import { STATUS_KEY } from "../commands/switch";
import { createSessionAutoApprove } from "../state/mutation-approval";

/** 最小 ctx stub：覆盖 handleAutoApprove 用到的 ui.notify / ui.confirm / ui.setStatus / ui.setWidget。 */
function stubCtx(confirmResult: boolean | undefined = false) {
  const notify = vi.fn<(message: string, type?: "info" | "warning" | "error") => void>();
  const setStatus = vi.fn<(key: string, text: string | undefined) => void>();
  const setWidget = vi.fn<(key: string, lines: string[] | undefined) => void>();
  const confirm = vi.fn<() => Promise<boolean | undefined>>(async () => confirmResult);
  const ctx = {
    ui: { notify, confirm, setStatus, setWidget },
    hasUI: true,
  } as unknown as ExtensionCommandContext;
  return { ctx, notify, setStatus, setWidget, confirm };
}

/** 最小 ws stub：applyWorkspaceStatus 读取 isReady / statusLabel / current。 */
function stubWs(opts: { ready?: boolean } = {}) {
  const { ready = true } = opts;
  return {
    isReady: ready,
    statusLabel: "🗄 test/qa_db",
    current: { environment: "test", connectionId: "local", database: "qa_db" },
  } as unknown as DatabaseWorkspaceService;
}

function notifyMessages(
  notify: Mock<(message: string, type?: "info" | "warning" | "error") => void>,
): string {
  return notify.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("handleAutoApprove（/db auto-approve）", () => {
  it("裸命令显示关闭状态，不改状态、不写状态栏", async () => {
    const approval = createSessionAutoApprove();
    const { ctx, notify, setStatus, confirm } = stubCtx();

    await handleAutoApprove(ctx, stubWs(), approval);

    expect(approval.enabled).toBe(false);
    expect(notifyMessages(notify)).toContain("关闭（默认）");
    expect(setStatus).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("on 经确认后开启，状态栏与连接信息合并展示免确认后缀", async () => {
    const approval = createSessionAutoApprove();
    const { ctx, notify, setStatus, setWidget, confirm } = stubCtx(true);

    await handleAutoApprove(ctx, stubWs(), approval, "on");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(approval.enabled).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, "🗄 test/qa_db • 免确认");
    expect(setWidget).toHaveBeenCalledWith(STATUS_KEY, ["🗄 test/qa_db  @local • 免确认"]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已开启变更免确认"), "warning");
  });

  it("on 被取消时保持关闭，不写状态栏", async () => {
    const approval = createSessionAutoApprove();
    const { ctx, setStatus } = stubCtx(false);

    await handleAutoApprove(ctx, stubWs(), approval, "on");

    expect(approval.enabled).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("确认对话框 Esc（undefined）同样视为取消", async () => {
    const approval = createSessionAutoApprove();
    const { ctx } = stubCtx(undefined);

    await handleAutoApprove(ctx, stubWs(), approval, "on");

    expect(approval.enabled).toBe(false);
  });

  it("已开启时再次 on 不弹确认", async () => {
    const approval = createSessionAutoApprove();
    approval.setEnabled(true);
    const { ctx, confirm } = stubCtx(true);

    await handleAutoApprove(ctx, stubWs(), approval, "on");

    expect(confirm).not.toHaveBeenCalled();
    expect(approval.enabled).toBe(true);
  });

  it("off 关闭并恢复无后缀的连接信息，无需确认", async () => {
    const approval = createSessionAutoApprove();
    approval.setEnabled(true);
    const { ctx, setStatus, setWidget, confirm } = stubCtx();

    await handleAutoApprove(ctx, stubWs(), approval, "off");

    expect(confirm).not.toHaveBeenCalled();
    expect(approval.enabled).toBe(false);
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, "🗄 test/qa_db");
    expect(setWidget).toHaveBeenCalledWith(STATUS_KEY, ["🗄 test/qa_db  @local"]);
  });

  it("未选择数据库时不写状态栏（没有连接信息可组合）", async () => {
    const approval = createSessionAutoApprove();
    const { ctx, setStatus } = stubCtx(true);

    await handleAutoApprove(ctx, stubWs({ ready: false }), approval, "on");

    expect(approval.enabled).toBe(true);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("非法参数告警且不改状态", async () => {
    const approval = createSessionAutoApprove();
    const { ctx, notify } = stubCtx();

    await handleAutoApprove(ctx, stubWs(), approval, "oops");

    expect(approval.enabled).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("未知参数"), "warning");
  });
});

describe("autoApprovePanelLine", () => {
  it("跟随状态", () => {
    const approval = createSessionAutoApprove();
    expect(autoApprovePanelLine(approval)).toContain("关闭");
    approval.setEnabled(true);
    expect(autoApprovePanelLine(approval)).toContain("已开启");
  });
});
