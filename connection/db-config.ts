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
  type: "mysql" | "postgres";
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
  type: "mysql" | "postgres";
  host: string;
  port: number;
  username: string;
  password: string; // resolved plaintext
  defaultDatabase?: string;
  queryLimit: number; // resolved: config value or DEFAULT_QUERY_LIMIT
}

// ====== Paths ======

const DEFAULT_PATH = join(homedir(), ".pi", "database", "connections.yaml");

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      throw new Error(
        `Environment variable '${name}' referenced in connections.yaml but not set`
      );
    }
    return envVal;
  });
}

/**
 * Load and resolve the connections configuration.
 * Returns empty array if the file doesn't exist (first-time setup).
 * Throws only if the file exists but is malformed.
 */
export function loadConnectionsConfig(configPath?: string): ResolvedConnectionConfig[] {
  const path = configPath ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    return [];
  }

  const raw = readFileSync(path, "utf-8");
  if (raw.trim() === "") {
    return [];
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
      throw new Error(
        `Connection '${id}' missing required fields (environment, type, host)`
      );
    }

    resolved.push({
      id,
      environment: c.environment,
      type: c.type,
      host: c.host,
      port: c.port ?? 3306,
      username: c.username ?? "root",
      password: c.password ? resolveEnvVars(c.password) : "",
      defaultDatabase: c.defaultDatabase,
      queryLimit: c.queryLimit ?? DEFAULT_QUERY_LIMIT,
    });
  }

  return resolved;
}

/** Path to the connections config file, for use in help messages. */
export function getConnectionsConfigPath(configPath?: string): string {
  return configPath ?? DEFAULT_PATH;
}

