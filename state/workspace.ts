/**
 * DatabaseWorkspaceService — thin facade composing the independent modules.
 *
 * Delegates to:
 * - WorkspaceContext — state, switching, schema cache, table access
 * - DatabaseConnectionManager — connection pools
 * - QueryHistoryStore + FavoriteStore — persistence
 * - QueryRunner — query execution + history recording
 * - RelationGraph — table relationships
 */

import { loadConnectionsConfig } from "../connection/db-config";
import { DatabaseConnectionManager } from "../connection/db-manager";
import { QueryHistoryStore, FavoriteStore, type HistoryEntry, type FavoriteEntry } from "../history/store";
import { RelationGraph } from "../relation-graph";
import type { RelationRow } from "../relation/store";
import type { RelatedResult } from "../types";
import type { SchemaSnapshot } from "../schema/cache";
import { WorkspaceContext } from "./context";
import { QueryRunner } from "./query-runner";

export class DatabaseWorkspaceService {
  readonly connections = loadConnectionsConfig();
  readonly manager = new DatabaseConnectionManager(this.connections);
  readonly history = new QueryHistoryStore();
  readonly favorites = new FavoriteStore(this.history.getDb());
  readonly relationGraph = new RelationGraph(this.history.getDb());

  private ctx = new WorkspaceContext();
  private runner = new QueryRunner(this.manager, this.history, this.relationGraph);

  // ── Proxy: WorkspaceContext ───────────────────────────────────

  get current() { return this.ctx.current; }
  isReady() { return this.ctx.isReady(); }
  isConfigured() { return this.ctx.isConfigured(); }
  get configPath() { return this.ctx.configPath; }
  get statusLabel() { return this.ctx.statusLabel; }
  getEnvironments() { return this.ctx.getEnvironments(); }
  getConnectionIdsForEnv(env: string) { return this.ctx.getConnectionIdsForEnv(env); }
  getCurrentConnection() { return this.ctx.getCurrentConnection(); }

  switchTo(environment: string, connectionId: string, database: string) {
    this.ctx.switchTo(environment, connectionId, database);
  }

  async getDatabases(connectionId: string) {
    return this.ctx.getDatabases(this.manager, connectionId);
  }

  async getTables() { return this.ctx.getTables(this.manager); }

  async getTableSchema(table: string) {
    return this.ctx.getTableSchema(this.manager, table);
  }

  autoLoadSchema() { return this.ctx.autoLoadSchema(); }

  async refreshSchema() {
    return this.ctx.refreshSchema(this.manager);
  }

  // ── Proxy: QueryRunner ────────────────────────────────────────

  get lastSql() { return this.runner.lastSql; }

  async executeQuery(sql: string) {
    if (!this.ctx.current) throw new Error("No database selected");
    return this.runner.executeQuery(
      this.ctx.current.connectionId,
      this.ctx.current.database,
      sql,
    );
  }

  async executeQueryWithRelations(
    sql: string,
    table: string,
    autoJoin: boolean,
    maxDepth = 2,
    limit = 100,
    relatedLimit = 10,
  ) {
    if (!this.ctx.current) throw new Error("No database selected");
    return this.runner.executeQueryWithRelations(
      this.ctx.current.connectionId,
      this.ctx.current.database,
      sql,
      table,
      autoJoin,
      maxDepth,
      limit,
      relatedLimit,
    );
  }

  saveHistory(sql: string, rowCount: number, elapsed: string): HistoryEntry {
    if (!this.ctx.current) throw new Error("No database selected");
    return this.runner.saveHistory(
      this.ctx.current.connectionId,
      this.ctx.current.environment,
      this.ctx.current.database,
      sql,
      rowCount,
      elapsed,
    );
  }

  // ── Proxy: Favorites ──────────────────────────────────────────

  saveFavorite(name: string, sql: string, description?: string): FavoriteEntry {
    return this.favorites.save({
      name,
      sql,
      database: this.ctx.current?.database ?? "",
      description: description ?? "",
    });
  }

  getFavorites(keyword?: string): FavoriteEntry[] {
    return this.favorites.list({
      database: this.ctx.current?.database,
      keyword,
    });
  }

  // ── Proxy: Relations ──────────────────────────────────────────

  getRelations(table?: string): RelationRow[] {
    if (!this.ctx.current) return this.relationGraph.listAll();
    return this.relationGraph.list(this.ctx.current.database, table);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  destroy(): void {
    this.manager.destroy();
    this.history.close();
  }
}
