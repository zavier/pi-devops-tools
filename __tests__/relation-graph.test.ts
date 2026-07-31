import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { RelationGraph, type QueryFn } from "../relation-graph";
import type { ColumnRef } from "../types";

function createGraph(): RelationGraph {
  const db = new Database(":memory:");
  return new RelationGraph(db);
}

describe("RelationGraph", () => {
  it("registers and retrieves relations bidirectionally", () => {
    const graph = createGraph();

    const src: ColumnRef = { schema: "db1", table: "t_order", column: "user_id" };
    const tgt: ColumnRef = { schema: "db2", table: "t_user", column: "id" };

    graph.upsert(src, tgt, "MANY_TO_ONE");

    // 前向
    const forward = graph.getDirectRelations("db1", "t_order");
    expect(forward.size).toBe(1);

    // 反向（双向）
    const reverse = graph.getDirectRelations("db2", "t_user");
    expect(reverse.size).toBe(1);
  });

  it("removes relations by column match", () => {
    const graph = createGraph();

    const src: ColumnRef = { schema: "db1", table: "t_order", column: "user_id" };
    const tgt: ColumnRef = { schema: "db2", table: "t_user", column: "id" };

    graph.upsert(src, tgt, "MANY_TO_ONE");
    const removed = graph.remove(src, tgt);
    expect(removed).toBe(true);

    const forward = graph.getDirectRelations("db1", "t_order");
    expect(forward.size).toBe(0);
  });

  it("remove returns false for non-existent relation", () => {
    const graph = createGraph();
    const src: ColumnRef = { schema: "a", table: "t1", column: "c1" };
    const tgt: ColumnRef = { schema: "a", table: "t2", column: "c2" };

    const removed = graph.remove(src, tgt);
    expect(removed).toBe(false);
  });

  it("removeById deletes and returns true, or false if not found", () => {
    const graph = createGraph();
    const src: ColumnRef = { schema: "a", table: "t1", column: "c1" };
    const tgt: ColumnRef = { schema: "a", table: "t2", column: "c2" };

    const row = graph.upsert(src, tgt, "MANY_TO_ONE");

    expect(graph.removeById(row.id)).toBe(true);
    expect(graph.list("a").length).toBe(0);

    // 第二次删除是空操作
    expect(graph.removeById(row.id)).toBe(false);
  });

  it("upsert is idempotent — second call with same columns updates, not duplicates", () => {
    const graph = createGraph();
    const src: ColumnRef = { schema: "a", table: "t1", column: "c1" };
    const tgt: ColumnRef = { schema: "a", table: "t2", column: "c2" };

    graph.upsert(src, tgt, "ONE_TO_ONE");
    graph.upsert(src, tgt, "MANY_TO_ONE");

    // 只有一条关系，更新为 MANY_TO_ONE
    const relations = graph.list("a", "t1");
    expect(relations.length).toBe(1);
    expect(relations[0].relation_type).toBe("MANY_TO_ONE");
  });

  it("upsert with different conditions creates separate rows", () => {
    const graph = createGraph();
    const src: ColumnRef = { schema: "a", table: "t1", column: "c1", condition: "type=1" };
    const src2: ColumnRef = { schema: "a", table: "t1", column: "c1", condition: "type=2" };
    const tgt: ColumnRef = { schema: "a", table: "t2", column: "c2" };

    graph.upsert(src, tgt, "MANY_TO_ONE");
    graph.upsert(src2, tgt, "MANY_TO_ONE");

    // condition 是唯一键的一部分——两条独立的关系
    const relations = graph.list("a", "t1");
    expect(relations.length).toBe(2);
  });

  it("filters list by schema and table", () => {
    const graph = createGraph();
    graph.upsert(
      { schema: "a", table: "t1", column: "c1" },
      { schema: "a", table: "t2", column: "c2" },
      "ONE_TO_ONE",
    );
    graph.upsert(
      { schema: "b", table: "t3", column: "c3" },
      { schema: "b", table: "t4", column: "c4" },
      "ONE_TO_ONE",
    );

    expect(graph.list("a").length).toBe(1);
    expect(graph.list("a", "t1").length).toBe(1);
    expect(graph.list("b", "t1").length).toBe(0);
  });
});

// ====== bfsQuery（经 stub QueryFn）======

interface QueryCall {
  sql: string;
  params?: unknown[];
}

/** stub QueryFn：把 "schema.table" 前缀路由到固定行，并记录调用。 */
function stubQuery(routes: Record<string, Record<string, any>[]>) {
  const calls: QueryCall[] = [];
  const fn: QueryFn = async (sql, params) => {
    calls.push({ sql, params });
    const match = sql.match(/FROM `(\w+)`\.`(\w+)`/);
    const rows = match ? (routes[`${match[1]}.${match[2]}`] ?? []) : [];
    return { columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows, elapsed: "0.001s" };
  };
  return { fn, calls };
}

