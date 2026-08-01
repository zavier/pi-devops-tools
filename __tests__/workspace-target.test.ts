import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state/state-store";
import { DatabaseWorkspaceService } from "../state/workspace";

const CONNECTIONS_YAML = `connections:
  main:
    environment: prod
    type: mysql
    host: h1
    defaultDatabase: appdb
  other:
    environment: staging
    type: mysql
    host: h2
`;

describe("DatabaseWorkspaceService favorites", () => {
  const dirs: string[] = [];
  const services: DatabaseWorkspaceService[] = [];

  function makeWorkspace(): DatabaseWorkspaceService {
    const dir = mkdtempSync(join(tmpdir(), "ws-fav-test-"));
    dirs.push(dir);
    writeFileSync(join(dir, "connections.yaml"), CONNECTIONS_YAML);
    const ws = new DatabaseWorkspaceService(new StateStore(dir));
    services.push(ws);
    return ws;
  }

  afterEach(() => {
    for (const ws of services.splice(0)) ws.destroy();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("saves a favorite bound to the current database", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");

    const fav = ws.saveFavorite("查订单", "SELECT * FROM t_orders");
    expect(fav.name).toBe("查订单");
    expect(fav.database).toBe("appdb");
    expect(fav.id).toBeGreaterThan(0);

    const all = ws.listFavorites();
    expect(all).toHaveLength(1);
    expect(all[0].sql).toBe("SELECT * FROM t_orders");
  });

  it("saves a global favorite when no database is selected", () => {
    const ws = makeWorkspace();
    const fav = ws.saveFavorite("全局模板", "SELECT 1", "说明");
    expect(fav.database).toBe("");
    expect(fav.description).toBe("说明");
  });

  it("filters favorites by current database", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    ws.saveFavorite("a1", "SELECT 1"); // appdb
    ws.upsertRelation("x", "c", "y", "d", { database: "logs" }); // 无关

    // 切到另一库后, 原库收藏不可见
    ws.switchTo("prod", "main", "logs");
    ws.saveFavorite("a2", "SELECT 2");
    const inLogs = ws.listFavorites();
    expect(inLogs.map((f) => f.name)).toEqual(["a2"]);

    // 未切换时按当前库过滤
    ws.switchTo("prod", "main", "appdb");
    expect(ws.listFavorites().map((f) => f.name)).toEqual(["a1"]);
  });

  it("filters favorites by keyword across the current database", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    ws.saveFavorite("订单查询", "SELECT * FROM t_orders");
    ws.saveFavorite("用户查询", "SELECT * FROM t_users");

    expect(ws.listFavorites("订单").map((f) => f.name)).toEqual(["订单查询"]);
    // 收藏按创建时间倒序(最新在前)
    expect(ws.listFavorites("SELECT").map((f) => f.name)).toEqual(["用户查询", "订单查询"]);
    expect(ws.listFavorites("不存在")).toHaveLength(0);
  });

  it("deletes a favorite by id", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    const fav = ws.saveFavorite("待删除", "SELECT 1");

    expect(ws.deleteFavorite(fav.id)).toBe(true);
    expect(ws.listFavorites()).toHaveLength(0);
    expect(ws.deleteFavorite(fav.id)).toBe(false); // 二次删除空操作
  });
});

