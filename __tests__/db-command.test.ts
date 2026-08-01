import { describe, it, expect } from "vitest";
import { getCompletions } from "../commands/db";
import type { DatabaseWorkspaceService } from "../state/workspace";

/** 最小 ws stub: 只需要 getCompletions 用到的两个成员。 */
function stubWs(opts: { isReady?: boolean; tables?: string[] } = {}) {
  const { isReady = true, tables = [] } = opts;
  return {
    isReady,
    getTables: async () => tables,
  } as unknown as DatabaseWorkspaceService;
}

describe("getCompletions (/db 参数补全)", () => {
  it("expands second-level subcommands for 'relations'", async () => {
    const result = await getCompletions("relations", stubWs());
    expect(result?.map((c) => c.label).sort()).toEqual(["add", "discover", "remove"]);
    expect(result?.[0].value).toBe("relations add ");
  });

  it("expands 'favorite' to its only subcommand", async () => {
    const result = await getCompletions("favorite", stubWs());
    expect(result?.map((c) => c.label)).toEqual(["add"]);
  });

  it("handles trailing space after 'relations' (Tab-completed state)", async () => {
    const result = await getCompletions("relations ", stubWs());
    expect(result?.length).toBe(3);
  });

  it("filters sub-subcommands by partial input", async () => {
    const result = await getCompletions("relations a", stubWs());
    expect(result?.map((c) => c.label)).toEqual(["add"]);
  });

  it("returns null when the sub-subcommand prefix matches nothing", async () => {
    expect(await getCompletions("relations z", stubWs())).toBeNull();
    expect(await getCompletions("favorite x", stubWs())).toBeNull();
  });

  it("completes table names for 'schema' and 'query'", async () => {
    const ws = stubWs({ tables: ["t_orders", "t_customers", "t_products"] });
    const schemaResult = await getCompletions("schema t_", ws);
    expect(schemaResult?.map((c) => c.value).sort()).toEqual([
      "schema t_customers",
      "schema t_orders",
      "schema t_products",
    ]);

    const queryResult = await getCompletions("query t_products", ws);
    expect(queryResult?.map((c) => c.label)).toEqual(["t_products"]);
  });

  it("is case-insensitive for table filtering", async () => {
    const ws = stubWs({ tables: ["T_ORDERS", "t_customers"] });
    const result = await getCompletions("query t_", ws);
    expect(result?.map((c) => c.label).sort()).toEqual(["T_ORDERS", "t_customers"]);
  });

  it("falls back to subcommand prefix matching for partial first word", async () => {
    const result = await getCompletions("s", stubWs());
    expect(result?.map((c) => c.label)).toContain("schema");
    expect(result?.map((c) => c.value)).toContain("schema ");
  });

  it("returns null when getTables fails", async () => {
    const ws = {
      isReady: true,
      getTables: async () => {
        throw new Error("boom");
      },
    } as unknown as DatabaseWorkspaceService;
    expect(await getCompletions("schema", ws)).toBeNull();
  });

  it("skips table completion when workspace is not ready", async () => {
    const ws = stubWs({ isReady: false, tables: ["t_orders"] });
    // 未就绪时不查表, 退回子命令前缀匹配(无匹配则 null)
    const result = await getCompletions("schema", ws);
    expect(result).not.toContainEqual(expect.objectContaining({ label: "t_orders" }));
  });
});
