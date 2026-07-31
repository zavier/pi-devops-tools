/**
 * StateStore —— 拥有持久化目录、SQLite 句柄和派生路径。
 *
 * 一个生产适配器（默认基目录 ~/.pi/database）。
 * 一个测试适配器（临时目录）——两个适配器，真实的接缝。
 */

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";

export const DEFAULT_BASE = join(homedir(), ".pi", "database");

export class StateStore {
  readonly baseDir: string;
  readonly sqlite: Database.Database;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_BASE;
    mkdirSync(this.baseDir, { recursive: true });

    const dbPath = join(this.baseDir, "state.db");

    // 若旧文件名（history.db）存在则迁移。
    const oldPath = join(this.baseDir, "history.db");
    if (!existsSync(dbPath) && existsSync(oldPath)) {
      renameSync(oldPath, dbPath);
    }

    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
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
