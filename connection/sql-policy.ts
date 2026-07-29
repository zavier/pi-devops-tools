/**
 * SQL Policy — read-only guard and LIMIT injection for the workspace executor.
 *
 * Pure functions, no DB dependency. Single home of:
 * - READONLY_SQL_RE — which statements the workspace allows
 * - prepareReadOnlyQuery — validate + append LIMIT to unbounded SELECTs
 */

/** Statements the workspace allows. `\b` matters: rejects "SELECTOR" etc. */
export const READONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i;

/** DML statements allowed for the mutation tool. Rejects DDL (CREATE/DROP/ALTER/TRUNCATE). */
export const MUTATION_SQL_RE = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i;

const WHERE_RE = /\bWHERE\b/i;

export interface MutationValidation {
  sql: string;
  operation: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  hasWhere: boolean;
  warning?: string;
}

/** Default row cap applied to SELECT statements without a trailing LIMIT. */
export const DEFAULT_QUERY_LIMIT = 100;

// SELECT ... LIMIT 10  |  LIMIT 10;   (only at the very end of the statement)
const TRAILING_LIMIT_RE = /\bLIMIT\s+\d+\s*;?\s*$/i;

// LIMIT cannot follow FOR UPDATE — appending would be a syntax error.
const FOR_UPDATE_RE = /\bFOR\s+UPDATE\s*;?\s*$/i;

/**
 * Validate that `sql` is read-only and append `LIMIT n` to SELECT statements
 * that don't already end with one. Returns the final SQL to execute.
 *
 * SHOW / DESCRIBE / EXPLAIN pass through untouched (no uniform LIMIT syntax).
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
 * Validate that `sql` is a DML mutation (INSERT/UPDATE/DELETE/REPLACE).
 * Throws on DDL, SELECT, or any unrecognized statement.
 * Returns metadata for the confirmation UI: operation type, whether it has
 * a WHERE clause, and an optional warning for WHERE-less UPDATE/DELETE.
 */
export function prepareMutationQuery(sql: string): MutationValidation {
  const trimmed = sql.trim();
  if (!MUTATION_SQL_RE.test(trimmed)) {
    throw new Error(
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
