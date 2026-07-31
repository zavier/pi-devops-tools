#!/usr/bin/env node
/**
 * Database workspace status for the db-explore skill.
 *
 * Read-only overview of the pi-devops-tools workspace state:
 *   node status.mjs                 → current selection + metadata + connections (redacted)
 *   node status.mjs relations       → all registered table relationships
 *   node status.mjs relations <t>   → relationships involving table <t>
 *
 * Uses better-sqlite3 and js-yaml — runtime dependencies of the extension
 * package. Run from inside the extension so node resolves them from the
 * package's node_modules (or a hoisted parent).
 *
 * Passwords are never printed; ${ENV_VAR} placeholders are resolved for
 * display only.
 */

import Database from "better-sqlite3";
import { load as parseYaml } from "js-yaml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_DIR = join(homedir(), ".pi", "database");
const WORKSPACE_FILE = join(DB_DIR, "workspace.json");
const STATE_DB = join(DB_DIR, "state.db");
const CONFIG_FILE = join(DB_DIR, "connections.yaml");

const resolveEnv = (value) => value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");

function readWorkspace() {
  if (!existsSync(WORKSPACE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(WORKSPACE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function printStatus() {
  console.log("=== pi-devops-tools Workspace Status ===");
  console.log("");

  const ws = readWorkspace();
  if (ws) {
    console.log("Current selection:");
    console.log(`  Environment:  ${ws.environment ?? "?"}`);
    console.log(`  Connection:   ${ws.connectionId ?? "?"}`);
    console.log(`  Database:     ${ws.database ?? "?"}`);
  } else {
    console.log("  No workspace selection (run /db switch first)");
  }
  console.log("");

  if (existsSync(STATE_DB)) {
    console.log("Metadata:");
    const db = new Database(STATE_DB, { readonly: true });
    try {
      // Per-table guard: tolerate schema drift (tables created lazily by the
      // extension's stores; missing ones count as 0).
      const count = (table) => {
        try {
          return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        } catch {
          return 0;
        }
      };
      console.log(`  Relations:    ${count("table_relations")} registered`);
      console.log(`  Query history: ${count("query_history")} entries`);
      console.log(`  Favorites:    ${count("query_favorites")} saved`);
    } finally {
      db.close();
    }
  } else {
    console.log(`  No metadata DB found at ${STATE_DB}`);
  }
  console.log("");

  console.log(`Config file: ${CONFIG_FILE}`);
  if (existsSync(CONFIG_FILE)) {
    try {
      const config = parseYaml(readFileSync(CONFIG_FILE, "utf8"));
      const connections = config?.connections ?? {};
      const ids = Object.keys(connections);
      if (ids.length === 0) {
        console.log("  (empty)");
      } else {
        console.log("  Connections configured:");
        for (const id of ids) {
          const cfg = connections[id] ?? {};
          const env = resolveEnv(cfg.environment ?? "?");
          const host = resolveEnv(cfg.host ?? "?");
          const defDb = cfg.defaultDatabase ? ` (default: ${resolveEnv(cfg.defaultDatabase)})` : "";
          console.log(`    ${id} → ${env} @ ${host}${defDb}`);
        }
      }
    } catch (err) {
      console.log(`  (error reading config: ${err.message})`);
    }
  } else {
    console.log(`  No connections.yaml found at ${CONFIG_FILE}`);
  }
}

function printRelations(tableFilter) {
  if (!existsSync(STATE_DB)) {
    console.log(`No metadata DB found at ${STATE_DB}`);
    process.exit(1);
  }
  const db = new Database(STATE_DB, { readonly: true });
  try {
    const params = tableFilter ? [tableFilter, tableFilter] : [];
    const where = tableFilter ? " WHERE table_name = ? OR ref_table = ?" : "";
    const rows = db
      .prepare(
        `SELECT id, schema, table_name, column_name, condition, ` +
          `ref_schema, ref_table, ref_column, relation_type FROM table_relations` +
          `${where} ORDER BY id`,
      )
      .all(...params);
    if (rows.length === 0) {
      console.log(
        tableFilter
          ? `No relations registered for table ${tableFilter}.`
          : "No relations registered.",
      );
      return;
    }
    const scope = tableFilter ? `for ${tableFilter}` : "registered";
    console.log(`Relations ${scope} (${rows.length}):`);
    for (const r of rows) {
      const from = `${r.schema}.${r.table_name}.${r.column_name}`;
      const to = `${r.ref_schema}.${r.ref_table}.${r.ref_column}`;
      const cond = r.condition ? `, condition: ${r.condition}` : "";
      console.log(`#${r.id} ${from} → ${to} (${r.relation_type}${cond})`);
    }
  } finally {
    db.close();
  }
}

const mode = process.argv[2];
if (mode === "relations") {
  printRelations(process.argv[3]);
} else if (mode === undefined) {
  printStatus();
} else {
  console.error(`Unknown mode "${mode}". Expected: no args, or "relations [table]".`);
  process.exit(1);
}
