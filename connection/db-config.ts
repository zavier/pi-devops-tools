/**
 * Database connection configuration types and YAML loader.
 *
 * Reads ~/.pi/database/connections.yaml — a global, user-scoped config
 * separate from the project's .pi/config.json. Supports ${ENV_VAR} placeholders.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { DEFAULT_QUERY_LIMIT } from "./sql-policy";
import { homedir } from "node:os";

// ====== Config file types ======

export interface ConnectionConfig {
  environment: string;
  type: "mysql";
  host: string;
  port: number;
  username: string;
  password: string; // raw, may contain ${ENV_VAR}
  defaultDatabase?: string;
  queryLimit?: number; // row cap for SELECTs without LIMIT (default: DEFAULT_QUERY_LIMIT)
}

export interface ConnectionsFile {
  connections: Record<string, ConnectionConfig>;
}

// ====== Resolved types (after env-var substitution) ======

export interface ResolvedConnectionConfig {
  id: string;
  environment: string;
  type: "mysql";
  host: string;
  port: number;
  username: string;
  password: string; // resolved plaintext
  defaultDatabase?: string;
  queryLimit: number; // resolved: config value or DEFAULT_QUERY_LIMIT
}

// ====== Paths ======

const DEFAULT_PATH = join(homedir(), ".pi", "database", "connections.yaml");

function resolveEnvVars(value: string): { resolved: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const resolved = value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      unresolved.push(name);
      return "";
    }
    return envVal;
  });
  return { resolved, unresolved };
}

export interface ConfigLoadResult {
  connections: ResolvedConnectionConfig[];
  /** Warnings about skipped connections or unresolved env vars. */
  warnings: string[];
}

/**
 * Load and resolve the connections configuration.
 * Returns empty array if the file doesn't exist (first-time setup).
 * Throws only if the file exists but is malformed.
 * Connections with unresolved env vars are not skipped — their password
 * resolves to empty string; a warning is emitted so the user knows why
 * authentication will fail when they try to connect.
 */
export function loadConnectionsConfig(configPath?: string): ConfigLoadResult {
  const path = configPath ?? DEFAULT_PATH;
  const warnings: string[] = [];

  if (!existsSync(path)) {
    return {
      connections: [],
      warnings: [`未找到连接配置文件。在 ${path} 中创建文件以配置数据库连接。`],
    };
  }

  const raw = readFileSync(path, "utf-8");
  if (raw.trim() === "") {
    return { connections: [], warnings: [`连接配置文件为空：${path}`] };
  }

  const parsed = parseYaml(raw) as ConnectionsFile;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`connections.yaml is malformed`);
  }

  if (!parsed.connections || typeof parsed.connections !== "object") {
    throw new Error(`connections.yaml must have a top-level 'connections' map`);
  }

  const resolved: ResolvedConnectionConfig[] = [];

  for (const [id, cfg] of Object.entries(parsed.connections)) {
    const c = cfg as ConnectionConfig;

    if (!c.environment || !c.type || !c.host) {
      throw new Error(`Connection '${id}' missing required fields (environment, type, host)`);
    }

    let password = "";
    let pwdUnresolved: string[] = [];
    if (c.password) {
      const result = resolveEnvVars(c.password);
      password = result.resolved;
      pwdUnresolved = result.unresolved;
    }

    for (const varName of pwdUnresolved) {
      warnings.push(`连接 "${id}"：环境变量 \${${varName}} 未设置，密码将为空`);
    }

    resolved.push({
      id,
      environment: c.environment,
      type: c.type,
      host: c.host,
      port: c.port ?? 3306,
      username: c.username ?? "root",
      password,
      defaultDatabase: c.defaultDatabase,
      queryLimit: c.queryLimit ?? DEFAULT_QUERY_LIMIT,
    });
  }

  return { connections: resolved, warnings };
}

/** Path to the connections config file, for use in help messages. */
export function getConnectionsConfigPath(configPath?: string): string {
  return configPath ?? DEFAULT_PATH;
}
