import fs from "node:fs";
import path from "node:path";
import type { AppConfig, DatabaseConfig, ServerConfig, ServiceConfig } from "./types";

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      throw new Error(
        `Environment variable '${name}' referenced in config but not set`
      );
    }
    return envVal;
  });
}

function validateDatabaseConfig(obj: unknown): asserts obj is Record<string, DatabaseConfig> {
  if (!obj || typeof obj !== "object") throw new Error("config.databases must be an object");
  for (const [name, cfg] of Object.entries(obj as Record<string, any>)) {
    if (!cfg.host || !cfg.user || !cfg.dbs || !Array.isArray(cfg.dbs)) {
      throw new Error(
        `database '${name}' missing required fields (host, user, dbs)`
      );
    }
  }
}

function validateServerConfig(obj: unknown): asserts obj is Record<string, ServerConfig> {
  if (!obj || typeof obj !== "object") throw new Error("config.servers must be an object");
  for (const [name, cfg] of Object.entries(obj as Record<string, any>)) {
    if (!cfg.host || !cfg.user) {
      throw new Error(
        `server '${name}' missing required fields (host, user)`
      );
    }
  }
}

function validateServiceConfig(obj: unknown): asserts obj is Record<string, ServiceConfig> {
  if (!obj || typeof obj !== "object") throw new Error("config.services must be an object");
  for (const [name, cfg] of Object.entries(obj as Record<string, any>)) {
    if (!cfg.server || !cfg.logPath) {
      throw new Error(
        `service '${name}' missing required fields (server, logPath)`
      );
    }
  }
}

export function loadConfig(cwd?: string): AppConfig {
  const baseDir = cwd ?? process.cwd();
  const configPath = path.join(baseDir, ".pi", "config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`.pi/config.json not found at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  validateDatabaseConfig(parsed.databases);
  validateServerConfig(parsed.servers);
  validateServiceConfig(parsed.services);

  // Cast after validation — validators would have thrown if structure was wrong
  const databases = parsed.databases as Record<string, DatabaseConfig>;
  const servers = parsed.servers as Record<string, ServerConfig>;
  const services = parsed.services as Record<string, ServiceConfig>;

  // Deep-clone and resolve env vars
  const config: AppConfig = {
    databases: {},
    servers: {},
    services: {},
  };

  for (const [name, db] of Object.entries(databases)) {
    config.databases[name] = {
      ...db,
      password: resolveEnvVars(db.password ?? ""),
    };
  }

  for (const [name, srv] of Object.entries(servers)) {
    config.servers[name] = {
      host: srv.host,
      port: srv.port ?? 22,
      user: srv.user,
      keyPath: srv.keyPath ?? "~/.ssh/id_rsa",
      jumpHost: srv.jumpHost ?? null,
    };
  }

  for (const [name, svc] of Object.entries(services)) {
    config.services[name] = {
      server: svc.server,
      logPath: svc.logPath,
      errorLogPath: svc.errorLogPath,
      accessLogPath: svc.accessLogPath,
    };
  }

  return config;
}
