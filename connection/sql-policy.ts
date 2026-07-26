/**
 * SQL Policy — read-only guard and LIMIT injection for the workspace executor.
 *
 * Pure functions, no DB dependency. Single home of:
 * - READONLY_SQL_RE — which statements the workspace allows
 * - prepareReadOnlyQuery — validate + append LIMIT to unbounded SELECTs
 */

/** Statements the workspace allows. `\b` matters: rejects "SELECTOR" etc. */
export const READONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i;

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
