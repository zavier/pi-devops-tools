/**
 * Workspace state management for the /db command.
 *
 * Persists the current database context to ~/.pi/database/workspace.json
 * so it survives across sessions and Pi restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConnectionsConfig, getConnectionsConfigPath, type ResolvedConnectionConfig } from "../connection/db-config";
import { DatabaseConnectionManager } from "../connection/db-manager";
import { QueryHistoryStore, type HistoryEntry } from "../history/store";
import {
  loadSchemaCache,
  refreshSchemaCache,
  getCachedTables,
  getCachedTableSchema,
  type SchemaSnapshot,
  type CachedTable,
} from "../schema/cache";

// ====== Paths ======

const STATE_DIR = join(homedir(), ".pi", "database");
const STATE_FILE = join(STATE_DIR, "workspace.json");

// ====== Workspace state type ======

export interface WorkspaceState {
  environment: string;
  connectionId: string;
  database: string;
}

// ====== Persistence ======

export function loadWorkspace(): WorkspaceState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data.environment === "string" &&
        typeof data.connectionId === "string" &&
        typeof data.database === "string") {
      return data as WorkspaceState;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ====== Workspace Service ======

export class DatabaseWorkspaceService {
  readonly connections: ResolvedConnectionConfig[];
  readonly manager: DatabaseConnectionManager;
  readonly history: QueryHistoryStore;
  current: WorkspaceState | null;

  constructor() {
    this.connections = loadConnectionsConfig();
    this.manager = new DatabaseConnectionManager(this.connections);
    this.history = new QueryHistoryStore();
    this.current = loadWorkspace();
  }

  /** Whether a database context is currently selected. */
  isReady(): boolean {
    return this.current !== null;
  }

  /** Whether the connections config exists and has entries. */
  isConfigured(): boolean {
    return this.connections.length > 0;
  }

  /** Path to the connections config file (for help messages). */
  get configPath(): string {
    return getConnectionsConfigPath();
  }

  /** Get distinct environments from the config. */
  getEnvironments(): string[] {
    return [...new Set(this.connections.map(c => c.environment))].sort();
  }

  /** Get connection IDs for a given environment. */
  getConnectionIdsForEnv(env: string): string[] {
    return this.connections
      .filter(c => c.environment === env)
      .map(c => c.id)
      .sort();
  }

  /** Get the connection config for the current workspace. */
  getCurrentConnection(): ResolvedConnectionConfig | undefined {
    if (!this.current) return undefined;
    return this.connections.find(c => c.id === this.current!.connectionId);
  }

  /** Switch the workspace to a new environment/connection/database. */
  switchTo(environment: string, connectionId: string, database: string): void {
    this.current = { environment, connectionId, database };
    saveWorkspace(this.current);
  }

  /** Get databases for a connection. */
  async getDatabases(connectionId: string): Promise<string[]> {
    return this.manager.getDatabases(connectionId);
  }

  /** Get tables for the current workspace (cache-first). */
  async getTables(): Promise<string[]> {
    if (!this.current) throw new Error("No database selected");

    // Try cache first
    const cached = getCachedTables(this.current.connectionId, this.current.database);
    if (cached) return cached;

    // Fall back to DB query
    return this.manager.getTables(this.current.connectionId, this.current.database);
  }

  /** Execute a query in the current workspace. */
  async executeQuery(sql: string) {
    if (!this.current) throw new Error("No database selected");
    return this.manager.executeQuery(
      this.current.connectionId,
      this.current.database,
      sql
    );
  }

  /** Get table schema for the current workspace (cache-first). */
  async getTableSchema(table: string) {
    if (!this.current) throw new Error("No database selected");

    // Try cache first
    const cached = getCachedTableSchema(
      this.current.connectionId,
      this.current.database,
      table,
    );
    if (cached) {
      return {
        columns: cached.columns.map((c) => ({
          COLUMN_NAME: c.name,
          COLUMN_TYPE: c.type,
          IS_NULLABLE: c.nullable ? "YES" : "NO",
          COLUMN_KEY: c.key,
          COLUMN_DEFAULT: c.default,
          EXTRA: c.extra,
          COLUMN_COMMENT: c.comment,
        })),
        indexes: cached.indexes.flatMap((idx) =>
          idx.columns.map((col, i) => ({
            INDEX_NAME: idx.name,
            COLUMN_NAME: col,
            NON_UNIQUE: idx.unique ? 0 : 1,
            SEQ_IN_INDEX: i + 1,
          })),
        ),
      };
    }

    // Fall back to DB query
    return this.manager.getTableSchema(
      this.current.connectionId,
      this.current.database,
      table,
    );
  }

  /** Refresh schema cache from the database. */
  async refreshSchema(): Promise<SchemaSnapshot> {
    if (!this.current) throw new Error("No database selected");
    return refreshSchemaCache(
      this.manager,
      this.current.connectionId,
      this.current.database,
    );
  }

  /** Auto-load schema cache after switch. Returns true if cache was loaded. */
  autoLoadSchema(): SchemaSnapshot | null {
    if (!this.current) return null;
    return loadSchemaCache(this.current.connectionId, this.current.database);
  }

  /** Save a query execution to history. */
  saveHistory(sql: string, rowCount: number, elapsed: string): HistoryEntry {
    if (!this.current) throw new Error("No database selected");
    return this.history.save({
      connectionId: this.current.connectionId,
      environment: this.current.environment,
      database: this.current.database,
      sql,
      rowCount,
      elapsed,
    });
  }

  /** Release all resources. */
  destroy(): void {
    this.manager.destroy();
    this.history.close();
  }

  /** Status bar label for the current workspace. */
  get statusLabel(): string {
    if (!this.current) return "";
    return `🗄 ${this.current.environment}/${this.current.database}`;
  }
}
