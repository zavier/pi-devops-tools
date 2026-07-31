/**
 * 动态工具加载的工具目录。
 *
 * 纯函数，无 pi 导入、无 I/O——db-tools.ts 中的 loader 工具用这些来决定
 * 启用哪些懒加载数据库工具。单独放置以便关键词匹配可以用普通值测试。
 *
 * 常驻激活集：  db_query, db_tables, db_mutate, db_tools
 * 懒加载（经 db_tools loader 按需启用）：db_discover, db_list_relations, db_relation
 */

export const LOADER_TOOL_NAME = "db_tools";

/** 已注册但默认不激活的工具——由 loader 按需启用。 */
export const LAZY_TOOL_NAMES = ["db_discover", "db_list_relations", "db_relation"] as const;

/** loader 结果与消息中用的一行摘要。 */
export const LAZY_TOOL_INFO: Record<string, string> = {
  db_discover: "discover configured connections and databases on a connection",
  db_list_relations: "list registered table relationships",
  db_relation: "register or delete table relationships",
};

/** applyInitialToolSet 需要的最小 pi 接口——保持本模块无 pi 依赖。 */
export interface ToolSetApi {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

/**
 * 将激活工具集收窄为常驻工具 + loader。
 *
 * 懒工具（db_discover, db_list_relations, db_relation）保持注册但未激活；
 * db_tools loader 按需启用它们。其他扩展拥有的工具会被保留。
 * 在 session_start 调用，使每个会话（新建或恢复）都从相同的最小集合开始——
 * 激活工具集仅存内存，不会从会话文件恢复。
 */
export function applyInitialToolSet(pi: ToolSetApi): void {
  const lazy = new Set<string>(LAZY_TOOL_NAMES);
  const keep = pi.getActiveTools().filter((name) => !lazy.has(name));
  pi.setActiveTools([...new Set([...keep, LOADER_TOOL_NAME])]);
}

/**
 * 每个懒工具的关键词目录。单词关键词匹配任何包含它的 token
 * （如 "databases" 命中 "database"）；多词关键词匹配小写化查询中的连续短语。
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
 * 将 loader 查询与懒工具目录匹配。
 *
 * 按目录顺序返回匹配的工具名（db_discover 在前）。空或 undefined 查询匹配全部
 * ——当调用方不确定需要什么时的兜底。无匹配时返回 []。
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
