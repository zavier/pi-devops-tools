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
    // defaultDatabase also works without switchTo
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
    expect(ws.getHistoryById(entry.id)?.database).toBe("stagingdb");
  });

  it("saveHistory falls back to the workspace selection", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");
    const entry = ws.saveHistory("SELECT 1", 1, "0.001s");
    expect(entry.connectionId).toBe("main");
    expect(entry.database).toBe("appdb");
    expect(entry.environment).toBe("prod");
  });

  it("registerRelation / listRelations honor the database override", () => {
    const ws = makeWorkspace();
    ws.switchTo("prod", "main", "appdb");

    ws.registerRelation("orders", "user_id", "users", "id", { database: "logs" });

    // Override targets the other schema...
    const inLogs = ws.listRelations(undefined, "logs");
    expect(inLogs).toHaveLength(1);
    expect(inLogs[0].schema).toBe("logs");
    expect(inLogs[0].table_name).toBe("orders");

    // ...while the workspace default stays on the current database.
    expect(ws.listRelations()).toHaveLength(0);
  });

  it("listRelations without a selection and no database returns all relations", () => {
    const ws = makeWorkspace();
    ws.registerRelation("a", "x", "b", "y", { database: "somedb" });
    expect(ws.listRelations()).toHaveLength(1);
  });

  it("registerRelation throws without a selection and no database override", () => {
    const ws = makeWorkspace();
    expect(() => ws.registerRelation("a", "x", "b", "y")).toThrow(/No database selected/);
  });
});
