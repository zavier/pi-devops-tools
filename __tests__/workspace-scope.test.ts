import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state/state-store";
import { DatabaseWorkspaceService } from "../state/workspace";

const CONNECTIONS_YAML = `connections:
  qa:
    environment: test
    type: mysql
    host: h1
    defaultDatabase: qa_db
`;

describe("DatabaseWorkspaceService 项目级隔离（scopeKey）", () => {
  const dirs: string[] = [];
  const services: DatabaseWorkspaceService[] = [];

  function makeDir(withConnections = true): string {
    const dir = mkdtempSync(join(tmpdir(), "ws-scope-test-"));
    dirs.push(dir);
    if (withConnections) writeFileSync(join(dir, "connections.yaml"), CONNECTIONS_YAML);
    return dir;
  }

  function makeService(dir: string, scopeKey?: string): DatabaseWorkspaceService {
    const ws = new DatabaseWorkspaceService(
      new StateStore(dir),
      undefined,
      scopeKey ? { scopeKey } : undefined,
    );
    services.push(ws);
    return ws;
  }

  afterEach(() => {
    for (const ws of services.splice(0)) ws.destroy();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("两个项目目录的选择互不干扰", () => {
    const dir = makeDir();
    const wsA = makeService(dir, "/proj-a");
    wsA.switchTo("test", "qa", "a_db");

    const wsB = makeService(dir, "/proj-b");
    expect(wsB.current).toBeNull();

    // 重新进入项目 A 恢复上次选择
    expect(makeService(dir, "/proj-a").current?.database).toBe("a_db");
  });

  it("同一项目的新实例继承选择（持久化往返）", () => {
    const dir = makeDir();
    makeService(dir, "/proj-a").switchTo("test", "qa", "a_db");
    expect(makeService(dir, "/proj-a").current).toEqual({
      environment: "test",
      connectionId: "qa",
      database: "a_db",
    });
  });

  it("无 scopeKey 时只改内存不落盘（纯会话语义）", () => {
    const dir = makeDir();
    const ws = makeService(dir);
    ws.switchTo("test", "qa", "mem_db");

    expect(ws.current?.database).toBe("mem_db");
    expect(existsSync(join(dir, "workspaces.json"))).toBe(false);
    expect(makeService(dir).current).toBeNull();
  });

  it("旧全局 workspace.json 被归档且不播种到任何项目", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "workspace.json"),
      JSON.stringify({ environment: "prod", connectionId: "qa", database: "prod_db" }),
    );

    const ws = makeService(dir, "/proj-a");

    expect(ws.current).toBeNull(); // 不继承全局值
    expect(existsSync(join(dir, "workspace.json"))).toBe(false);
    expect(existsSync(join(dir, "workspace.json.legacy"))).toBe(true);
  });
});
