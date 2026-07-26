import { Type } from "@sinclair/typebox";
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { RelationGraph } from "../relation-graph";

export function createListRelationsTool(graph: RelationGraph) {
  return defineTool({
    name: "list_relations",
    label: "List Table Relations",
    description: "List all registered table relationships, optionally filtered by schema or table.",
    parameters: Type.Object({
      schema: Type.Optional(Type.String({ description: "Filter by database/schema name" })),
      table: Type.Optional(Type.String({ description: "Filter by table name" })),
    }),
    async execute(
      _toolCallId: string,
      params: { schema?: string; table?: string },
      _signal?: AbortSignal,
      _onUpdate?: any,
      _ctx?: any,
    ) {
      try {
        const relations = graph.list(params.schema, params.table);

        if (relations.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No relations registered. Use register_relation to add some.",
            }],
            details: { relations: [] },
          };
        }

        const lines = relations.map((r, i) =>
          `${i + 1}. ${r.schema}.${r.table_name}.${r.column_name} -> ${r.ref_schema}.${r.ref_table}.${r.ref_column} (${r.relation_type})${r.condition ? ` [${r.condition}]` : ""}`
        );

        return {
          content: [{
            type: "text" as const,
            text: `## Table Relations (${relations.length})\n\n${lines.join("\n")}`,
          }],
          details: { relations },
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
