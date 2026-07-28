/**
 * LLM-facing database tools.
 *
 * Everything flows through DatabaseWorkspaceService → DatabaseConnectionManager
 * .executeQuery, so the read-only guard and LIMIT policy apply to the LLM
 * exactly as they do to /db query. Tool output is truncated with pi's
 * truncateHead to protect the LLM context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { formatTableResult } from "../formatting/result-table";
import { formatSchemaMarkdown } from "../formatting/schema-table";

function truncate(text: string): string {
  const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return t.content;
  return (
    t.content +
    `\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines` +
    ` (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Narrow the query or add a LIMIT.]`
  );
}

export function registerDbTools(
  pi: ExtensionAPI,
  getWorkspace: () => DatabaseWorkspaceService,
): void {
  /** Throws (→ isError tool result) when no database is selected. */
  const ready = (): DatabaseWorkspaceService => {
    const ws = getWorkspace();
    if (!ws.isReady) {
      throw new Error("No database selected. Ask the user to run /db switch first.");
    }
    return ws;
  };

  pi.registerTool({
    name: "db_query",
    label: "DB Query",
    description:
      "Execute a read-only SQL query against the currently selected database. " +
      "The read-only guard rejects writes and a LIMIT is appended automatically " +
      "to unbounded SELECTs. Output is truncated to 50KB / 2000 lines.",
    promptSnippet: "Run a read-only SQL query against the database selected via /db switch",
    promptGuidelines: [
      "Use db_query to answer data questions directly instead of asking the user to run /db query.",
    ],
    parameters: Type.Object({
      sql: Type.String({ description: "Read-only SQL (SELECT / SHOW / DESCRIBE / EXPLAIN)" }),
    }),
    async execute(_toolCallId, params) {
      const ws = ready();
      const result = await ws.executeQuery(params.sql);
      try {
        ws.saveHistory(result.sql, result.rows.length, result.elapsed);
      } catch {
        /* non-fatal */
      }
      const text = [
        `Database: ${ws.current!.database}`,
        `SQL: ${result.sql}`,
        `Rows: ${result.rows.length} (${result.elapsed})`,
        "",
        formatTableResult({ columns: result.columns, rows: result.rows }),
      ].join("\n");
      return {
        content: [{ type: "text", text: truncate(text) }],
        details: {
          database: ws.current!.database,
          sql: result.sql,
          rowCount: result.rows.length,
          elapsed: result.elapsed,
        },
      };
    },
  });

  pi.registerTool({
    name: "db_list_tables",
    label: "DB List Tables",
    description: "List all tables in the currently selected database (cache-first).",
    promptSnippet: "List tables in the selected database",
    promptGuidelines: ["Use db_list_tables before guessing table names in db_query."],
    parameters: Type.Object({}),
    async execute() {
      const ws = ready();
      const tables = await ws.getTables();
      return {
        content: [
          {
            type: "text",
            text: `Tables in ${ws.current!.database} (${tables.length}):\n${tables.join("\n")}`,
          },
        ],
        details: { database: ws.current!.database, tables },
      };
    },
  });

  pi.registerTool({
    name: "db_table_schema",
    label: "DB Table Schema",
    description:
      "Show the columns and indexes of a table in the currently selected database (cache-first).",
    promptSnippet: "Show columns and indexes of a table",
    promptGuidelines: [
      "Use db_table_schema to check column names and types before writing SQL for db_query.",
    ],
    parameters: Type.Object({
      table: Type.String({ description: "Table name" }),
    }),
    async execute(_toolCallId, params) {
      const ws = ready();
      const { columns, indexes } = await ws.getTableSchema(params.table);
      return {
        content: [
          {
            type: "text",
            text: truncate(
              formatSchemaMarkdown(params.table, ws.current!.database, columns, indexes),
            ),
          },
        ],
        details: { database: ws.current!.database, table: params.table },
      };
    },
  });

  pi.registerTool({
    name: "db_register_relation",
    label: "DB Register Relation",
    description:
      "Persist a discovered table relationship (source column → target column) " +
      "so future /db query auto-joins can follow it.",
    promptSnippet: "Save a discovered table relationship",
    promptGuidelines: [
      "Use db_register_relation to persist each relationship found when analyzing the schema, instead of only printing JSON.",
    ],
    parameters: Type.Object({
      table: Type.String({ description: "Source table" }),
      column: Type.String({ description: "Source column" }),
      refTable: Type.String({ description: "Referenced table" }),
      refColumn: Type.String({ description: "Referenced column" }),
      relationType: Type.Optional(
        StringEnum(["MANY_TO_ONE", "ONE_TO_MANY", "ONE_TO_ONE", "MANY_TO_MANY"] as const),
      ),
      condition: Type.Optional(
        Type.String({ description: "Optional extra join condition, e.g. type=1" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ws = ready();
      const row = ws.registerRelation(
        params.table,
        params.column,
        params.refTable,
        params.refColumn,
        {
          condition: params.condition,
          relationType: params.relationType ?? "MANY_TO_ONE",
        },
      );
      return {
        content: [
          {
            type: "text",
            text: `Registered relation #${row.id}: ${params.table}.${params.column} → ${params.refTable}.${params.refColumn} (${row.relation_type})`,
          },
        ],
        details: { relationId: row.id },
      };
    },
  });
}
