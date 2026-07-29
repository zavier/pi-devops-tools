/**
 * DatabaseWorkspaceService — the single module behind the /db command.
 *
 * Absorbs WorkspaceContext (state, switching, schema cache) and QueryRunner
 * (query execution, history, lastSql) into one deep module. All delegates
 * are private — commands cross the external seam only through the methods
 * listed below.
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
import {
  QueryHistoryStore,
  FavoriteStore,
  type HistoryEntry,
  type FavoriteEntry,
  type HistoryFilter,
} from "../history/store";
import { RelationGraph } from "../relation-graph";
import type { RelationRow } from "../relation/store";
import type { RelatedResult, SqlRow } from "../types";
import { StateStore } from "./state-store";

// ====== Internal types ======

interface WorkspaceState {
  environment: string;
  connectionId: string;
  database: string;
}

/** Effective target of a call: defaults to the workspace selection, overridable per call. */
export interface QueryTarget {
  connectionId: string;
  database: string;
}

// ====== Persistence helpers ======

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

// ====== Service ======

export class DatabaseWorkspaceService {
  // ── Private delegates ──────────────────────────────────────────

  private store: StateStore;
  private connections: ResolvedConnectionConfig[];
  private configWarnings: string[];
  private manager: DatabaseConnectionManager;
  private history: QueryHistoryStore;
  private favorites: FavoriteStore;
  private relationGraph: RelationGraph;

  // ── Internal state ─────────────────────────────────────────────

  current: WorkspaceState | null;
  private _lastSql: string | null = null;

  // ── Constructor ────────────────────────────────────────────────

  constructor(state?: StateStore) {
    this.store = state ?? new StateStore();
    const result = loadConnectionsConfig(this.store.connectionsFile);
    this.connections = result.connections;
    this.configWarnings = result.warnings;
    this.manager = new DatabaseConnectionManager(this.connections);
    this.history = new QueryHistoryStore(this.store.sqlite);
    this.favorites = new FavoriteStore(this.store.sqlite);
    this.relationGraph = new RelationGraph(this.store.sqlite);
    this.current = loadWorkspace(this.store.workspaceFile);
  }

  // ── Config reload ────────────────────────────────────────────

  /**
   * Reload connections config from disk. Useful after the user (or AI on
   * their behalf) has created or edited connections.yaml — no /reload
   * needed. The old connection manager is destroyed first so its pools
   * don't leak; new pools are created lazily on first use.
   */
  reloadConfig(): void {
    const result = loadConnectionsConfig(this.store.connectionsFile);
    this.connections = result.connections;
    this.configWarnings = result.warnings;
    this.manager.destroy();
    this.manager = new DatabaseConnectionManager(this.connections);
  }

  /**
   * Add a new connection to connections.yaml and hot-reload.
   * Creates the file and parent directories if they don't exist.
   */
  createConnection(
    env: string,
    name: string,
    cfg: {
      environment: string;
      type: "mysql" | "postgres";
      host: string;
      port: number;
      username: string;
      password: string;
      defaultDatabase?: string;
    },
  ): void {
    const filePath = this.store.connectionsFile;
    const dir = join(filePath, "..");

    // Read existing or start fresh.
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

    // Build the connection entry.
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

    // Hot-reload so the new connection is immediately available.
    this.reloadConfig();
  }

  // ── State checks ───────────────────────────────────────────────

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

  // ── lastSql ────────────────────────────────────────────────────

  get lastSql(): string | null {
    return this._lastSql;
  }

  // ── Environment / connection lookup ────────────────────────────

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

  /** Look up a connection config by ID — works before switchTo has been called. */
  getConnectionConfig(connectionId: string): ResolvedConnectionConfig | undefined {
    return this.connections.find((c) => c.id === connectionId);
  }

  // ── Switch ─────────────────────────────────────────────────────

  switchTo(environment: string, connectionId: string, database: string): void {
    this.current = { environment, connectionId, database };
    saveWorkspace(this.store.workspaceFile, this.current);
  }

  // ── Target resolution ──────────────────────────────────────────

