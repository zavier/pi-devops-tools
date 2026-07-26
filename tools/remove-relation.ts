import { Type } from "@sinclair/typebox";
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { RelationGraph } from "../relation-graph";

export function createRemoveRelationTool(graph: RelationGraph) {
  return defineTool({
    name: "remove_relation",
    label: "Remove Table Relation",
    description: "Remove a previously registered table relationship.",
    parameters: Type.Object({
      schema: Type.String({ description: "Source database/schema name" }),
      table: Type.String({ description: "Source table name" }),
      column: Type.String({ description: "Source column name" }),
      refSchema: Type.String({ description: "Target database/schema name" }),
      refTable: Type.String({ description: "Target table name" }),
      refColumn: Type.String({ description: "Target column name" }),
    }),
    async execute(
      _toolCallId: string,
      params: {
        schema: string; table: string; column: string;
        refSchema: string; refTable: string; refColumn: string;
      },
      _signal?: AbortSignal,
      _onUpdate?: any,
      _ctx?: any,
    ) {
      try {
        const removed = graph.remove(
          { schema: params.schema, table: params.table, column: params.column },
          { schema: params.refSchema, table: params.refTable, column: params.refColumn }
        );

        if (!removed) {
          return {
            content: [{
              type: "text" as const,
              text: `Relation not found: ${params.schema}.${params.table}.${params.column} -> ${params.refSchema}.${params.refTable}.${params.refColumn}`,
            }],
            details: { ok: false },
          };
        }

        graph.exportToJson();

        return {
          content: [{
            type: "text" as const,
            text: `Relation removed: ${params.schema}.${params.table}.${params.column} -> ${params.refSchema}.${params.refTable}.${params.refColumn}`,
          }],
          details: { ok: true },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          details: undefined,
        };
      }
    },
  });
}