describe("RelationGraph.bfsQuery", () => {
  it("follows one hop with parameterized IN and schema-qualified tables", async () => {
    const graph = createGraph();
    graph.upsert(
      { schema: "db1", table: "t_order", column: "user_id" },
      { schema: "db1", table: "t_user", column: "id" },
    );

    // t_user 行故意没有 `id`——否则双向图
    // 会直接遍历回 t_order。
    const { fn, calls } = stubQuery({ "db1.t_user": [{ name: "ada" }] });
    const results = await graph.bfsQuery(fn, "db1", "t_order", [{ id: 1, user_id: 7 }], 2, 10);

    expect(results.length).toBe(1);
    expect(results[0].table).toBe("t_user");
    expect(results[0].rows).toEqual([{ name: "ada" }]);
    expect(results[0].joinPath).toBe("t_order.user_id -> t_user.id");
    expect(results[0].elapsed).toBe("0.001s");

    expect(calls.length).toBe(1);
    expect(calls[0].sql).toBe("SELECT * FROM `db1`.`t_user` WHERE `id` IN (?) LIMIT 10");
    expect(calls[0].params).toEqual([[7]]);
  });

  it("appends the relation condition when traversing towards the conditioned side", async () => {
    const graph = createGraph();
    // condition 在源列上；当 BFS 从被引用侧
    // 往回遍历到源侧时生效。
    graph.upsert(
      { schema: "db1", table: "t_order", column: "user_id", condition: "status=1" },
      { schema: "db1", table: "t_user", column: "id" },
    );

    const { fn, calls } = stubQuery({});
    await graph.bfsQuery(fn, "db1", "t_user", [{ id: 7 }], 2, 10);

    expect(calls[0].sql).toBe(
      "SELECT * FROM `db1`.`t_order` WHERE (`user_id` IN (?)) AND (status=1) LIMIT 10",
    );
    expect(calls[0].params).toEqual([[7]]);
  });

  it("skips relations whose column values are all null", async () => {
    const graph = createGraph();
    graph.upsert(
      { schema: "db1", table: "t_order", column: "user_id" },
      { schema: "db1", table: "t_user", column: "id" },
    );

    const { fn, calls } = stubQuery({});
    const results = await graph.bfsQuery(fn, "db1", "t_order", [{ id: 1, user_id: null }], 2, 10);

    expect(results.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("respects maxDepth", async () => {
    const graph = createGraph();
    graph.upsert(
      { schema: "db1", table: "a", column: "b_id" },
      { schema: "db1", table: "b", column: "id" },
    );
    graph.upsert(
      { schema: "db1", table: "b", column: "c_id" },
      { schema: "db1", table: "c", column: "id" },
    );

    // b 行故意没有 `id`，使回到 a 的双向边
    // 没有可跟随的值。
    const { fn } = stubQuery({
      "db1.b": [{ c_id: 2 }],
      "db1.c": [{ id: 2 }],
    });

    // maxDepth 1：只有第一跳
    const shallow = await graph.bfsQuery(fn, "db1", "a", [{ b_id: 1 }], 1, 10);
    expect(shallow.map((r) => r.table)).toEqual(["b"]);

    // maxDepth 2：到达 c
    const deep = await graph.bfsQuery(fn, "db1", "a", [{ b_id: 1 }], 2, 10);
    expect(deep.map((r) => r.table)).toEqual(["b", "c"]);
    expect(deep[1].joinPath).toBe("a.b_id -> b.id -> b.c_id -> c.id");
  });

  it("does not loop on cyclic relations", async () => {
    const graph = createGraph();
    // a.b_id -> b.id 且图是双向的，所以 b 也指回 a
    graph.upsert(
      { schema: "db1", table: "a", column: "b_id" },
      { schema: "db1", table: "b", column: "id" },
    );

    const { fn } = stubQuery({
      "db1.b": [{ id: 1 }],
      "db1.a": [{ b_id: 1 }],
    });

    const results = await graph.bfsQuery(fn, "db1", "a", [{ b_id: 1 }], 5, 10);
    const tables = results.map((r) => r.table);
    expect(tables.length).toBe(new Set(tables).size);
  });

  it("follows cross-schema relations with qualified names", async () => {
    const graph = createGraph();
    graph.upsert(
      { schema: "db1", table: "t_order", column: "user_id" },
      { schema: "db2", table: "t_user", column: "id" },
    );

    // t_user 行故意没有 `id`（见第一个 bfsQuery 测试）。
    const { fn, calls } = stubQuery({ "db2.t_user": [{ name: "ada" }] });
    const results = await graph.bfsQuery(fn, "db1", "t_order", [{ user_id: 7 }], 2, 10);

    expect(calls[0].sql).toContain("FROM `db2`.`t_user`");
    expect(results[0].schema).toBe("db2");
  });
});
