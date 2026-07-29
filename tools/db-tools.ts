/**
 * LLM-facing database tools.
 *
 * Everything flows through DatabaseWorkspaceService → DatabaseConnectionManager
 * .executeQuery, so the read-only guard and LIMIT policy apply to the LLM
 * exactly as they do to /db query. Tool output is truncated with pi's
 * truncateHead to protect the LLM context.
 *
 * Query/schema tools default to the workspace selection but accept optional
 * connection/database overrides. Databases on the same MySQL instance can be
 * joined directly with `db.table` qualified names — no switching needed.
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
import { formatTableCompact } from "../formatting/result-table";
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

/** Optional target override shared by db_query / db_list_tables / db_table_schema. */
const targetParams = {
  connection: Type.Optional(
    Type.String({
      description:
        "Connection ID to query (see db_list_databases). Defaults to the current connection.",
    }),
  ),
  database: Type.Optional(
    Type.String({
      description:
        "Database to query. Defaults to the current database (or the connection's " +
        "defaultDatabase when connection is set).",
    }),
  ),
};

export function registerDbTools(
  pi: ExtensionAPI,
  getWorkspace: () => DatabaseWorkspaceService,
): void {
  /**
   * Throws (→ isError tool result) when no database is selected and the caller
   * didn't pass an explicit target that works without a workspace selection.
   */
  const ready = (explicitTargetOk = false): DatabaseWorkspaceService => {
    const ws = getWorkspace();
    if (!ws.isReady && !explicitTargetOk) {
      throw new Error(
        "No database selected. Ask the user to run /db switch first, " +
          "or pass connection + database explicitly.",
      );
    }
    return ws;
  };

  pi.registerTool({
    name: "db_query",
    label: "DB Query",
    description:
      "Execute a read-only SQL query. Defaults to the currently selected connection + " +
      "database; pass connection/database to target another configured connection or " +
      "another database on the same instance. Databases on the same MySQL instance can " +
      "be joined directly with db.table qualified names. The read-only guard rejects " +
      "writes and a LIMIT is appended automatically to unbounded SELECTs. Output is " +
      "truncated to 50KB / 2000 lines.",
    promptSnippet: "Run a read-only SQL query against the database selected via /db switch",
    promptGuidelines: [
      "Use db_query to answer data questions directly instead of asking the user to run /db query.",
      "For questions spanning multiple databases on the same instance, write one query with db.table qualified names instead of switching databases.",
      "Use db_list_databases to discover valid connection IDs and database names before passing connection/database params.",
    ],
    parameters: Type.Object({
      sql: Type.String({ description: "Read-only SQL (SELECT / SHOW / DESCRIBE / EXPLAIN)" }),
      ...targetParams,
    }),
    async execute(_toolCallId, params) {
      const ws = ready(!!(params.connection && params.database));
      const result = await ws.executeQuery(params.sql, {
        connectionId: params.connection,
        database: params.database,
      });
      try {
        ws.saveHistory(result.sql, result.rows.length, result.elapsed, {
          connectionId: result.connectionId,
          database: result.database,
        });
      } catch {
        /* non-fatal */
      }
      const text = [
        `Connection: ${result.connectionId}`,
        `Database: ${result.database}`,
        `SQL: ${result.sql}`,
        `Rows: ${result.rows.length} (${result.elapsed})`,
        "",
        formatTableCompact({ columns: result.columns, rows: result.rows }),
      ].join("\n");
      return {
        content: [{ type: "text", text: truncate(text) }],
        details: {
          connection: result.connectionId,
          database: result.database,
          sql: result.sql,
          rowCount: result.rows.length,
          elapsed: result.elapsed,
        },
      };
    },
  });

  pi.registerTool({
    name: "db_list_databases",
    label: "DB List Databases",
    description:
      "List configured connections and the databases on a connection. Use this to " +
      "discover valid connection IDs and database names for the connection/database " +
      "params of db_query, db_list_tables, and db_table_schema.",
    promptSnippet: "List configured connections and databases",
    promptGuidelines: [
      "Use db_list_databases before passing a connection or database param to another db_* tool.",
    ],
    parameters: Type.Object({
      connection: Type.Optional(
        Type.String({ description: "Connection ID. Defaults to the current connection." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ws = ready(!!params.connection);
      const conns = ws.listConnections();
      const lines = [
        `Connections (${conns.length}):`,
        ...conns.map(
          (c) =>
            `- ${c.id} (env: ${c.environment}${c.defaultDatabase ? `, default: ${c.defaultDatabase}` : ""})`,
        ),
      ];

      const targetId = params.connection ?? ws.current?.connectionId;
      if (targetId) {
        const dbs = await ws.getDatabases(targetId);
        lines.push("", `Databases on ${targetId} (${dbs.length}):`, ...dbs);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { connections: conns.map((c) => c.id), connection: targetId },
      };
    },
  });

  pi.registerTool({
    name: "db_list_tables",
    label: "DB List Tables",
    description:
      "List tables in a database (live query). Defaults to the currently selected " +
      "database; pass connection/database to list tables elsewhere.",
    promptSnippet: "List tables in the selected database",
    promptGuidelines: ["Use db_list_tables before guessing table names in db_query."],
    parameters: Type.Object({ ...targetParams }),
    async execute(_toolCallId, params) {
      const ws = ready(!!(params.connection && params.database));
      const target = ws.resolveTarget({
        connectionId: params.connection,
        database: params.database,
      });
      const tables = await ws.getTables(target);
      return {
        content: [
          {
            type: "text",
            text: `Tables in ${target.connectionId}/${target.database} (${tables.length}):\n${tables.join("\n")}`,
          },
        ],
        details: { connection: target.connectionId, database: target.database, tables },
      };
    },
  });

  pi.registerTool({
    name: "db_table_schema",
    label: "DB Table Schema",
    description:
      "Show the columns and indexes of a table (live query). Defaults to the currently " +
      "selected database; pass connection/database to inspect a table elsewhere — e.g. " +
      "before writing a cross-database db.table join.",
    promptSnippet: "Show columns and indexes of a table",
    promptGuidelines: [
      "Use db_table_schema to check column names and types before writing SQL for db_query.",
    ],
    parameters: Type.Object({
      table: Type.String({ description: "Table name" }),
      ...targetParams,
    }),
    async execute(_toolCallId, params) {
      const ws = ready(!!(params.connection && params.database));
      const target = ws.resolveTarget({
        connectionId: params.connection,
        database: params.database,
      });
      const { columns, indexes } = await ws.getTableSchema(params.table, target);
      return {
        content: [
          {
            type: "text",
            text: truncate(formatSchemaMarkdown(params.table, target.database, columns, indexes)),
          },
        ],
        details: {
          connection: target.connectionId,
          database: target.database,
          table: params.table,
        },
      };
    },
  });

  pi.registerTool({
    name: "db_list_relations",
    label: "DB List Relations",
    description:
      "List registered table relationships (source column → referenced column) for a " +
      "database. Use these to write JOINs yourself in db_query, or to plan batched " +
      "queries when a JOIN is not possible (e.g. tables on different connections). " +
      "Defaults to the currently selected database.",
    promptSnippet: "List registered table relationships",
    promptGuidelines: [
      "Use db_list_relations before writing multi-table queries — registered relations tell you which columns join to which.",
      "Check db_list_relations before db_register_relation to avoid registering a duplicate.",
    ],
    parameters: Type.Object({
      table: Type.Optional(Type.String({ description: "Only relations involving this table" })),
      database: Type.Optional(
        Type.String({ description: "Database name. Defaults to the current database." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ws = ready(!!params.database);
      const rows = ws.listRelations(params.table, params.database);
      const lines = rows.map(
        (r) =>
          `#${r.id} ${r.table_name}.${r.column_name} → ${r.ref_table}.${r.ref_column}` +
          ` (${r.relation_type}${r.condition ? `, condition: ${r.condition}` : ""})`,
      );
      const scope = params.database ?? ws.current?.database ?? "all databases";
      return {
        content: [
          {
            type: "text",
            text:
              lines.length > 0
                ? `Relations in ${scope} (${lines.length}):\n${lines.join("\n")}`
                : `No relations registered for ${scope}.`,
          },
        ],
        details: { database: scope, relations: rows },
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
      database: Type.Optional(
        Type.String({
          description: "Database the relation belongs to. Defaults to the current database.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ws = ready(!!params.database);
      const row = ws.registerRelation(
        params.table,
        params.column,
        params.refTable,
        params.refColumn,
        {
          condition: params.condition,
          relationType: params.relationType ?? "MANY_TO_ONE",
          database: params.database,
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
