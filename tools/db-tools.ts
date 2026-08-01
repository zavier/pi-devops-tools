/**
 * 面向 LLM 的数据库工具。
 *
 * 一切执行都流经 DatabaseWorkspaceService → DatabaseConnectionManager
 * .executeQuery，因此只读守卫与 LIMIT 策略对 LLM 生效，
 * 与 /db query 完全一致。工具输出用 pi 的 truncateHead 截断
 * 以保护 LLM 上下文。
 *
 * 查询/schema 工具默认使用工作空间选择，但接受可选的
 * connection/database 覆盖。同一 MySQL 实例上的数据库可以直接
 * 用 `db.table` 限定名 JOIN——无需切换。
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

/** 由 db_query / db_tables 共享的可选目标覆盖参数。 */
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
   * 当未选择数据库且调用方未传显式目标时抛错（→ isError 工具结果），
   * 除非显式目标本身不需要工作空间选择即可工作。
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

  // ── Loader：按需启用懒加载工具 ────────────────────────────
  pi.registerTool({
    name: LOADER_TOOL_NAME,
    label: "DB Tools",
    description:
      "Search for and enable additional database tools that are not in the active set: " +
      "db_discover (connections and databases), db_list_relations (registered table " +
      "relationships), db_relation (register or delete relationships). Call this when a " +
      "task needs one of these capabilities — enabled tools become available from the " +
      "next turn. db_query, db_tables, and db_mutate are always active.",
    promptSnippet: "Enable additional database tools (discover, relations) when needed",
    promptGuidelines: [
      "Call db_tools to enable db_discover, db_list_relations, or db_relation when a task needs them — they are loaded on demand to keep the tool set small.",
      "db_query, db_tables, and db_mutate are always available.",
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
        // 仅加性——pi 会在此结果上记录新可用的工具，
        // 并在下一次请求时暴露给模型。
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
        /* 非致命 */
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
      "and database values are valid for the optional params of db_query and db_tables. " +
      "Never read the connections config file directly " +
      "(e.g. ~/.pi/database/connections.yaml) — it contains credentials; this tool returns " +
      "the same information redacted.",
    // 经 db_tools 懒加载——不带 promptSnippet/promptGuidelines，
    // 激活时不会重建 system prompt（见 Dynamic Tool Loading）。
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
    name: "db_tables",
    label: "DB Tables",
    description:
      "List tables in a database, or inspect one table's columns and indexes (live query). " +
      "Without `table`: returns the table list of the target database. With `table`: returns " +
      "the full schema — columns (name, type, nullable, key, comment) and indexes — formatted " +
      "as Markdown. Defaults to the currently selected database; pass connection/database to " +
      "target elsewhere.",
    promptSnippet: "List tables, or show a table's columns and indexes",
    promptGuidelines: [
      "List tables before guessing table names in db_query; pass table to check columns and types before writing SQL.",
    ],
    parameters: Type.Object({
      table: Type.Optional(Type.String({ description: "Table name. Omit to list tables." })),
      ...targetParams,
    }),
    async execute(_toolCallId, params) {
      const ws = ready(!!(params.connection && params.database));
      const target = ws.resolveTarget({
        connectionId: params.connection,
        database: params.database,
      });
      // 统一 details 形状——两种模式仅设置不同字段。
      const details: {
        connection: string;
        database: string;
        table?: string;
        tables?: string[];
      } = { connection: target.connectionId, database: target.database };
      if (params.table) {
        const { columns, indexes } = await ws.getTableSchema(params.table, target);
        details.table = params.table;
        return {
          content: [
            {
              type: "text",
              text: truncate(formatSchemaMarkdown(params.table, target.database, columns, indexes)),
            },
          ],
          details,
        };
      }
      const tables = await ws.getTables(target);
      details.tables = tables;
      return {
        content: [
          {
            type: "text",
            text: `Tables in ${target.connectionId}/${target.database} (${tables.length}):\n${tables.join("\n")}`,
          },
        ],
        details,
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
    // 经 db_tools 懒加载——不带 promptSnippet/promptGuidelines（见上）。
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
      // 1. 校验 SQL 是否为 DML 变更
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

      // 2. 解析目标
      const ws = ready(!!(params.connection && params.database));
      const target = ws.resolveTarget({
        connectionId: params.connection,
        database: params.database,
      });

      // 3. 显示确认对话框
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

      // 4. 执行
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
    // 经 db_tools 懒加载——不带 promptSnippet/promptGuidelines（见上）。
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
      const schema = params.database ?? ws.current!.database;

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

      // action 已用 StringEnum 约束为 register/delete，
      // 走到这里必是 delete。
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
    },
  });
}
