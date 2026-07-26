import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and parses a valid config", () => {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "config.json"), JSON.stringify({
      databases: {
        "my-cluster": {
          host: "10.0.0.1", port: 3306, user: "root",
          password: "secret123", dbs: ["db1", "db2"]
        }
      },
      servers: {},
      services: {}
    }));

    const config = loadConfig(tmpDir);

    expect(config.databases["my-cluster"].host).toBe("10.0.0.1");
    expect(config.databases["my-cluster"].port).toBe(3306);
    expect(config.databases["my-cluster"].user).toBe("root");
    expect(config.databases["my-cluster"].password).toBe("secret123");
    expect(config.databases["my-cluster"].dbs).toEqual(["db1", "db2"]);
  });

  it("replaces ${VAR} placeholders from process.env", () => {
    process.env.TEST_DB_PASS = "from-env";
    try {
      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir);
      fs.writeFileSync(path.join(piDir, "config.json"), JSON.stringify({
        databases: {
          "c": { host: "h", port: 1, user: "u",
            password: "${TEST_DB_PASS}", dbs: [] }
        },
        servers: {},
        services: {}
      }));

      const config = loadConfig(tmpDir);

      expect(config.databases["c"].password).toBe("from-env");
    } finally {
      delete process.env.TEST_DB_PASS;
    }
  });

  it("throws when config.json is missing", () => {
    expect(() => loadConfig(tmpDir)).toThrow(/config\.json not found/);
  });

  it("throws when config.json has invalid structure", () => {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "config.json"), JSON.stringify({ foo: "bar" }));

    expect(() => loadConfig(tmpDir)).toThrow(/databases/);
  });

  it("applies defaults for server optional fields", () => {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "config.json"), JSON.stringify({
      databases: {},
      servers: {
        "web": { host: "10.0.0.2", user: "deploy" }
      },
      services: {}
    }));

    const config = loadConfig(tmpDir);

    expect(config.servers["web"].port).toBe(22);
    expect(config.servers["web"].keyPath).toBe("~/.ssh/id_rsa");
    expect(config.servers["web"].jumpHost).toBeNull();
  });

  it("throws when env var referenced in config is not set", () => {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(path.join(piDir, "config.json"), JSON.stringify({
      databases: {
        "c": { host: "h", port: 1, user: "u",
          password: "${NONEXISTENT_VAR}", dbs: [] }
      },
      servers: {},
      services: {}
    }));

    expect(() => loadConfig(tmpDir)).toThrow(/NONEXISTENT_VAR/);
  });
});
