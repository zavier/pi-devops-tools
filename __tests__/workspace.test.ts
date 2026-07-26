import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadWorkspace, saveWorkspace, type WorkspaceState } from "../state/workspace";

const STATE_DIR = join(homedir(), ".pi", "database");
const STATE_FILE = join(STATE_DIR, "workspace.json");

// Backup existing workspace state
function backupState(): string | null {
  if (existsSync(STATE_FILE)) {
    return readFileSync(STATE_FILE, "utf-8");
  }
  return null;
}

function restoreState(content: string | null): void {
  if (content === null) {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  } else {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, content);
  }
}

describe("workspace state persistence", () => {
  let backup: string | null;

  beforeEach(() => { backup = backupState(); });
  afterEach(() => { restoreState(backup); });

  it("returns null when no state file exists", () => {
    // Clean up any existing state
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    expect(loadWorkspace()).toBeNull();
  });

  it("saves and loads workspace state", () => {
    const state: WorkspaceState = {
      environment: "dev",
      connectionId: "mysql-dev-01",
      database: "order_db",
    };

    saveWorkspace(state);
    expect(existsSync(STATE_FILE)).toBe(true);

    const loaded = loadWorkspace();
    expect(loaded).toEqual(state);
  });

  it("returns null for malformed state file", () => {
    writeFileSync(STATE_FILE, "not json {");
    expect(loadWorkspace()).toBeNull();
  });

  it("returns null for state file with missing fields", () => {
    writeFileSync(STATE_FILE, JSON.stringify({ environment: "dev" }));
    expect(loadWorkspace()).toBeNull();
  });
});
