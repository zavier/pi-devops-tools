/**
 * QueryRunner — execute SQL queries, save history, track lastSql.
 *
 * Owns:
 * - query execution (with optional BFS relation following)
 * - history recording
 * - lastSql tracking (for /db favorite add prefill)
 */

import type { DatabaseConnectionManager } from "../connection/db-manager";
import type { QueryHistoryStore, HistoryEntry } from "../history/store";
import type { RelationGraph } from "../relation-graph";
import type { RelatedResult, ColumnRelation } from "../types";

export class QueryRunner {
  lastSql: string | null = null;

  constructor(
    private manager: DatabaseConnectionManager,
    private history: QueryHistoryStore,
    private relationGraph: RelationGraph,
  ) {}

  /**
   * Execute a read-only SQL query against the current workspace context.
   */
  async executeQuery(
    connectionId: string,
    database: string,
    sql: string,
  ): Promise<{ columns: string[]; rows: Record<string, any>[]; elapsed: string; sql: string }> {
    return this.manager.executeQuery(connectionId, database, sql);
  }

  /**
   * Execute a query and optionally follow relations via BFS.
   */
  async executeQueryWithRelations(
    connectionId: string,
    database: string,
    sql: string,
    table: string,
    autoJoin: boolean,
    maxDepth = 2,
    relatedLimit = 10,
  ): Promise<{
    columns: string[];
    rows: Record<string, any>[];
    elapsed: string;
    sql: string;
    related: RelatedResult[];
  }> {
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

  /**
   * Save a query execution to history and track lastSql for favoriting.
   */
  saveHistory(
    connectionId: string,
    environment: string,
    database: string,
    sql: string,
    rowCount: number,
    elapsed: string,
  ): HistoryEntry {
    this.lastSql = sql;
    return this.history.save({
      connectionId,
      environment,
      database,
      sql,
      rowCount,
      elapsed,
    });
  }
}
