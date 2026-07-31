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
import { prepareMutationQuery } from "../connection/sql-policy";
import { showMutationConfirm } from "../commands/mutate-confirm";
import { LOADER_TOOL_NAME, LAZY_TOOL_INFO, matchDbTools } from "./db-tool-catalog";
export { applyInitialToolSet } from "./db-tool-catalog";

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
      description: "Connection ID to query (see db_discover). Defaults to the current connection.",
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

  // ── Loader: enables the lazily-loaded tools on demand ────────────
  pi.registerTool({
    name: LOADER_TOOL_NAME,
    label: "DB Tools",
    description:
      "Search for and enable additional database tools that are not in the active set: " +
      "db_discover (connections and databases), db_list_relations (registered table " +
      "relationships), db_relation (register or delete relationships). Call this when a " +
      "task needs one of these capabilities — enabled tools become available from the " +
      "next turn. db_query, db_list_tables, db_table_schema, and db_mutate are always active.",
    promptSnippet: "Enable additional database tools (discover, relations) when needed",
    promptGuidelines: [
      "Call db_tools to enable db_discover, db_list_relations, or db_relation when a task needs them — they are loaded on demand to keep the tool set small.",
      "db_query, db_list_tables, db_table_schema, and db_mutate are always available.",
      "After enabling db_discover, use it instead of reading the connections config file directly (it contains credentials).",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Capability to search for, e.g. "discover" or "relations". Empty matches all database tools.',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const matches = matchDbTools(params.query);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                'No matching database tools. Try: "discover" (connections/databases), ' +
                '"relations" (list/register table relationships).',
            },
          ],
          details: { matches: [] as string[], added: [] as string[] },
        };
      }

      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      if (added.length > 0) {
        // Additive only — pi records the newly available tools on this result
        // and exposes them to the model on the next request.
        pi.setActiveTools([...new Set([...active, ...added])]);
      }

      const lines = matches.map((name) => `- ${name}: ${LAZY_TOOL_INFO[name]}`);
      const header =
        added.length > 0
          ? `Enabled ${added.length} tool(s), available from the next turn:\n`
          : "Already active:\n";
      return {
        content: [{ type: "text", text: header + lines.join("\n") }],
        details: { matches, added },
      };
    },
  });

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
    name: "db_discover",
    label: "DB Discover",
    description:
      "Discover available connections and databases — the entry point for exploration. " +
      "Returns all configured connections (IDs, environments, default databases) plus " +
      "the databases on a given connection. Use this first to learn what connection " +
      "and database values are valid for the optional params of db_query, db_list_tables, " +
      "and db_table_schema. Never read the connections config file directly " +
      "(e.g. ~/.pi/database/connections.yaml) — it contains credentials; this tool returns " +
      "the same information redacted.",
    // Lazily loaded via db_tools — no promptSnippet/promptGuidelines so
    // activation does not rebuild the system prompt (see Dynamic Tool Loading).
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
    // Lazily loaded via db_tools — no promptSnippet/promptGuidelines (see above).
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
    name: "db_mutate",
    label: "DB Mutate",
    description:
      "Execute a data mutation (INSERT/UPDATE/DELETE/REPLACE). " +
      "⚠️ REQUIRES HUMAN CONFIRMATION — a dialog will appear for the user " +
      "to approve or reject the SQL before it executes. " +
      "DDL (CREATE/DROP/ALTER/TRUNCATE) is rejected outright. " +
      "Use this to insert, update, or delete rows — never use db_query for writes.",
    promptSnippet: "Modify data (INSERT/UPDATE/DELETE) with human approval gate",
    promptGuidelines: [
      "Always include a WHERE clause in UPDATE/DELETE unless the user explicitly wants to affect all rows.",
      "Explain what the mutation will do before calling db_mutate, so the user understands why the confirmation dialog appeared.",
    ],
    parameters: Type.Object({
      sql: Type.String({
        description: "DML SQL (INSERT/UPDATE/DELETE/REPLACE). DDL rejected.",
      }),
      ...targetParams,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // 1. Validate the SQL is a DML mutation
      let validation: ReturnType<typeof prepareMutationQuery>;
      try {
        validation = prepareMutationQuery(params.sql);
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `SQL rejected: ${err.message}` }],
          details: { error: err.message },
        };
      }

      // 2. Resolve target
      const ws = ready(!!(params.connection && params.database));
      const target = ws.resolveTarget({
        connectionId: params.connection,
        database: params.database,
      });

      // 3. Show confirmation dialog
      const confirmed = await showMutationConfirm(ctx, {
        sql: validation.sql,
        operation: validation.operation,
        warning: validation.warning,
        connectionId: target.connectionId,
        database: target.database,
      });

      if (!confirmed) {
        return {
          content: [
            {
              type: "text",
              text: `Mutation rejected by user: ${validation.sql}`,
            },
          ],
          details: { rejected: true, sql: validation.sql },
        };
      }

      // 4. Execute
      try {
        const result = await ws.executeMutation(validation.sql, {
          connectionId: params.connection,
          database: params.database,
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `✅ Mutation executed successfully.`,
                `Connection: ${result.connectionId}`,
                `Database: ${result.database}`,
                `SQL: ${result.sql}`,
                `Affected rows: ${result.affectedRows} (${result.elapsed})`,
              ].join("\n"),
            },
          ],
          details: {
            sql: result.sql,
            affectedRows: result.affectedRows,
            elapsed: result.elapsed,
            connection: result.connectionId,
            database: result.database,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Mutation failed: ${err.message}` }],
          details: { sql: validation.sql, error: err.message },
        };
      }
    },
  });

  pi.registerTool({
    name: "db_relation",
    label: "DB Relation",
    description:
      "Manage table relationships. " +
      "action='register': create or update a relationship (idempotent — safe to call " +
      "repeatedly on the same column pair). " +
      "action='delete': remove a relationship by exact column match. " +
      "Use db_list_relations first to see what already exists.",
    // Lazily loaded via db_tools — no promptSnippet/promptGuidelines (see above).
    parameters: Type.Object({
      action: StringEnum(["register", "delete"] as const, {
        description: "register: create or update a relationship. delete: remove a relationship.",
      }),
      table: Type.String({ description: "Source table name" }),
      column: Type.String({ description: "Source column name" }),
      refTable: Type.String({ description: "Referenced table name" }),
      refColumn: Type.String({ description: "Referenced column name" }),
      relationType: Type.Optional(
        StringEnum(["MANY_TO_ONE", "ONE_TO_MANY", "ONE_TO_ONE", "MANY_TO_MANY"] as const, {
          description: "Relationship type (register only). Default: MANY_TO_ONE.",
        }),
      ),
      condition: Type.Optional(
        Type.String({
          description: "Extra join condition, e.g. type=1 (register only).",
        }),
      ),
      database: Type.Optional(
        Type.String({
          description: "Database name. Defaults to the current database.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      const ws = ready(!!params.database);
      const schema = params.database ?? ws.current?.database;
      if (!schema) {
        return {
          isError: true,
          content: [{ type: "text", text: "No database selected. Use /db switch first." }],
          details: { error: "No database selected" },
        };
      }

      if (params.action === "register") {
        const row = ws.upsertRelation(
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
              text:
                `Relation #${row.id}: ${params.table}.${params.column} → ` +
                `${params.refTable}.${params.refColumn} (${row.relation_type})`,
            },
          ],
          details: { relationId: row.id },
        };
      }

      if (params.action === "delete") {
        const deleted = ws.removeRelationByColumns(
          schema,
          params.table,
          params.column,
          params.refTable,
          params.refColumn,
        );
        return {
          content: [
            {
              type: "text",
              text: deleted
                ? `Deleted relation: ${params.table}.${params.column} → ${params.refTable}.${params.refColumn}`
                : `No matching relation found: ${params.table}.${params.column} → ${params.refTable}.${params.refColumn}`,
            },
          ],
          details: { deleted },
        };
      }

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Unknown action "${(params as any).action}". Expected "register" or "delete".`,
          },
        ],
        details: { error: `Unknown action: ${(params as any).action}` },
      };
    },
  });
}
