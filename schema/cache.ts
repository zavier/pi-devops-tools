/**
 * Schema Cache — persist table metadata to avoid repeated DB roundtrips.
 *
 * Cache files: ~/.pi/database/schema/<connectionId>/<database>.json
 *
 * Each file stores the full schema snapshot: tables, columns, indexes.
 * The cache is refreshed via /db refresh-schema or auto-loaded on switch.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseConnectionManager } from "../connection/db-manager";

// ====== Path helper ======

const DEFAULT_BASE = join(homedir(), ".pi", "database");

function cachePath(connectionId: string, database: string, baseDir?: string): string {
  return join(baseDir ?? DEFAULT_BASE, "schema", connectionId, `${database}.json`);
}

// ====== Types ======

export interface CachedColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: string; // "PRI", "MUL", "UNI", ""
  default: string | null;
  extra: string;
  comment: string;
}

export interface CachedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface CachedTable {
  name: string;
  columns: CachedColumn[];
  indexes: CachedIndex[];
}

export interface SchemaSnapshot {
  database: string;
  tables: CachedTable[];
  refreshedAt: string; // ISO-8601
}

// ====== Cache operations ======

/** Load a cached schema snapshot. Returns null if not cached. */
export function loadSchemaCache(
  connectionId: string,
  database: string,
  baseDir?: string,
): SchemaSnapshot | null {
  try {
    const path = cachePath(connectionId, database, baseDir);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);

    // Basic validation
    if (!data.database || !Array.isArray(data.tables)) return null;

    return data as SchemaSnapshot;
  } catch {
    return null;
  }
}

/** Save a schema snapshot to the cache. */
export function saveSchemaCache(
  snapshot: SchemaSnapshot,
  connectionId: string,
  baseDir?: string,
): void {
  const path = cachePath(connectionId, snapshot.database, baseDir);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

/** Get cached table list (fast, no DB query). Returns null if not cached. */
export function getCachedTables(
  connectionId: string,
  database: string,
  baseDir?: string,
): string[] | null {
  const cache = loadSchemaCache(connectionId, database, baseDir);
  if (!cache) return null;
  return cache.tables.map((t) => t.name);
}

/** Get a cached table's schema. Returns null if not found. */
export function getCachedTableSchema(
  connectionId: string,
  database: string,
  table: string,
  baseDir?: string,
): CachedTable | null {
  const cache = loadSchemaCache(connectionId, database, baseDir);
  if (!cache) return null;
  return cache.tables.find((t) => t.name === table) ?? null;
}

/**
 * Refresh schema cache by querying the database.
 * Returns the fresh snapshot (also persisted to disk).
 */
export async function refreshSchemaCache(
  manager: DatabaseConnectionManager,
  connectionId: string,
  database: string,
  baseDir?: string,
): Promise<SchemaSnapshot> {
  const tables = await manager.getTables(connectionId, database);

  const cachedTables: CachedTable[] = [];

  // Process tables in parallel batches to avoid overwhelming the connection pool.
  const BATCH_SIZE = 5;
  for (let i = 0; i < tables.length; i += BATCH_SIZE) {
    const batch = tables.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((table) =>
        manager.getTableSchema(connectionId, database, table).then((r) => ({ table, ...r })),
      ),
    );

    for (const { table, columns: colRows, indexes: idxRows } of batchResults) {
      // Build column list
      const columns: CachedColumn[] = (colRows as Record<string, any>[]).map((c) => ({
        name: c.COLUMN_NAME as string,
        type: c.COLUMN_TYPE as string,
        nullable: c.IS_NULLABLE === "YES",
        key: c.COLUMN_KEY as string,
        default: c.COLUMN_DEFAULT ?? null,
        extra: (c.EXTRA ?? "") as string,
        comment: (c.COLUMN_COMMENT ?? "") as string,
      }));

      // Build index list (grouped by name)
      const idxMap = new Map<string, { columns: string[]; unique: boolean }>();
      for (const idx of idxRows as Record<string, any>[]) {
        const name = idx.INDEX_NAME as string;
        if (!idxMap.has(name)) {
          idxMap.set(name, {
            columns: [],
            unique: idx.NON_UNIQUE === 0,
          });
        }
        idxMap.get(name)!.columns.push(idx.COLUMN_NAME as string);
      }

      const indexes: CachedIndex[] = [...idxMap.entries()].map(([name, info]) => ({
        name,
        columns: info.columns,
        unique: info.unique,
      }));

      cachedTables.push({ name: table, columns, indexes });
    }
  }

  const snapshot: SchemaSnapshot = {
    database,
    tables: cachedTables,
    refreshedAt: new Date().toISOString(),
  };

  saveSchemaCache(snapshot, connectionId, baseDir);
  return snapshot;
}
