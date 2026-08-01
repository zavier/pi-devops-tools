/**
 * SQL 策略 —— 工作空间执行器的只读守卫与 LIMIT 注入。
 *
 * 纯函数，无数据库依赖。是以下内容的唯一归属：
 * - READONLY_SQL_RE —— 工作空间允许的语句
 * - prepareReadOnlyQuery —— 校验 + 给无界 SELECT 追加 LIMIT
 */

/** 工作空间允许的语句。`\b` 很关键：拒绝 "SELECTOR" 之类的词。 */
export const READONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i;

/** 变更工具允许的 DML 语句。拒绝 DDL（CREATE/DROP/ALTER/TRUNCATE）。 */
export const MUTATION_SQL_RE = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i;

const WHERE_RE = /\bWHERE\b/i;

export interface MutationValidation {
  sql: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  hasWhere: boolean;
  warning?: string;
}

/**
 * 变更校验失败（非 DML / DDL / 未识别语句）时抛出的错误类型。
 * 让调用方能区分「SQL 本身不合法」与「执行期失败」。
 */
export class MutationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationValidationError";
  }
}

/** 应用于无尾部 LIMIT 的 SELECT 语句的默认行数上限。 */
export const DEFAULT_QUERY_LIMIT = 100;

// SELECT ... LIMIT 10  |  LIMIT 10;   （仅语句最末尾）
const TRAILING_LIMIT_RE = /\bLIMIT\s+\d+\s*;?\s*$/i;

// LIMIT 不能跟在 FOR UPDATE 后面——追加会成为语法错误。
const FOR_UPDATE_RE = /\bFOR\s+UPDATE\s*;?\s*$/i;

/**
 * 校验 `sql` 是只读的，并给不以 LIMIT 结尾的 SELECT 语句追加 `LIMIT n`。
 * 返回最终要执行的 SQL。
 *
 * SHOW / DESCRIBE / EXPLAIN 原样通过（没有统一的 LIMIT 语法）。
 */
export function prepareReadOnlyQuery(sql: string, limit: number = DEFAULT_QUERY_LIMIT): string {
  const trimmed = sql.trim();
  if (!READONLY_SQL_RE.test(trimmed)) {
    throw new Error("仅允许只读 SQL（SELECT、SHOW、DESCRIBE、EXPLAIN）");
  }
  if (!/^SELECT\b/i.test(trimmed)) return trimmed;
  if (TRAILING_LIMIT_RE.test(trimmed)) return trimmed;
  if (FOR_UPDATE_RE.test(trimmed)) return trimmed;
  return `${trimmed.replace(/;+\s*$/, "")} LIMIT ${limit}`;
}

/**
 * 校验 `sql` 是 DML 变更（INSERT/UPDATE/DELETE/REPLACE）。
 * DDL、SELECT 或任何未识别语句时抛错。
 * 返回确认 UI 需要的元数据：操作类型、是否带 WHERE 子句、
 * 以及无 WHERE 的 UPDATE/DELETE 的可选警告。
 */
export function prepareMutationQuery(sql: string): MutationValidation {
  const trimmed = sql.trim();
  if (!MUTATION_SQL_RE.test(trimmed)) {
    throw new MutationValidationError(
      "仅允许 DML 写操作（INSERT、UPDATE、DELETE、REPLACE）。" +
        "DDL（CREATE、DROP、ALTER、TRUNCATE）被禁止。",
    );
  }

  const operation = trimmed.match(/^(\w+)/i)![1].toUpperCase() as MutationValidation["operation"];
  const hasWhere = WHERE_RE.test(trimmed);

  let warning: string | undefined;
  if ((operation === "UPDATE" || operation === "DELETE") && !hasWhere) {
    warning = `${operation} 没有 WHERE 子句 — 将影响表中所有行！`;
  }

  return { sql: trimmed, operation, hasWhere, warning };
}