describe("DatabaseWorkspaceService target resolution", () => {
  const dirs: string[] = [];
  const services: DatabaseWorkspaceService[] = [];

  function makeWorkspace(): DatabaseWorkspaceService {
    const dir = mkdtempSync(join(tmpdir(), "ws-target-test-"));
    dirs.push(dir);
    writeFileSync(join(dir, "connections.yaml"), CONNECTIONS_YAML);
    const ws = new DatabaseWorkspaceService(new StateStore(dir));
    services.push(ws);
    return ws;
  }

  afterEach(() => {
    for (const ws of services.splice(0)) ws.destroy();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to the workspace selection", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    expect(ws.resolveTarget()).toEqual({ connectionId: "main", database: "appdb" });
  });

  it("database alone targets another database on the current connection", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    expect(ws.resolveTarget({ database: "logs" })).toEqual({
      connectionId: "main",
      database: "logs",
    });
  });

  it("connection alone falls back to its defaultDatabase", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    expect(ws.resolveTarget({ connectionId: "main" })).toEqual({
      connectionId: "main",
      database: "appdb",
    });
  });

  it("connection + database targets a different connection explicitly", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    expect(ws.resolveTarget({ connectionId: "other", database: "stagingdb" })).toEqual({
      connectionId: "other",
      database: "stagingdb",
    });
  });

  it("throws when the connection has no defaultDatabase and none is passed", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    expect(() => ws.resolveTarget({ connectionId: "other" })).toThrow(/no defaultDatabase/);
  });

  it("throws for an unknown connection, listing available IDs", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    expect(() => ws.resolveTarget({ connectionId: "nope" })).toThrow(/Available: main, other/);
  });

  it("throws without a workspace selection and no explicit target", () => {
    const ws = makeWorkspace();
    expect(() => ws.resolveTarget()).toThrow(/No database selected/);
  });

  it("resolves an explicit target without a workspace selection", () => {
    const ws = makeWorkspace();
    expect(ws.resolveTarget({ connectionId: "other", database: "stagingdb" })).toEqual({
      connectionId: "other",
      database: "stagingdb",
    });
    // 未 switchTo 时 defaultDatabase 也生效
    expect(ws.resolveTarget({ connectionId: "main" })).toEqual({
      connectionId: "main",
      database: "appdb",
    });
  });

  it("listConnections exposes id, environment, and defaultDatabase", () => {
    const ws = makeWorkspace();
    expect(ws.listConnections()).toEqual([
      { id: "main", environment: "prod", defaultDatabase: "appdb" },
      { id: "other", environment: "staging", defaultDatabase: undefined },
    ]);
  });

  it("saveHistory records the explicit target instead of the workspace selection", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    const entry = ws.saveHistory("SELECT 1", 1, "0.001s", {
      connectionId: "other",
      database: "stagingdb",
    });
    expect(entry.connectionId).toBe("other");
    expect(entry.database).toBe("stagingdb");
    expect(entry.environment).toBe("staging");
  });

  it("saveHistory falls back to the workspace selection", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    const entry = ws.saveHistory("SELECT 1", 1, "0.001s");
    expect(entry.connectionId).toBe("main");
    expect(entry.database).toBe("appdb");
    expect(entry.environment).toBe("prod");
  });

  it("upsertRelation / listRelations honor the database override", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");

    ws.upsertRelation("orders", "user_id", "users", "id", { database: "logs" });

    // 覆盖目标为另一个 schema……
    const inLogs = ws.listRelations(undefined, "logs");
    expect(inLogs).toHaveLength(1);
    expect(inLogs[0].schema).toBe("logs");
    expect(inLogs[0].table_name).toBe("orders");

    // ……而工作空间默认仍停留在当前数据库。
    expect(ws.listRelations()).toHaveLength(0);
  });

  it("listRelations without a selection and no database returns all relations", () => {
    const ws = makeWorkspace();
    ws.upsertRelation("a", "x", "b", "y", { database: "somedb" });
    expect(ws.listRelations()).toHaveLength(1);
  });

  it("upsertRelation throws without a selection and no database override", () => {
    const ws = makeWorkspace();
    expect(() => ws.upsertRelation("a", "x", "b", "y")).toThrow(/No database selected/);
  });

  it("upsertRelation is idempotent — repeated calls update not duplicate", () => {
    const ws = makeWorkspace();
    ws.upsertRelation("a", "x", "b", "y", { database: "somedb", relationType: "MANY_TO_ONE" });
    ws.upsertRelation("a", "x", "b", "y", { database: "somedb", relationType: "ONE_TO_ONE" });
    const all = ws.listRelations();
    expect(all).toHaveLength(1);
    expect(all[0].relation_type).toBe("ONE_TO_ONE");
  });

  it("removeRelationByColumns deletes by column match", () => {
    const ws = makeWorkspace();
    ws.upsertRelation("a", "x", "b", "y", { database: "somedb" });
    expect(ws.listRelations()).toHaveLength(1);

    const deleted = ws.removeRelationByColumns("somedb", "a", "x", "b", "y");
    expect(deleted).toBe(true);
    expect(ws.listRelations()).toHaveLength(0);

    // 第二次删除是空操作
    const deletedAgain = ws.removeRelationByColumns("somedb", "a", "x", "b", "y");
    expect(deletedAgain).toBe(false);
  });
});
