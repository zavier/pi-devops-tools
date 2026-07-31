/**
 * 数据库连接配置的类型与 YAML 加载器。
 *
 * 读取 ~/.pi/database/connections.yaml —— 全局、用户级配置，
 * 与项目的 .pi/config.json 分离。支持 ${ENV_VAR} 占位符。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { DEFAULT_QUERY_LIMIT } from "./sql-policy";
import { homedir } from "node:os";

// ====== 配置文件类型 ======

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

// ====== 解析后类型（env 变量替换之后）========

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

// ====== 路径 ======

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
  /** 被跳过的连接或未解析的 env 变量的警告。 */
  warnings: string[];
}

/**
 * 加载并解析连接配置。
 * 文件不存在时返回空数组（首次设置）。
 * 仅当文件存在但格式错误时才抛错。
 * env 变量未解析的连接不会被跳过——其密码解析为空字符串；
 * 会发出警告，让用户知道连接时认证为何会失败。
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

/** 连接配置文件路径，用于帮助消息。 */
export function getConnectionsConfigPath(configPath?: string): string {
  return configPath ?? DEFAULT_PATH;
}
