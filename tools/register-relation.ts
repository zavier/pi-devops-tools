import { Type } from "@sinclair/typebox";
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { RelationGraph } from "../relation-graph";

export function createRegisterRelationTool(graph: RelationGraph) {
  return defineTool({
    name: "register_relation",
    label: "Register Table Relation",
    description:
      "Register a relationship between two table columns. " +
      "After registration, query_database with autoJoin=true will automatically " +
      "follow this relationship. Use this when your databases lack foreign keys.",
    parameters: Type.Object({
      schema: Type.String({ description: "Source database/schema name" }),
      table: Type.String({ description: "Source table name" }),
      column: Type.String({ description: "Source column name" }),
      refSchema: Type.String({ description: "Target database/schema name" }),
      refTable: Type.String({ description: "Target table name" }),
      refColumn: Type.String({ description: "Target column name" }),
      condition: Type.Optional(Type.String({
        description: "Optional WHERE condition for this relation (e.g., 'type=1')",
        default: "",
      })),
      relationType: Type.Optional(Type.String({
        description: "Relation type: ONE_TO_ONE, MANY_TO_ONE, ONE_TO_MANY, MANY_TO_MANY",
        default: "MANY_TO_ONE",
      })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        schema: string; table: string; column: string;
        refSchema: string; refTable: string; refColumn: string;
        condition?: string; relationType?: string;
      },
      _signal?: AbortSignal,
      _onUpdate?: any,
      _ctx?: any,
    ) {
      try {
        graph.register(
          {
            schema: params.schema,
            table: params.table,
            column: params.column,
            condition: params.condition || undefined,
          },
          {
            schema: params.refSchema,
            table: params.refTable,
            column: params.refColumn,
          },
          params.relationType ?? "MANY_TO_ONE"
        );

        graph.exportToJson();

        const id = `${params.schema}.${params.table}.${params.column} -> ${params.refSchema}.${params.refTable}.${params.refColumn}`;

        return {
          content: [{
            type: "text" as const,
            text: [
              "Relation registered successfully.",
              `  ${id}`,
              params.condition ? `  Condition: ${params.condition}` : "",
              `  Type: ${params.relationType ?? "MANY_TO_ONE"}`,
            ].filter(l => l !== "").join("\n"),
          }],
          details: { ok: true, id, relation: params },
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