  /**
   * Resolve which connection + database a call should hit.
   * Defaults to the workspace selection; an explicit connectionId without a
   * database falls back to that connection's defaultDatabase. A database
   * alone targets another database on the current connection — same-instance
   * cross-db queries work natively in MySQL via `db.table` qualified names.
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

  /** List configured connections (id / environment / defaultDatabase) for discovery. */
  listConnections(): Array<{ id: string; environment: string; defaultDatabase?: string }> {
    return this.connections.map((c) => ({
      id: c.id,
      environment: c.environment,
      defaultDatabase: c.defaultDatabase,
    }));
  }

  // ── Databases (always live) ────────────────────────────────────

  async getDatabases(connectionId?: string): Promise<string[]> {
    const id = connectionId ?? this.current?.connectionId;
    if (!id) throw new Error("No database selected");
    return this.manager.getDatabases(id);
  }

  // ── Tables (always live) ───────────────────────────────────────

  async getTables(opts?: { connectionId?: string; database?: string }): Promise<string[]> {
    const target = this.resolveTarget(opts);
    return this.manager.getTables(target.connectionId, target.database);
  }

  // ── Table schema (always live) ─────────────────────────────────

  async getTableSchema(
    table: string,
    opts?: { connectionId?: string; database?: string },
  ): Promise<{ columns: SqlRow[]; indexes: SqlRow[] }> {
    const target = this.resolveTarget(opts);
    return this.manager.getTableSchema(target.connectionId, target.database, table);
  }

  // ── Query ──────────────────────────────────────────────────────

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
          (s, params) => this.manager.executeQuery(connectionId, database, s, { params }),
          database,
          table,
          result.rows,
          maxDepth,
          relatedLimit,
        );
      } catch {
        // Non-fatal: if relation query fails, still return primary results
      }
    }

    return { ...result, related };
  }

  // ── Mutation ───────────────────────────────────────────────────

  /**
   * Execute a data mutation (INSERT/UPDATE/DELETE/REPLACE).
   * Bypasses the read-only guard — callers must enforce their own approval gate.
   */
  async executeMutation(
    sql: string,
    opts?: { connectionId?: string; database?: string },
  ): Promise<{
    affectedRows: number;
    elapsed: string;
    sql: string;
    connectionId: string;
    database: string;
  }> {
    const target = this.resolveTarget(opts);
    const result = await this.manager.executeMutation(target.connectionId, target.database, sql);
    this._lastSql = sql;
    return { ...result, connectionId: target.connectionId, database: target.database };
  }

  // ── History ────────────────────────────────────────────────────

  saveHistory(sql: string, rowCount: number, elapsed: string, target?: QueryTarget): HistoryEntry {
    const t =
      target ??
      (this.current
        ? { connectionId: this.current.connectionId, database: this.current.database }
        : null);
    if (!t) throw new Error("No database selected");
    this._lastSql = sql;
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

  getHistoryById(id: number): HistoryEntry | undefined {
    return this.history.getById(id);
  }

  deleteHistory(id: number): boolean {
    return this.history.delete(id);
  }

  // ── Favorites ──────────────────────────────────────────────────

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

  // ── Relations ──────────────────────────────────────────────────

  listRelations(table?: string, database?: string): RelationRow[] {
    const schema = database ?? this.current?.database;
    if (!schema) return this.relationGraph.listAll();
    return this.relationGraph.list(schema, table);
  }

  registerRelation(
    sourceTable: string,
    sourceColumn: string,
    refTable: string,
    refColumn: string,
    opts?: { condition?: string; relationType?: string; database?: string },
  ): RelationRow {
    const schema = opts?.database ?? this.current?.database;
    if (!schema) throw new Error("No database selected");
    return this.relationGraph.register(
      { schema, table: sourceTable, column: sourceColumn, condition: opts?.condition || undefined },
      { schema, table: refTable, column: refColumn },
      opts?.relationType ?? "MANY_TO_ONE",
    );
  }

  removeRelation(id: number): boolean {
    return this.relationGraph.removeById(id);
  }

  async discoverForeignKeys(): Promise<number> {
    if (!this.current) throw new Error("No database selected");
    const { connectionId, database: schema } = this.current;

    const fkRelations = await this.manager.discoverForeignKeys(connectionId, schema);
    return this.relationGraph.mergeForeignKeys(fkRelations);
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  destroy(): void {
    this.manager.destroy();
    this.store.close();
  }
}
