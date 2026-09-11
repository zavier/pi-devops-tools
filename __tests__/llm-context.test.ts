import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StateStore } from "../state/state-store";
import { DatabaseWorkspaceService } from "../state/workspace";
import { buildDbStatusMessage, createDbStatusNotifier } from "../commands/llm-context";

const CONNECTIONS_YAML = `connections:
  qa:
    environment: test
    type: mysql
    host: h1
    defaultDatabase: qa_db
`;

interface SentMessage {
  customType?: string;
  content?: string;
  display?: boolean;
}

interface SentOptions {
  deliverAs?: string;
  triggerTurn?: boolean;
}

/** 捕获数组替身：本模块只依赖 pi.sendMessage。 */
function fakePi() {
  const sent: Array<{ message: SentMessage; options: SentOptions | undefined }> = [];
  const pi = {
    sendMessage: (message: SentMessage, options?: SentOptions) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  return { sent, pi };
}

describe("DB 状态注入（未连接时零注入）", () => {
  const dirs: string[] = [];
  const services: DatabaseWorkspaceService[] = [];

  function makeService(
    opts: { configured?: boolean; scopeKey?: string } = {},
  ): DatabaseWorkspaceService {
    const dir = mkdtempSync(join(tmpdir(), "llm-context-test-"));
    dirs.push(dir);
    if (opts.configured !== false) writeFileSync(join(dir, "connections.yaml"), CONNECTIONS_YAML);
    const ws = new DatabaseWorkspaceService(
      new StateStore(dir),
      undefined,
      opts.scopeKey ? { scopeKey: opts.scopeKey } : undefined,
    );
    services.push(ws);
    return ws;
  }

  afterEach(() => {
    for (const ws of services.splice(0)) ws.destroy();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("未配置任何连接 → 不构建消息、不注入", () => {
    const ws = makeService({ configured: false });
    const { sent, pi } = fakePi();

    expect(buildDbStatusMessage(ws)).toBeNull();
    createDbStatusNotifier(pi, () => ws).notifyIfChanged();
    expect(sent).toEqual([]);
  });

  it("已配置但未选择数据库 → 不构建消息、不注入（回归点）", () => {
    const ws = makeService();
    const { sent, pi } = fakePi();

    expect(ws.isConfigured).toBe(true);
    expect(ws.isReady).toBe(false);
    expect(buildDbStatusMessage(ws)).toBeNull();
    createDbStatusNotifier(pi, () => ws).notifyIfChanged();
    expect(sent).toEqual([]);
  });

  it("已选择 → 注入一条静默消息（display: false）", () => {
    const ws = makeService();
    ws.switchTo("test", "qa", "qa_db");
    const { sent, pi } = fakePi();

    createDbStatusNotifier(pi, () => ws).notifyIfChanged();

    expect(sent.length).toBe(1);
    expect(sent[0].message.customType).toBe("db-active-db");
    expect(sent[0].message.display).toBe(false);
    expect(sent[0].message.content).toContain("Current database: qa_db");
    expect(sent[0].message.content).toContain("connection: qa");
    expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: false });
  });

  it("状态未变化时反复调用只注入一次（面板反复打开不再累积）", () => {
    const ws = makeService();
    ws.switchTo("test", "qa", "qa_db");
    const { sent, pi } = fakePi();
    const notifier = createDbStatusNotifier(pi, () => ws);

    notifier.notifyIfChanged();
    notifier.notifyIfChanged();
    notifier.notifyIfChanged();

    expect(sent.length).toBe(1);
  });

  it("切换数据库后重新注入一次", () => {
    const ws = makeService();
    ws.switchTo("test", "qa", "qa_db");
    const { sent, pi } = fakePi();
    const notifier = createDbStatusNotifier(pi, () => ws);

    notifier.notifyIfChanged();
    ws.switchTo("test", "qa", "other_db");
    notifier.notifyIfChanged();

    expect(sent.length).toBe(2);
    expect(sent[1].message.content).toContain("Current database: other_db");
  });

  it("回到未选择状态会复位去重（重新选中同一库可再次告知）", () => {
    let ready = true;
    const stub = {
      get isReady() {
        return ready;
      },
      current: { environment: "test", connectionId: "qa", database: "qa_db" },
      configPath: "/tmp/connections.yaml",
    } as unknown as DatabaseWorkspaceService;

    const { sent, pi } = fakePi();
    const notifier = createDbStatusNotifier(pi, () => stub);

    notifier.notifyIfChanged();
    expect(sent.length).toBe(1);

    // 选择被清空（当前无 disconnect 入口，防御性覆盖）
    ready = false;
    notifier.notifyIfChanged();
    expect(sent.length).toBe(1);

    ready = true;
    notifier.notifyIfChanged();
    expect(sent.length).toBe(2);
  });
});
