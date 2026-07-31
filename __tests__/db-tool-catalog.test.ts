import { describe, it, expect } from "vitest";
import {
  LOADER_TOOL_NAME,
  LAZY_TOOL_NAMES,
  LAZY_TOOL_INFO,
  matchDbTools,
  applyInitialToolSet,
  type ToolSetApi,
} from "../tools/db-tool-catalog";

function stub(active: string[]): { api: ToolSetApi; result: string[] } {
  const result: string[] = [...active];
  return {
    result,
    api: {
      getActiveTools: () => [...result],
      setActiveTools: (names) => {
        result.length = 0;
        result.push(...names);
      },
    },
  };
}

describe("db-tool-catalog", () => {
  it("exposes the loader and exactly the three lazy tools", () => {
    expect(LOADER_TOOL_NAME).toBe("db_tools");
    expect(LAZY_TOOL_NAMES).toEqual(["db_discover", "db_list_relations", "db_relation"]);
    const infoKeys = Object.keys(LAZY_TOOL_INFO);
    expect(infoKeys).toHaveLength(LAZY_TOOL_NAMES.length);
    for (const name of LAZY_TOOL_NAMES) expect(infoKeys).toContain(name);
  });

  describe("matchDbTools", () => {
    it("returns all lazy tools for an undefined or empty query", () => {
      expect(matchDbTools(undefined)).toEqual([...LAZY_TOOL_NAMES]);
      expect(matchDbTools("")).toEqual([...LAZY_TOOL_NAMES]);
      expect(matchDbTools("   ")).toEqual([...LAZY_TOOL_NAMES]);
    });

    it("matches discovery-related queries to db_discover", () => {
      expect(matchDbTools("discover databases")).toEqual(["db_discover"]);
      expect(matchDbTools("which connections are available")).toEqual(["db_discover"]);
      expect(matchDbTools("orient me, what databases exist")).toEqual(["db_discover"]);
    });

    it("matches join/reference queries to db_list_relations", () => {
      expect(matchDbTools("how do orders join users")).toEqual(["db_list_relations"]);
      expect(matchDbTools("show me the foreign keys")).toEqual(["db_list_relations"]);
      expect(matchDbTools("referenced columns")).toEqual(["db_list_relations"]);
    });

    it("matches relation queries to both relation tools (overlap is intended)", () => {
      expect(matchDbTools("show relations")).toEqual(["db_list_relations", "db_relation"]);
      expect(matchDbTools("register a relationship")).toEqual(["db_list_relations", "db_relation"]);
    });

    it("matches register/delete intent to db_relation", () => {
      expect(matchDbTools("register relation between users and orders")).toEqual([
        "db_list_relations",
        "db_relation",
      ]);
      expect(matchDbTools("upsert relation")).toEqual(["db_list_relations", "db_relation"]);
    });

    it("is case-insensitive", () => {
      expect(matchDbTools("DISCOVER Databases")).toEqual(["db_discover"]);
    });

    it("returns [] for unrelated queries", () => {
      expect(matchDbTools("check the weather")).toEqual([]);
      expect(matchDbTools("write a poem")).toEqual([]);
    });

    it("keeps catalog order regardless of query token order", () => {
      const result = matchDbTools("relations and connections");
      expect(result.indexOf("db_discover")).toBeLessThan(result.indexOf("db_list_relations"));
      expect(result.indexOf("db_list_relations")).toBeLessThan(result.indexOf("db_relation"));
    });
  });

  describe("applyInitialToolSet", () => {
    it("drops the lazy tools and keeps the loader", () => {
      const { api, result } = stub([
        "read",
        "bash",
        "db_query",
        "db_discover",
        "db_list_relations",
        "db_relation",
      ]);
      applyInitialToolSet(api);
      expect(result).toEqual(["read", "bash", "db_query", LOADER_TOOL_NAME]);
    });

    it("preserves tools owned by other extensions", () => {
      const { api, result } = stub(["read", "db_query", "other_ext_tool", "db_discover"]);
      applyInitialToolSet(api);
      expect(result).toEqual(["read", "db_query", "other_ext_tool", LOADER_TOOL_NAME]);
    });

    it("is idempotent", () => {
      const { api, result } = stub(["read", LOADER_TOOL_NAME]);
      applyInitialToolSet(api);
      expect(result).toEqual(["read", LOADER_TOOL_NAME]);
    });
  });
});
