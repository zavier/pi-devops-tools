import { Type } from "@sinclair/typebox";
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { RowDataPacket } from "mysql2/promise";
import type { AppConfig, ColumnRelation } from "../types";
import type { ConnectionManager } from "../connections";
import type { RelationGraph } from "../relation-graph";

export function createSyncForeignKeysTool(
  config: AppConfig,
  connections: ConnectionManager,
  graph: RelationGraph
) {
  return defineTool({
    name: "sync_foreign_keys",
    label: "Sync Foreign Keys",
    description:
      "Query information_schema.KEY_COLUMN_USAGE to discover foreign key relationships " +
      "and register them automatically. Skips relations that already exist. " +
      "Useful for bootstrapping table relations from databases that still have foreign keys defined.",
    parameters: Type.Object({
      cluster: Type.String({ description: "Cluster name from config.json databases" }),
      database: Type.String({ description: "Database name to scan for foreign keys" }),
    }),
    async execute(
      _toolCallId: string,
      params: { cluster: string; database: string },
      _signal?: AbortSignal,
      _onUpdate?: any,
      _ctx?: any,
    ) {
      try {
        const pool = connections.getMySQLPool(params.cluster);

        const fkSql = `
          SELECT
            TABLE_SCHEMA,
            TABLE_NAME,
            COLUMN_NAME,
            REFERENCED_TABLE_SCHEMA,
            REFERENCED_TABLE_NAME,
            REFERENCED_COLUMN_NAME
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ?
            AND REFERENCED_COLUMN_NAME IS NOT NULL
        `;

        const [rows] = await pool.query<RowDataPacket[]>(fkSql, [params.database]);

        const fkRelations: ColumnRelation[] = rows.map(row => ({
          schema: row.TABLE_SCHEMA as string,
          table: row.TABLE_NAME as string,
          column: row.COLUMN_NAME as string,
          condition: "",
          refSchema: (row.REFERENCED_TABLE_SCHEMA ?? params.database) as string,
          refTable: row.REFERENCED_TABLE_NAME as string,
          refColumn: row.REFERENCED_COLUMN_NAME as string,
          relationType: "MANY_TO_ONE",
        }));

        const added = graph.mergeForeignKeys(fkRelations);
        const skipped = fkRelations.length - added;

        if (added > 0) {
          graph.saveToFile();
        }

        return {
          content: [{
            type: "text" as const,
            text: [
              `Foreign key sync complete for ${params.cluster}/${params.database}:`,
              `  Found: ${fkRelations.length} foreign keys`,
              `  Added: ${added}`,
              `  Skipped (already exist): ${skipped}`,
            ].join("\n"),
          }],
          details: { ok: true, added, skipped, total: fkRelations.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Sync error: ${err.message}` }],
          details: undefined,
        };
      }
    },
  });
}
