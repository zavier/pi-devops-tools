import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveLegacyWorkspace,
  loadWorkspaceRecord,
  normalizeScopeKey,
  saveWorkspaceRecord,
  type WorkspaceRecord,
} from "../state/workspace-store";

function makeRecord(database: string): WorkspaceRecord {
  return {
    environment: "test",
    connectionId: "qa",
    database,
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("workspace-store（按项目键控的选择存储）", () => {
  const dirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ws-store-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("不同 scopeKey 的选择互不干扰", () => {
    const file = join(makeDir(), "workspaces.json");
    saveWorkspaceRecord(file, "/proj-a", makeRecord("a_db"));

    expect(loadWorkspaceRecord(file, "/proj-a")?.database).toBe("a_db");
    expect(loadWorkspaceRecord(file, "/proj-b")).toBeNull();
  });

  it("同 key 覆盖写，且文件始终是合法 JSON（保留其它项目）", () => {
    const file = join(makeDir(), "workspaces.json");
    saveWorkspaceRecord(file, "/proj-a", makeRecord("a_db"));
    saveWorkspaceRecord(file, "/proj-b", makeRecord("b_db"));
    saveWorkspaceRecord(file, "/proj-a", makeRecord("a_db_2"));

    expect(loadWorkspaceRecord(file, "/proj-a")?.database).toBe("a_db_2");
    expect(loadWorkspaceRecord(file, "/proj-b")?.database).toBe("b_db");

    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.workspaces).sort()).toEqual(["/proj-a", "/proj-b"]);
    // 原子写不应留下临时文件
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("文件缺失 / JSON 损坏 / 版本不认识 → 视为未选择（不抛错）", () => {
    const dir = makeDir();
    const missing = join(dir, "nope.json");
    expect(loadWorkspaceRecord(missing, "/proj-a")).toBeNull();

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(loadWorkspaceRecord(broken, "/proj-a")).toBeNull();

    const future = join(dir, "future.json");
    writeFileSync(
      future,
      JSON.stringify({ version: 99, workspaces: { "/proj-a": makeRecord("x") } }),
    );
    expect(loadWorkspaceRecord(future, "/proj-a")).toBeNull();
  });

  it("单条记录损坏时只丢弃该条，其余仍可读", () => {
    const file = join(makeDir(), "workspaces.json");
    saveWorkspaceRecord(file, "/proj-a", makeRecord("a_db"));
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    parsed.workspaces["/proj-bad"] = { environment: 1, connectionId: null };
    parsed.workspaces["/proj-no-time"] = {
      environment: "test",
      connectionId: "qa",
      database: "handedited",
    };
    writeFileSync(file, JSON.stringify(parsed));

    expect(loadWorkspaceRecord(file, "/proj-a")?.database).toBe("a_db");
    expect(loadWorkspaceRecord(file, "/proj-bad")).toBeNull();
    // 手工编辑漏掉 updatedAt 不该让整条选择失效
    expect(loadWorkspaceRecord(file, "/proj-no-time")?.updatedAt).toBe("");
  });

  it("normalizeScopeKey 归并符号链接别名，且对不存在的目录不抛错", () => {
    const root = makeDir();
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);

    expect(normalizeScopeKey(link)).toBe(normalizeScopeKey(real));
    expect(normalizeScopeKey(join(root, "gone"))).toBe(join(root, "gone"));
  });

  it("archiveLegacyWorkspace 归档旧全局文件且只做一次", () => {
    const dir = makeDir();
    const legacy = join(dir, "workspace.json");
    expect(archiveLegacyWorkspace(legacy)).toBe(false);

    writeFileSync(
      legacy,
      JSON.stringify({ environment: "test", connectionId: "qa", database: "x" }),
    );
    expect(archiveLegacyWorkspace(legacy)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.legacy`)).toBe(true);
    // 第二次调用无事可做
    expect(archiveLegacyWorkspace(legacy)).toBe(false);
  });
});
