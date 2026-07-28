/**
 * StateStore — owns the persistence directory, SQLite handle, and derived paths.
 *
 * One production adapter (default base dir ~/.pi/database).
 * One test adapter (temp dir) — two adapters, real seam.
 */

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";

const DEFAULT_BASE = join(homedir(), ".pi", "database");

export class StateStore {
  readonly baseDir: string;
  readonly sqlite: Database.Database;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_BASE;
    mkdirSync(this.baseDir, { recursive: true });

    const dbPath = join(this.baseDir, "state.db");

    // Migrate from the old filename (history.db) if it exists.
    const oldPath = join(this.baseDir, "history.db");
    if (!existsSync(dbPath) && existsSync(oldPath)) {
      renameSync(oldPath, dbPath);
    }

    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
  }

  get schemaDir(): string {
    return join(this.baseDir, "schema");
  }

  get connectionsFile(): string {
    return join(this.baseDir, "connections.yaml");
  }

  get workspaceFile(): string {
    return join(this.baseDir, "workspace.json");
  }

  close(): void {
    this.sqlite.close();
  }
}
