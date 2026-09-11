/**
 * 工作空间选择的持久化 —— 按项目（cwd）键控。
 *
 * 纯模块：只做"路径 + 键 → 记录"的读写，不导入 pi、不持有状态。
 *
 * 文件：<baseDir>/workspaces.json
 * 格式：{ "version": 1, "workspaces": { "<规范化 cwd>": WorkspaceRecord } }
 *
 * 为什么按 cwd 键控：选择本质是"项目 → 数据库"的映射。此前是全局单文件，
 * 导致选择跨项目携带、且并发会话互相覆盖（见
 * docs/workspace-scope-and-status-noise.md）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** 一次选择：环境 + 连接 + 数据库。 */
export interface WorkspaceState {
  environment: string;
  connectionId: string;
  database: string;
}

/** 落盘记录：选择 + 时间戳（便于排查"这个选择是什么时候留下的"）。 */
export interface WorkspaceRecord extends WorkspaceState {
  updatedAt: string;
}

/** 文件结构（v1）。 */
interface WorkspaceFileV1 {
  version: 1;
  workspaces: Record<string, WorkspaceRecord>;
}

const FILE_VERSION = 1;

/**
 * 规范化 scope 键：绝对路径 + 解析符号链接别名。
 * 目录不存在（已被删除）时退回绝对路径——此类条目仍可读，只是不再写入。
 */
export function normalizeScopeKey(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** 核心三字段必须是字符串；其余（含 updatedAt）由 toRecord 归一。 */
function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.environment === "string" &&
    typeof r.connectionId === "string" &&
    typeof r.database === "string"
  );
}

/** 文件可能被手工编辑：缺 updatedAt 视为空字符串，仍保留该条选择。 */
function toRecord(value: unknown): WorkspaceRecord | null {
  if (!isWorkspaceState(value)) return null;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  return {
    environment: value.environment,
    connectionId: value.connectionId,
    database: value.database,
    updatedAt: typeof updatedAt === "string" ? updatedAt : "",
  };
}

/** 读取整个文件；缺失、JSON 损坏、版本不认识 → 空结构（等价"未选择"，不抛错）。 */
function readWorkspaceFile(filePath: string): WorkspaceFileV1 {
  const empty: WorkspaceFileV1 = { version: FILE_VERSION, workspaces: {} };
  try {
    if (!existsSync(filePath)) return empty;
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
      version?: unknown;
      workspaces?: unknown;
    };
    if (!parsed || typeof parsed !== "object" || parsed.version !== FILE_VERSION) return empty;

    const workspaces: Record<string, WorkspaceRecord> = {};
    const entries = (parsed.workspaces ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(entries)) {
      const record = toRecord(value);
      if (record) workspaces[key] = record;
    }
    return { version: FILE_VERSION, workspaces };
  } catch {
    return empty;
  }
}

/** 读取某个项目的选择；无记录返回 null。 */
export function loadWorkspaceRecord(filePath: string, scopeKey: string): WorkspaceRecord | null {
  return readWorkspaceFile(filePath).workspaces[scopeKey] ?? null;
}

/**
 * 写入某个项目的选择（读-改-写整个文件，原子替换）。
 *
 * 原子写：先写临时文件再 rename——中断不会留下半截 JSON 让选择丢失。
 * 并发会话同项目同时切换时是"后写者胜"（丢的是另一次切换，不是文件）。
 */
export function saveWorkspaceRecord(
  filePath: string,
  scopeKey: string,
  record: WorkspaceRecord,
): void {
  const file = readWorkspaceFile(filePath);
  file.workspaces[scopeKey] = record;

  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

/**
 * 归档旧版全局选择文件（workspace.json → workspace.json.legacy）。
 *
 * 故意不把旧值播种到任何项目：那个值是全局的，播种等于把已修复的
 * 跨项目泄漏原样复制一遍。代价是升级后每个项目重选一次（一次性）。
 * 返回是否真的做了归档。
 */
export function archiveLegacyWorkspace(legacyPath: string): boolean {
  if (!existsSync(legacyPath)) return false;
  try {
    renameSync(legacyPath, `${legacyPath}.legacy`);
    return true;
  } catch {
    return false;
  }
}
