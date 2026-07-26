import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConnectionsConfig } from "../connection/db-config";
import { DEFAULT_QUERY_LIMIT } from "../connection/sql-policy";

describe("loadConnectionsConfig", () => {
  const paths: string[] = [];

  function tmpFile(content: string): string {
    const p = join(
      tmpdir(),
      `test-connections-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`,
    );
    writeFileSync(p, content);
    paths.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of paths) {
      try {
        unlinkSync(p);
      } catch {
        /* ok */
      }
    }
    paths.length = 0;
  });

  it("returns empty connections with warning when file does not exist", () => {
    const result = loadConnectionsConfig("/nonexistent/path/connections.yaml");
    expect(result.connections).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("resolves queryLimit to the configured value", () => {
    const path = tmpFile(`connections:
  a:
    environment: prod
    type: mysql
    host: h
    queryLimit: 50
`);
    const result = loadConnectionsConfig(path);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].queryLimit).toBe(50);
  });

  it("defaults queryLimit when not specified", () => {
    const path = tmpFile(`connections:
  a:
    environment: prod
    type: mysql
    host: h
`);
    const result = loadConnectionsConfig(path);
    expect(result.connections[0].queryLimit).toBe(DEFAULT_QUERY_LIMIT);
  });

  it("resolves ${ENV_VAR} in passwords", () => {
    process.env.TEST_DB_PASS = "secret123";
    try {
      const path = tmpFile(`connections:
  a:
    environment: prod
    type: mysql
    host: h
    password: \${TEST_DB_PASS}
`);
      const result = loadConnectionsConfig(path);
      expect(result.connections[0].password).toBe("secret123");
      expect(result.warnings).toEqual([]);
    } finally {
      delete process.env.TEST_DB_PASS;
    }
  });

  it("warns on unresolved env vars instead of throwing", () => {
    const path = tmpFile(`connections:
  a:
    environment: prod
    type: mysql
    host: h
    password: \${NONEXISTENT_VAR}
`);
    const result = loadConnectionsConfig(path);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].password).toBe("");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("NONEXISTENT_VAR");
  });
});
