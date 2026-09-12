import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { createSessionAutoApprove } from "../state/mutation-approval";
import { registerDbTools } from "../tools/db-tools";

/** 收集 registerTool 注册的定义；loader 用到的 get/setActiveTools 给最小实现。 */
function stubPi() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (def: any) => tools.set(def.name, def),
    getActiveTools: () => [] as string[],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

/** ws stub：调用注入的 confirm，并按结果走 rejected / executed 两条分支。 */
function stubWs() {
  const ws = {
    executeMutationWithApproval: async (
      sql: string,
      _opts: unknown,
      confirm: (req: any) => Promise<boolean>,
    ) => {
      const ok = await confirm({
        sql,
        operation: "UPDATE",
        connectionId: "local",
        database: "test_db",
      });
      return ok
        ? {
            status: "executed" as const,
            affectedRows: 1,
            elapsed: "0.001s",
            sql,
            connectionId: "local",
            database: "test_db",
          }
        : { status: "rejected" as const, sql };
    },
  } as unknown as DatabaseWorkspaceService;
  return ws;
}

const SQL = "UPDATE t SET a=1 WHERE id=1";

describe("db_mutate 会话级免确认开关", () => {
  it("关闭时走人工确认；用户拒绝返回 rejected", async () => {
    const { pi, tools } = stubPi();
    const approval = createSessionAutoApprove();
    registerDbTools(pi, () => stubWs(), approval);

    const uiConfirm = vi.fn<(title: string, message: string) => Promise<boolean>>(
      async () => false,
    );
    const ctx = { mode: "print", ui: { confirm: uiConfirm, custom: vi.fn<() => void>() } };

    const result: any = await tools
      .get("db_mutate")!
      .execute("t1", { sql: SQL }, undefined, undefined, ctx);

    expect(uiConfirm).toHaveBeenCalledTimes(1);
    expect(result.details.rejected).toBe(true);
    expect(result.content[0].text).toContain("用户已拒绝变更");
  });

  it("开启时跳过确认，并在结果中标注免人工确认", async () => {
    const { pi, tools } = stubPi();
    const approval = createSessionAutoApprove();
    approval.setEnabled(true);
    registerDbTools(pi, () => stubWs(), approval);

    const uiConfirm = vi.fn<(title: string, message: string) => Promise<boolean>>(
      async () => false,
    );
    const uiCustom = vi.fn<() => void>();
    const ctx = { mode: "tui", ui: { confirm: uiConfirm, custom: uiCustom } };

    const result: any = await tools
      .get("db_mutate")!
      .execute("t2", { sql: SQL }, undefined, undefined, ctx);

    expect(uiConfirm).not.toHaveBeenCalled();
    expect(uiCustom).not.toHaveBeenCalled();
    expect(result.details.autoApproved).toBe(true);
    expect(result.details.approvalSource).toBe("session");
    expect(result.content[0].text).toContain("免人工确认");
  });
});
