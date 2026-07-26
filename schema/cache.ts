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

// ====== Paths ======

const SCHEMA_DIR = join(homedir(), ".pi", "database", "schema");

function cachePath(connectionId: string, database: string): string {
  return join(SCHEMA_DIR, connectionId, `${database}.json`);
}

// ====== Types ======

export interface CachedColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: string;    // "PRI", "MUL", "UNI", ""
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
export function loadSchemaCache(connectionId: string, database: string): SchemaSnapshot | null {
  try {
    const path = cachePath(connectionId, database);
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
export function saveSchemaCache(snapshot: SchemaSnapshot, connectionId: string): void {
  const dir = join(SCHEMA_DIR, connectionId);
  mkdirSync(dir, { recursive: true });

  const path = cachePath(connectionId, snapshot.database);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

/** Get cached table list (fast, no DB query). Returns null if not cached. */
export function getCachedTables(connectionId: string, database: string): string[] | null {
  const cache = loadSchemaCache(connectionId, database);
  if (!cache) return null;
  return cache.tables.map((t) => t.name);
}

/** Get a cached table's schema. Returns null if not found. */
export function getCachedTableSchema(
  connectionId: string,
  database: string,
  table: string,
): CachedTable | null {
  const cache = loadSchemaCache(connectionId, database);
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
): Promise<SchemaSnapshot> {
  const tables = await manager.getTables(connectionId, database);

  const cachedTables: CachedTable[] = [];

  for (const table of tables) {
    const { columns: colRows, indexes: idxRows } = await manager.getTableSchema(
      connectionId,
      database,
      table,
    );

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

    const indexes: CachedIndex[] = [...idxMap.entries()].map(
      ([name, info]) => ({
        name,
        columns: info.columns,
        unique: info.unique,
      }),
    );

    cachedTables.push({ name: table, columns, indexes });
  }

  const snapshot: SchemaSnapshot = {
    database,
    tables: cachedTables,
    refreshedAt: new Date().toISOString(),
  };

  saveSchemaCache(snapshot, connectionId);
  return snapshot;
}
