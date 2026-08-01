/**
 * DatabaseWorkspaceService —— /db 命令背后的唯一模块。
 *
 * 将 WorkspaceContext（状态、切换、schema 缓存）和 QueryRunner
 * （查询执行、历史）吸收进一个深度模块。所有委托都是私有字段——
 * 命令只能通过下面列出的方法穿越外部接缝。
 */

import { load as parseYaml, dump } from "js-yaml";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadConnectionsConfig,
  getConnectionsConfigPath,
  type ResolvedConnectionConfig,
} from "../connection/db-config";
import { DatabaseConnectionManager } from "../connection/db-manager";
import { prepareMutationQuery } from "../connection/sql-policy";
import {
  QueryHistoryStore,
  FavoriteStore,
  type HistoryEntry,
  type FavoriteEntry,
  type HistoryFilter,
} from "../history/store";
import { RelationGraph } from "../relation-graph";
import type { RelatedResult, SqlRow, StoredRelation, TableSchema } from "../types";
import { StateStore } from "./state-store";

// ====== 内部类型 ======

interface WorkspaceState {
  environment: string;
  connectionId: string;
  database: string;
}

/** 调用的有效目标：默认工作空间选择，可逐调用覆盖。 */
interface QueryTarget {
  connectionId: string;
  database: string;
}

/** 写操作确认请求：校验结果 + 解析后的目标，由 facade 合并后交给确认回调。 */
export interface MutationApprovalRequest {
  sql: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  warning?: string;
  connectionId: string;
  database: string;
}

/** 写操作结果：用户拒绝是正常结果（rejected），非异常。 */
type MutationOutcome =
  | { status: "rejected"; sql: string }
  | {
      status: "executed";
      affectedRows: number;
      elapsed: string;
      sql: string;
      connectionId: string;
      database: string;
    };

// ====== 持久化辅助 ======

function loadWorkspace(filePath: string): WorkspaceState | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (
      data &&
      typeof data.environment === "string" &&
      typeof data.connectionId === "string" &&
      typeof data.database === "string"
    ) {
      return data as WorkspaceState;
    }
    return null;
  } catch {
    return null;
  }
}

