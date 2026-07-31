/**
 * Tool catalog for dynamic tool loading.
 *
 * Pure functions, no pi imports, no I/O — the loader tool in db-tools.ts uses
 * these to decide which lazily-loaded database tools to enable. Kept separate
 * so the keyword matching is testable with plain values.
 *
 * Active set:  db_query, db_list_tables, db_table_schema, db_mutate, db_tools
 * Lazy (on demand via the db_tools loader): db_discover, db_list_relations, db_relation
 */

export const LOADER_TOOL_NAME = "db_tools";

/** Tools registered but not active by default — enabled on demand by the loader. */
export const LAZY_TOOL_NAMES = ["db_discover", "db_list_relations", "db_relation"] as const;

/** One-line summaries for loader results and messages. */
export const LAZY_TOOL_INFO: Record<string, string> = {
  db_discover: "discover configured connections and databases on a connection",
  db_list_relations: "list registered table relationships",
  db_relation: "register or delete table relationships",
};

/** The minimal pi surface applyInitialToolSet needs — keeps this module pi-free. */
export interface ToolSetApi {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

/**
 * Narrow the active tool set to the always-on tools plus the loader.
 *
 * The lazy tools (db_discover, db_list_relations, db_relation) stay registered but
 * inactive; the db_tools loader enables them on demand. Tools owned by other
 * extensions are preserved. Call this from session_start so every session
 * (fresh or resumed) starts from the same minimal set — the active tool set is
 * in-memory only and is not restored from the session file.
 */
export function applyInitialToolSet(pi: ToolSetApi): void {
  const lazy = new Set<string>(LAZY_TOOL_NAMES);
  const keep = pi.getActiveTools().filter((name) => !lazy.has(name));
  pi.setActiveTools([...new Set([...keep, LOADER_TOOL_NAME])]);
}

/**
 * Keyword catalog per lazy tool. Single-word keywords match any token that
 * contains them (so "databases" hits "database"); multi-word keywords match
 * the lowercased query as a contiguous phrase.
 */
const TOOL_KEYWORDS: Record<string, string[]> = {
  db_discover: [
    "discover",
    "connection",
    "database",
    "orient",
    "explore",
    "available",
    "which database",
  ],
  db_list_relations: [
    "relation",
    "relationship",
    "join",
    "foreign key",
    "fk",
    "reference",
    "referenced",
  ],
  db_relation: [
    "register",
    "upsert",
    "relate",
    "relation",
    "relationship",
    "add relation",
    "delete relation",
    "remove relation",
  ],
};

/**
 * Match a loader query against the lazy-tool catalog.
 *
 * Returns matching tool names in catalog order (db_discover first). An empty
 * or undefined query matches everything — a fallback for when the caller is
 * unsure what it needs. Returns [] when nothing matches.
 */
export function matchDbTools(query: string | undefined): string[] {
  if (!query || !query.trim()) return [...LAZY_TOOL_NAMES];
  const lower = query.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return LAZY_TOOL_NAMES.filter((tool) =>
    TOOL_KEYWORDS[tool].some((keyword) => {
      if (keyword.includes(" ")) return lower.includes(keyword);
      return tokens.some((token) => token.includes(keyword));
    }),
  );
}
