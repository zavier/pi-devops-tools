import { describe, it, expect, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { SAMPLE_ROW_LIMIT, handleSample, sampleDataSql } from "../commands/sample";

// withLoader 内部的 BorderedLoader 会读全局 theme（keyHint 也要），先初始化。
beforeAll(() => initTheme("dark"));

/** 只实现 fg/bold 的假 theme —— 足以构造 pickTableFuzzy 的组件。 */
const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const fakeTui = { requestRender: () => {} };

/**
 * 桩 ctx.ui.custom：
 * - 首次调用视为表选择器，若给了 pick 则模拟「用户立即选中」；
 * - 其余调用（withLoader）让 factory 自行 done，并在结束后 dispose，
 *   避免 Loader 的 spinner 定时器泄漏。
 */
function stubUi(opts: { pick?: string } = {}) {
  const notify = vi.fn<(message: string, type?: string) => void>();
  let calls = 0;
  const custom = vi.fn<(factory: (...args: unknown[]) => unknown) => Promise<unknown>>(
    async (factory) =>
      await new Promise<unknown>((resolve) => {
        const picker = calls++ === 0 && opts.pick !== undefined;
        let resolved = false;
        const done = (value: unknown) => {
          resolved = true;
          resolve(value);
        };
        const comp = factory(fakeTui, fakeTheme, {}, done) as { dispose?: () => void };
        if (picker && !resolved) done(opts.pick);
        void Promise.resolve().then(() => comp.dispose?.());
      }),
  );
  return {
    ctx: { hasUI: true, ui: { notify, custom } } as unknown as ExtensionCommandContext,
    notify,
    custom,
  };
}

function stubWs(opts: { ready?: boolean; rows?: Record<string, unknown>[] } = {}) {
  const { ready = true, rows = [{ id: 1 }, { id: 2 }] } = opts;
  const executeQuery = vi.fn<(sql: string) => Promise<Record<string, unknown>>>(
    async (sql: string) => ({
      columns: ["id"],
      rows,
      elapsed: "1ms",
      sql,
    }),
  );
  const ws = {
    isReady: ready,
    current: { environment: "test", connectionId: "local", database: "qa_db" },
    getTables: async () => ["t_orders", "t_users"],
    executeQuery,
    saveHistory: vi.fn<(...args: unknown[]) => void>(),
  } as unknown as DatabaseWorkspaceService;
  return { ws, executeQuery };
}

function stubPi() {
  const appendEntry = vi.fn<(...args: unknown[]) => void>();
  const sendMessage = vi.fn<(...args: unknown[]) => void>();
  return { pi: { appendEntry, sendMessage }, appendEntry, sendMessage };
}

describe("sampleDataSql", () => {
  it("生成固定 10 行的反引号表名查询", () => {
    expect(SAMPLE_ROW_LIMIT).toBe(10);
    expect(sampleDataSql("t_orders")).toBe("SELECT * FROM `t_orders` LIMIT 10");
  });
});

describe("handleSample（/db sample）", () => {
  it("未选择数据库时告警，不执行查询", async () => {
    const { ctx, notify } = stubUi();
    const { ws, executeQuery } = stubWs({ ready: false });

    await handleSample(ctx, ws, stubPi().pi as never);

    expect(notify).toHaveBeenCalledWith("未选择数据库，请先执行 /db switch", "warning");
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("指定表名时直接查询样例数据并走查询结果展示通道", async () => {
    const { ctx } = stubUi();
    const { ws, executeQuery } = stubWs();
    const { pi, appendEntry, sendMessage } = stubPi();

    await handleSample(ctx, ws, pi as never, "t_orders");

    expect(executeQuery).toHaveBeenCalledWith("SELECT * FROM `t_orders` LIMIT 10");
    // TUI 富渲染条目
    expect(appendEntry).toHaveBeenCalledWith(
      "db-query-result",
      expect.objectContaining({ database: "qa_db", rowCount: 2 }),
    );
    // LLM 上下文文档（display: false）
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "db-query-result", display: false }),
      expect.anything(),
    );
  });

  it("不带参数时先弹表选择器，选中后再查询", async () => {
    const { ctx } = stubUi({ pick: "t_users" });
    const { ws, executeQuery } = stubWs();
    const pi = stubPi();

    await handleSample(ctx, ws, pi.pi as never);

    expect(executeQuery).toHaveBeenCalledWith("SELECT * FROM `t_users` LIMIT 10");
  });

  it("空表时提前返回，不执行查询", async () => {
    const { ctx } = stubUi();
    const { ws, executeQuery } = stubWs();
    const emptyWs = {
      ...(ws as unknown as Record<string, unknown>),
      getTables: async () => [],
    } as unknown as DatabaseWorkspaceService;

    await handleSample(ctx, emptyWs, stubPi().pi as never);

    expect(executeQuery).not.toHaveBeenCalled();
  });
});
