/**
 * WorkspaceContext — current database context, switching, and schema cache.
 *
 * Owns:
 * - Workspace state (environment, connectionId, database)
 * - Persistence (workspace.json)
 * - Connection config access (environments, connection IDs)
 * - Schema cache operations (load, refresh, auto-load)
 * - Table access (cache-first: cache → DB fallback)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConnectionsConfig, getConnectionsConfigPath, type ResolvedConnectionConfig } from "../connection/db-config";
import type { DatabaseConnectionManager } from "../connection/db-manager";
import {
  loadSchemaCache,
  refreshSchemaCache,
  getCachedTables,
  getCachedTableSchema,
  type SchemaSnapshot,
} from "../schema/cache";

// ====== Paths ======

const STATE_DIR = join(homedir(), ".pi", "database");
const STATE_FILE = join(STATE_DIR, "workspace.json");

// ====== Types ======

export interface WorkspaceState {
  environment: string;
  connectionId: string;
  database: string;
}

// ====== Persistence helpers ======

function loadWorkspace(): WorkspaceState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, "utf-8");
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

function saveWorkspace(state: WorkspaceState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ====== Context class ======

export class WorkspaceContext {
  readonly connections: ResolvedConnectionConfig[];
  current: WorkspaceState | null;

  constructor() {
    this.connections = loadConnectionsConfig();
    this.current = loadWorkspace();
  }

  // ── State checks ──────────────────────────────────────────────

  isReady(): boolean {
    return this.current !== null;
  }

  isConfigured(): boolean {
    return this.connections.length > 0;
  }

  get configPath(): string {
    return getConnectionsConfigPath();
  }

  get statusLabel(): string {
    if (!this.current) return "";
    return `🗄 ${this.current.environment}/${this.current.database}`;
  }

  // ── Environment / connection lookup ───────────────────────────

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

  // ── Switch ────────────────────────────────────────────────────

  switchTo(environment: string, connectionId: string, database: string): void {
    this.current = { environment, connectionId, database };
    saveWorkspace(this.current);
  }

  // ── Databases (always live) ───────────────────────────────────

  async getDatabases(manager: DatabaseConnectionManager, connectionId: string): Promise<string[]> {
    return manager.getDatabases(connectionId);
  }

  // ── Tables (cache-first) ──────────────────────────────────────

  async getTables(manager: DatabaseConnectionManager): Promise<string[]> {
    if (!this.current) throw new Error("No database selected");
    const cached = getCachedTables(this.current.connectionId, this.current.database);
    if (cached) return cached;
    return manager.getTables(this.current.connectionId, this.current.database);
  }

  // ── Table schema (cache-first) ─────────────────────────────────

  async getTableSchema(
    manager: DatabaseConnectionManager,
    table: string,
  ): Promise<{ columns: Record<string, any>[]; indexes: Record<string, any>[] }> {
    if (!this.current) throw new Error("No database selected");

    const cached = getCachedTableSchema(this.current.connectionId, this.current.database, table);
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

    return manager.getTableSchema(this.current.connectionId, this.current.database, table);
  }

  // ── Schema cache ──────────────────────────────────────────────

  autoLoadSchema(): SchemaSnapshot | null {
    if (!this.current) return null;
    return loadSchemaCache(this.current.connectionId, this.current.database);
  }

  async refreshSchema(manager: DatabaseConnectionManager): Promise<SchemaSnapshot> {
    if (!this.current) throw new Error("No database selected");
    return refreshSchemaCache(manager, this.current.connectionId, this.current.database);
  }
}
