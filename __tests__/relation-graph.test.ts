import { describe, it, expect } from "vitest";
import { RelationGraph } from "../relation-graph";
import type { ColumnRef } from "../types";

describe("RelationGraph", () => {
  it("registers and retrieves relations bidirectionally", () => {
    const graph = new RelationGraph();

    const src: ColumnRef = { schema: "db1", table: "t_order", column: "user_id" };
    const tgt: ColumnRef = { schema: "db2", table: "t_user", column: "id" };

    graph.register(src, tgt, "MANY_TO_ONE");

    // Forward direction
    const forward = graph.getDirectRelations("db1", "t_order");
    expect(forward.size).toBe(1);

    // Reverse direction (bidirectional)
    const reverse = graph.getDirectRelations("db2", "t_user");
    expect(reverse.size).toBe(1);
  });

  it("removes relations", () => {
    const graph = new RelationGraph();

    const src: ColumnRef = { schema: "db1", table: "t_order", column: "user_id" };
    const tgt: ColumnRef = { schema: "db2", table: "t_user", column: "id" };

    graph.register(src, tgt, "MANY_TO_ONE");
    const removed = graph.remove(src, tgt);
    expect(removed).toBe(true);

    const forward = graph.getDirectRelations("db1", "t_order");
    expect(forward.size).toBe(0);
  });

  it("deduplicates when registering same relation twice", () => {
    const graph = new RelationGraph();
    const src: ColumnRef = { schema: "a", table: "t1", column: "c1" };
    const tgt: ColumnRef = { schema: "a", table: "t2", column: "c2" };

    graph.register(src, tgt, "ONE_TO_ONE");
    graph.register(src, tgt, "ONE_TO_ONE");

    const relations = graph.getDirectRelations("a", "t1");
    expect(relations.get(src)?.length).toBe(1);
  });

  it("filters list by schema and table", () => {
    const graph = new RelationGraph();
    graph.register(
      { schema: "a", table: "t1", column: "c1" },
      { schema: "a", table: "t2", column: "c2" },
      "ONE_TO_ONE"
    );
    graph.register(
      { schema: "b", table: "t3", column: "c3" },
      { schema: "b", table: "t4", column: "c4" },
      "ONE_TO_ONE"
    );

    expect(graph.list("a").length).toBe(1);
    expect(graph.list("a", "t1").length).toBe(1);
    expect(graph.list("b", "t1").length).toBe(0);
  });
});
