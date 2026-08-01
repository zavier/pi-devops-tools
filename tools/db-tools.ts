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
import type { QueryResultDoc } from "../formatting/result-document";
import { renderQueryDocument } from "../formatting/result-document";
import { formatSchemaMarkdown } from "../formatting/schema-table";
import { MutationValidationError } from "../connection/sql-policy";
import { showMutationConfirm } from "../commands/mutate-confirm";
import { LOADER_TOOL_NAME, LAZY_TOOL_INFO, matchDbTools } from "./db-tool-catalog";
export { applyInitialToolSet } from "./db-tool-catalog";

function truncate(text: string, hint = "查询范围过大，请缩小查询或添加 LIMIT。"): string {
  const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return t.content;
  return (
    t.content +
    `\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines` +
    ` (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). ${hint}]`
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
                '没有匹配的数据库工具。可尝试："discover"（连接/数据库）、' +
                '"relations"（列出/注册表关联）。',
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
          ? `已启用 ${added.length} 个工具，下一轮对话可用：\n`
          : "已处于活动状态：\n";
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
      const ws = getWorkspace();
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
      const doc: QueryResultDoc = {
        connectionId: result.connectionId,
        database: result.database,
        sql: result.sql,
        rowCount: result.rows.length,
        elapsed: result.elapsed,
        columns: result.columns,
        rows: result.rows,
      };
      const text = renderQueryDocument(doc, { audience: "llm-zh" })
        .map((l) => l.text)
        .join("\n");
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
      const ws = getWorkspace();
      const conns = ws.listConnections();
      const lines = [
        `连接（${conns.length} 个）：`,
        ...conns.map(
          (c) =>
            `- ${c.id}（环境：${c.environment}${c.defaultDatabase ? `，默认库：${c.defaultDatabase}` : ""}）`,
        ),
      ];

      const targetId = params.connection ?? ws.current?.connectionId;
      if (targetId) {
        const dbs = await ws.getDatabases(targetId);
        lines.push("", `${targetId} 上的数据库（${dbs.length} 个）：`, ...dbs);
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
      const ws = getWorkspace();
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
              text: truncate(
                formatSchemaMarkdown(params.table, target.database, columns, indexes),
                "表字段过多无法完整显示，可用 db_query 选择具体列。",
              ),
            },
          ],
          details,
        };
      }
      const tables = await ws.getTables(target);
      details.tables = tables;
      const tableList = `连接 ${target.connectionId}/${target.database} 中的表（${tables.length} 个）：\n${tables.join("\n")}`;
      return {
        content: [
          {
            type: "text",
            text: truncate(tableList, "表数量过多，可用 table= 参数查看具体表。"),
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
      const ws = getWorkspace();
      const rows = ws.listRelations(params.table, params.database);
      const lines = rows.map(
        (r) =>
          `#${r.id} ${r.table}.${r.column} → ${r.refTable}.${r.refColumn}` +
          `（${r.relationType}${r.condition ? `，条件：${r.condition}` : ""}）`,
      );
      const scope = params.database ?? ws.current?.database ?? "全部数据库";
      return {
        content: [
          {
            type: "text",
            text:
              lines.length > 0
                ? `${scope} 中的关联（${lines.length} 个）：\n${lines.join("\n")}`
                : `${scope} 中未注册关联。`,
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
      const ws = getWorkspace();
      try {
        const outcome = await ws.executeMutationWithApproval(
          params.sql,
          {
            connectionId: params.connection,
            database: params.database,
          },
          (req) => showMutationConfirm(ctx, req),
        );

        // 用户拒绝是正常结果——非 isError，回显被拒语句。
        if (outcome.status === "rejected") {
          return {
            content: [{ type: "text", text: `用户已拒绝变更：${outcome.sql}` }],
            details: { rejected: true, sql: outcome.sql },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `✅ 变更执行成功。`,
                `连接：${outcome.connectionId}`,
                `数据库：${outcome.database}`,
                `SQL：${outcome.sql}`,
                `影响行数：${outcome.affectedRows}（${outcome.elapsed}）`,
              ].join("\n"),
            },
          ],
          details: {
            sql: outcome.sql,
            affectedRows: outcome.affectedRows,
            elapsed: outcome.elapsed,
            connection: outcome.connectionId,
            database: outcome.database,
          },
        };
      } catch (err: any) {
        // 校验拒绝（DDL 等）与执行失败都从 facade 抛出，用错误类型区分措辞。
        const prefix = err instanceof MutationValidationError ? "SQL 被拒绝" : "变更失败";
        return {
          isError: true,
          content: [{ type: "text", text: `${prefix}: ${err.message}` }],
          details: { sql: params.sql, error: err.message },
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
      const ws = getWorkspace();
      const schema = params.database ?? ws.current?.database;
      if (!schema) {
        throw new Error("未选择数据库。请先执行 /db switch，或显式传入 connection + database。");
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
                `关联 #${row.id}：${params.table}.${params.column} → ` +
                `${params.refTable}.${params.refColumn}（${row.relationType}）`,
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
              ? `已删除关联：${params.table}.${params.column} → ${params.refTable}.${params.refColumn}`
              : `未找到匹配关联：${params.table}.${params.column} → ${params.refTable}.${params.refColumn}`,
          },
        ],
        details: { deleted },
      };
    },
  });
}