function saveWorkspace(filePath: string, state: WorkspaceState): void {
  const dir = join(filePath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

// ====== 服务 ======

export class DatabaseWorkspaceService {
  // ── 私有委托 ──────────────────────────────────────────

  private store: StateStore;
  private connections: ResolvedConnectionConfig[];
  private configWarnings: string[];
  private manager: DatabaseConnectionManager;
  private history: QueryHistoryStore;
  private favorites: FavoriteStore;
  private relationGraph: RelationGraph;

  // ── 内部状态 ─────────────────────────────────────────────

  private currentState: WorkspaceState | null;

  get current(): WorkspaceState | null {
    return this.currentState;
  }

  // ── 构造函数 ────────────────────────────────────────────────

  constructor(state?: StateStore, manager?: DatabaseConnectionManager) {
    this.store = state ?? new StateStore();
    const result = loadConnectionsConfig(this.store.connectionsFile);
    this.connections = result.connections;
    this.configWarnings = result.warnings;
    this.manager = manager ?? new DatabaseConnectionManager(this.connections);
    this.history = new QueryHistoryStore(this.store.sqlite);
    this.favorites = new FavoriteStore(this.store.sqlite);
    this.relationGraph = new RelationGraph(this.store.sqlite);
    this.currentState = loadWorkspace(this.store.workspaceFile);
  }

  // ── 配置重载 ────────────────────────────────────────────

  /**
   * 从磁盘重新加载连接配置。用户（或代表用户的 AI）创建或编辑了
   * connections.yaml 后有用——无需 /reload。先销毁旧连接管理器避免连接池
   * 泄漏；新连接池在首次使用时懒创建。
   */
  reloadConfig(): void {
    const result = loadConnectionsConfig(this.store.connectionsFile);
    this.connections = result.connections;
    this.configWarnings = result.warnings;
    this.manager.destroy();
    this.manager = new DatabaseConnectionManager(this.connections);
  }

  /**
   * 向 connections.yaml 添加新连接并热重载。
   * 文件或父目录不存在时自动创建。
   */
  createConnection(
    name: string,
    cfg: {
      environment: string;
      type: "mysql";
      host: string;
      port: number;
      username: string;
      password: string;
      defaultDatabase?: string;
    },
  ): void {
    const filePath = this.store.connectionsFile;
    const dir = join(filePath, "..");

    // 读取现有内容，或从零开始。
    let data: Record<string, any> = { connections: {} };
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      if (raw.trim()) {
        const parsed = parseYaml(raw) as Record<string, any>;
        if (parsed && typeof parsed === "object" && parsed.connections) {
          data = parsed;
        }
      }
    }

    // 构建连接条目。
    const entry: Record<string, any> = {
      environment: cfg.environment,
      type: cfg.type,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
    };
    if (cfg.defaultDatabase) {
      entry.defaultDatabase = cfg.defaultDatabase;
    }

    data.connections[name] = entry;

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, dump(data), "utf-8");

    // 热重载，使新连接立即可用。
    this.reloadConfig();
  }

  // ── 状态检查 ───────────────────────────────────────────────

  get isReady(): boolean {
    return this.current !== null;
  }

  get isConfigured(): boolean {
    return this.connections.length > 0;
  }

  get configPath(): string {
    return getConnectionsConfigPath(this.store.connectionsFile);
  }

  getConfigWarnings(): string[] {
    return this.configWarnings;
  }

  get statusLabel(): string {
    if (!this.current) return "";
    return `🗄 ${this.current.environment}/${this.current.database}`;
  }

  // ── 环境 / 连接查找 ────────────────────────────────────────────

  getEnvironments(): string[] {
    return [...new Set(this.connections.map((c) => c.environment))].sort();
  }

  getConnectionIdsForEnv(env: string): string[] {
    return this.connections
      .filter((c) => c.environment === env)
      .map((c) => c.id)
      .sort();
  }

  getCurrentConnection(): ResolvedConnectionConfig | undefined {
    if (!this.current) return undefined;
    return this.connections.find((c) => c.id === this.current!.connectionId);
  }

  /** 按 ID 查找连接配置——在 switchTo 之前也可用。 */
  getConnectionConfig(connectionId: string): ResolvedConnectionConfig | undefined {
    return this.connections.find((c) => c.id === connectionId);
  }

  // ── 切换 ─────────────────────────────────────────────────────

  switchTo(environment: string, connectionId: string, database: string): void {
    this.currentState = { environment, connectionId, database };
    saveWorkspace(this.store.workspaceFile, this.currentState);
  }

  // ── 目标解析 ──────────────────────────────────────────────────

  /**
   * 解析一次调用应命中的连接 + 数据库。
   * 默认工作空间选择；显式 connectionId 不带 database 时回退到该连接的
   * defaultDatabase。单独传 database 时命中当前连接上的另一个库——同一实例
   * 的跨库查询在 MySQL 中可原生用 `db.table` 限定名。
   */
  resolveTarget(opts?: { connectionId?: string; database?: string }): QueryTarget {
    const connectionId = opts?.connectionId ?? this.current?.connectionId;
    if (!connectionId) {
      throw new Error(
        "No database selected. Run /db switch first, or pass connection + database explicitly.",
      );
    }
    const cfg = this.connections.find((c) => c.id === connectionId);
    if (!cfg) {
      const available = this.connections.map((c) => c.id).join(", ");
      throw new Error(`Connection '${connectionId}' not found. Available: ${available}`);
    }
    const database =
      opts?.database ??
      (connectionId === this.current?.connectionId ? this.current!.database : cfg.defaultDatabase);
    if (!database) {
      throw new Error(
        `No database specified and connection '${connectionId}' has no defaultDatabase`,
      );
    }
    return { connectionId, database };
  }

  /** 列出已配置连接（id / environment / defaultDatabase），用于发现。 */
  listConnections(): Array<{ id: string; environment: string; defaultDatabase?: string }> {
    return this.connections.map((c) => ({
      id: c.id,
      environment: c.environment,
      defaultDatabase: c.defaultDatabase,
    }));
  }

  // ── 数据库（始终实时）───────────────────────────────────────

  async getDatabases(connectionId?: string): Promise<string[]> {
    const id = connectionId ?? this.current?.connectionId;
    if (!id) throw new Error("No database selected");
    return this.manager.getDatabases(id);
  }

  // ── 表（始终实时）──────────────────────────────────────────

  async getTables(opts?: { connectionId?: string; database?: string }): Promise<string[]> {
    const target = this.resolveTarget(opts);
    return this.manager.getTables(target.connectionId, target.database);
  }

  // ── 表结构（始终实时）────────────────────────────────────────

  async getTableSchema(
    table: string,
    opts?: { connectionId?: string; database?: string },
  ): Promise<TableSchema> {
    const target = this.resolveTarget(opts);
    return this.manager.getTableSchema(target.connectionId, target.database, table);
  }

  // ── 查询 ──────────────────────────────────────────────────────

  async executeQuery(
    sql: string,
    opts?: { connectionId?: string; database?: string },
  ): Promise<{
    columns: string[];
    rows: SqlRow[];
    elapsed: string;
    sql: string;
    connectionId: string;
    database: string;
  }> {
    const target = this.resolveTarget(opts);
    const result = await this.manager.executeQuery(target.connectionId, target.database, sql);
    return { ...result, connectionId: target.connectionId, database: target.database };
  }

  async executeQueryWithRelations(
    sql: string,
    table: string,
    autoJoin: boolean,
    maxDepth = 2,
    relatedLimit = 10,
  ): Promise<{
    columns: string[];
    rows: SqlRow[];
    elapsed: string;
    sql: string;
    related: RelatedResult[];
  }> {
    if (!this.current) throw new Error("No database selected");
    const { connectionId, database } = this.current;

    const result = await this.manager.executeQuery(connectionId, database, sql);

    let related: RelatedResult[] = [];

    if (autoJoin && result.rows.length > 0) {
      try {
        related = await this.relationGraph.bfsQuery(
          async (s, params) => {
            const { rows, elapsed } = await this.manager.executeQuery(connectionId, database, s, {
              params,
            });
            return { rows, elapsed };
          },
          database,
          table,
          result.rows,
          maxDepth,
          relatedLimit,
        );
      } catch {
        // 非致命：关联查询失败时仍返回主结果
      }
    }

    return { ...result, related };
  }

  // ── 变更（唯一写入口）────────────────────────────────

  /**
   * 执行数据变更（INSERT/UPDATE/DELETE/REPLACE）——唯一写路径，持有完整仪式：
   * 校验（DDL 直接抛 MutationValidationError，不进入确认）→ 人工确认 →
   * 执行。确认回调由调用方注入（生产 = showMutationConfirm，测试 = stub），
   * facade 保持 pi-free。用户拒绝是正常结果（status: "rejected"），非异常。
   */
  async executeMutationWithApproval(
    sql: string,
    opts: { connectionId?: string; database?: string },
    confirm: (req: MutationApprovalRequest) => Promise<boolean>,
  ): Promise<MutationOutcome> {
    const validation = prepareMutationQuery(sql);
    const target = this.resolveTarget(opts);

    const approved = await confirm({
      sql: validation.sql,
      operation: validation.operation,
      warning: validation.warning,
      connectionId: target.connectionId,
      database: target.database,
    });
    if (!approved) {
      return { status: "rejected", sql: validation.sql };
    }

    const result = await this.manager.executeMutation(
      target.connectionId,
      target.database,
      validation.sql,
    );
    return {
      status: "executed",
      ...result,
      connectionId: target.connectionId,
      database: target.database,
    };
  }

  // ── 历史 ────────────────────────────────────────────────────

  saveHistory(sql: string, rowCount: number, elapsed: string, target?: QueryTarget): HistoryEntry {
    const t =
      target ??
      (this.current
        ? { connectionId: this.current.connectionId, database: this.current.database }
        : null);
    if (!t) throw new Error("No database selected");
    return this.history.save({
      connectionId: t.connectionId,
      environment:
        this.connections.find((c) => c.id === t.connectionId)?.environment ??
        this.current?.environment ??
        "",
      database: t.database,
      sql,
      rowCount,
      elapsed,
    });
  }

  listHistory(keyword?: string): HistoryEntry[] {
    const filter: HistoryFilter = { limit: 20 };
    if (keyword) filter.keyword = keyword;
    if (this.current) filter.database = this.current.database;
    return this.history.list(filter);
  }

  deleteHistory(id: number): boolean {
    return this.history.delete(id);
  }

  // ── 收藏 ──────────────────────────────────────────────────

  saveFavorite(name: string, sql: string, description?: string): FavoriteEntry {
    return this.favorites.save({
      name,
      sql,
      database: this.current?.database ?? "",
      description: description ?? "",
    });
  }

  listFavorites(keyword?: string): FavoriteEntry[] {
    return this.favorites.list({
      database: this.current?.database,
      keyword,
    });
  }

  deleteFavorite(id: number): boolean {
    return this.favorites.delete(id);
  }

  // ── 关系 ──────────────────────────────────────────────────

  listRelations(table?: string, database?: string): StoredRelation[] {
    const schema = database ?? this.current?.database;
    if (!schema) return this.relationGraph.listAll();
    return this.relationGraph.list(schema, table);
  }

  upsertRelation(
    sourceTable: string,
    sourceColumn: string,
    refTable: string,
    refColumn: string,
    opts?: { condition?: string; relationType?: string; database?: string },
  ): StoredRelation {
    const schema = opts?.database ?? this.current?.database;
    if (!schema) throw new Error("No database selected");
    return this.relationGraph.upsert(
      { schema, table: sourceTable, column: sourceColumn, condition: opts?.condition || undefined },
      { schema, table: refTable, column: refColumn },
      opts?.relationType ?? "MANY_TO_ONE",
    );
  }

  removeRelation(id: number): boolean {
    return this.relationGraph.removeById(id);
  }

  removeRelationByColumns(
    database: string,
    sourceTable: string,
    sourceColumn: string,
    refTable: string,
    refColumn: string,
  ): boolean {
    return this.relationGraph.remove(
      { schema: database, table: sourceTable, column: sourceColumn },
      { schema: database, table: refTable, column: refColumn },
    );
  }

  async discoverForeignKeys(): Promise<number> {
    if (!this.current) throw new Error("No database selected");
    const { connectionId, database: schema } = this.current;

    const fkRelations = await this.manager.discoverForeignKeys(connectionId, schema);
    return this.relationGraph.mergeForeignKeys(fkRelations);
  }

  // ── 生命周期 ──────────────────────────────────────────────────

  destroy(): void {
    this.manager.destroy();
    this.store.close();
  }
}
