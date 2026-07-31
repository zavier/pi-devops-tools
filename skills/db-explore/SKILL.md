---
name: db-explore
description: >
  This skill should be used for any database interaction — both exploration
  ("explore a database", "show me the database structure", "what tables are
  here", "how is this database organized", "find relationships") and CRUD
  queries ("查一下", "查询", "找一下", "帮我查", "find records",
  "show me data from", "插入数据", "更新记录", "看一下表里的数据"). Provides a fast one-shot query
  path for known tables, plus a systematic six-phase workflow for exploring
  unfamiliar MySQL databases.
---

# Database Exploration

## Philosophy

**For exploration**: start broad, narrow by relevance, and build up a mental model incrementally. The goal is understanding, not enumeration.

**For fast queries**: trust the user's table/column names, query directly, and only verify on failure. The goal is speed, not completeness.

## Available Tools

All exploration uses the `db_*` tool family:

| Tool                | Purpose in exploration                                             | Phase                              |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `db_discover`       | List configured connections and discover databases on a connection | 1 — Orient                         |
| `db_list_tables`    | List all tables in the target database                             | 2 — Survey                         |
| `db_table_schema`   | Show columns, types, and indexes for a specific table              | 3 — Inspect                        |
| `db_query`          | Execute read-only SQL (SELECT, EXPLAIN)                            | Fast path, 4 — Sample, 5 — Connect |
| `db_mutate`         | Execute INSERT/UPDATE/DELETE/REPLACE (confirmation gated)          | Fast path                          |
| `db_list_relations` | List registered table relationships                                | 5 — Connect                        |
| `db_relation`       | Register new relationships (action="register")                     | 5 — Connect                        |

All read tools default to the workspace selection but accept optional `connection` and `database` overrides. `db_relation` accepts a `database` override.

## Core workflow

### Workflow at a glance

| Phase       | Tool calls | Typical time |
| ----------- | ---------- | ------------ |
| Fast path   | 1-3        | <5s          |
| 1 — Orient  | 1          | <2s          |
| 2 — Survey  | 1          | <2s          |
| 3 — Inspect | 3-5        | 5-10s        |
| 4 — Sample  | 3-5        | 5-10s        |
| 5 — Connect | 3-12       | 10-30s       |
| 6 — Report  | 0          | —            |

**Typical total: ~10-20 tool calls, 30-60 seconds.**

### Fast path — for CRUD queries

When the user asks a concrete data question with known table/column names, skip directly to querying:

1. **Orient** (if needed): if the target database isn't the current workspace selection, call `db_discover` once to confirm. Skip if the workspace is already set.
2. **Execute**:
   - Reads → `db_query` (LIMIT auto-appended, result truncated at 50KB / 2000 lines)
   - Writes → `db_mutate` (INSERT/UPDATE/DELETE/REPLACE; a confirmation dialog gates every execution)
3. **On failure**: if the query errors with "table not found" or "unknown column", call `db_table_schema` for the most likely table, find the correct name, then retry. If the table doesn't exist at all, fall back to Phase 2 (Survey).

**Examples** (no schema preamble needed):

- "查一下 users 表里 status 是 active 的用户" → `SELECT * FROM users WHERE status = 'active' LIMIT 100`
- "给 orders 表插一条测试数据" → `INSERT INTO orders (user_id, total) VALUES (1, 99.90)`
- "find all products with price > 100" → `SELECT * FROM products WHERE price > 100 LIMIT 100`

### Phase 1 — Orient

**Goal**: confirm the target connection and database.

1. Call `db_discover` without parameters to see current connection + available databases.
2. If the target isn't the current workspace selection, note the `connection` and `database` values for override params.

### Before proceeding — check the goal

After Phase 1, if the user has stated a specific goal, adjust the focus of subsequent phases:

- **Analytics/reporting**: in Phase 2, prioritize fact tables (high row count, many FK columns). Skip small lookup tables.
- **CRUD/application development**: prioritize entity tables and their direct FK dependencies. Sample with `SELECT * LIMIT 3` per table.
- **Migration/audit**: in Phase 2, flag deprecated-looking tables (`_old`, `_bak`, `_archive`). In Phase 3, note nullable columns that should be NOT NULL and missing indexes on FK columns.
- **Performance investigation**: in Phase 3, pay extra attention to index coverage. In Phase 4, use `EXPLAIN` on the slow query.
- **General exploration** (no specific goal): follow the default six-phase workflow below.

### Phase 2 — Survey

**Goal**: get the table catalog and pick 3-5 core tables to inspect first.

1. Call `db_list_tables` for the target database.
2. Scan table names for **core entities** — these usually have:
   - Simple, singular nouns (`user`, `order`, `product`, `article`)
   - No prefix like `tmp_`, `bak_`, `_archive`
   - High row counts (inferred from naming, or verified in phase 3)
3. Group the rest by role:
   - **Lookup/side tables**: likely small, referenced by core tables (`status`, `category`, `type`)
   - **Join tables**: composite names (`user_role`, `order_item`)
   - **Log/audit tables**: names with `log`, `history`, `audit`, `event`

### Phase 3 — Inspect

**Goal**: understand the schema of core tables.

1. For each core table, call `db_table_schema`. Read:
   - **Columns**: names, types, nullability. Note which columns look like foreign keys (ending in `_id` or matching other table names).
   - **Indexes**: primary keys, unique constraints, and secondary indexes. Indexes on `*_id` columns are FK hints.
2. For lookup tables discovered in phase 2, call `db_table_schema` only if they appear in FK positions of core tables.

### Phase 4 — Sample

**Goal**: see real data to confirm understanding.

1. For each core table, run a sample query via `db_query`:
   ```sql
   SELECT * FROM table_name LIMIT 5
   ```
2. Check:
   - Do column values match the inferred semantics? (e.g., `status` values, `type` enums)
   - Are FK columns populated or mostly NULL?
   - Are there soft-delete columns? Common names: `deleted_at`, `is_deleted`, `is_active`, `deleted`, `archived_at`, `istatus`. Also check `status` columns for values like `'deleted'` or `'archived'`.

### Phase 5 — Connect

**Goal**: discover and register table relationships.

1. Call `db_list_relations` for the database to see already-registered relationships.
2. For each core table, look at column names ending in `_id`:
   - `user_id` → likely references `users.id`
   - `order_id` → likely references `orders.id`
     For bulk FK discovery across all tables, query `information_schema.COLUMNS` with `WHERE COLUMN_NAME LIKE '%\_id'`. The `\_` escapes the underscore — without it, `_` matches any single character.
3. For each candidate FK pair, verify by checking:
   - The referenced table exists (from phase 2)
   - The column types match (from phase 3 schemas)
4. Register confirmed relationships via `db_relation` with `action="register"`.
   - Default to `relationType: "MANY_TO_ONE"` (the FK side is "many").
   - Registration is idempotent — safe to call on existing pairs.
5. Write a test JOIN query via `db_query` to confirm the relationship works:
   ```sql
   SELECT t1.*, t2.column
   FROM table1 t1
   JOIN table2 t2 ON t1.fk_column = t2.id
   LIMIT 5
   ```

### Phase 6 — Report

**Goal**: summarize findings so the user can act.

Present a structured summary. For row counts, query `information_schema.TABLES` (approximate for InnoDB, instantaneous) or run `SELECT COUNT(*)` for exact counts:

```
## Database: <name> (@<connection>)

### Core tables (N of M total)
| Table | Rows (est) | Key columns | FK to |
|-------|-----------|-------------|-------|
| users | 1.2K | id, email, name | — |
| orders | 8.5K | id, user_id, total | users.id |

### Discovered relationships
| From | To | Type |
|------|----|------|
| orders.user_id | users.id | MANY_TO_ONE |

### Next steps
- Run `/db relations discover` to find system-declared FKs
- Query <table> for <specific analysis>
```

## Edge Cases

Common failure modes and how to handle them:

**No configured connections** — `db_discover` returns an empty list.
→ Tell the user to add a connection in `~/.pi/database/connections.yaml`. No further action possible.

**Workspace not set** — `db_discover` shows connections but no current database selected.
→ Pick the first connection, list its databases, and ask the user which one to target.

**Empty database** — `db_list_tables` returns zero tables.
→ Report "database `<name>` has no tables" and end the workflow here.

**Very large schema (50+ tables)** — Phase 2 produces an overwhelming list.
→ Query `information_schema.TABLES` for row counts first. Focus on the top 15-20 tables by `TABLE_ROWS`. Skip zero-row tables unless the user asks about them.

**No FK candidates found** — Phase 5 finds no `*_id` columns or all candidate pairs fail verification.
→ Report "no column-naming FK candidates found." Suggest running `/db relations discover` for system-declared foreign keys, or ask the user about implicit relationships.

**Connection refused or timeout** — any tool call fails with a network error.
→ Report the error. Check connectivity with `scripts/workspace-status.sh`. Wait for the user to confirm before retrying — they may need to check VPN, credentials, or the MySQL server status.

## Anti-patterns to avoid

- **Schema dump**: inspect only core tables and their FK targets. Skip lookup tables unless they sit at the end of a foreign key.
- **Blind queries**: verify column types and FK existence, then write JOINs.
- **Relation spam**: register only verified FK pairs — confirm the referenced table and column exist first.
- **Single-table tunnel vision**: after inspecting one table, check what it connects to.

## When to go deeper

After the core workflow and report, branch out based on the user's goal (adjusted from the Phase 1 goal check):

- **Analytics/reporting**: trace fact tables → dimension tables via registered relationships. Run `db_query` with aggregations (COUNT, SUM, GROUP BY) on high-row-count tables.
- **CRUD/application**: map the full entity graph — for each core table, trace all FK dependencies one level out using `db_list_relations` and test JOINs.
- **Migration/audit**: inspect ALL tables (not just core), note deprecated columns, find tables missing primary keys (`SHOW INDEX` or `information_schema.STATISTICS`), check for soft-delete patterns.
- **Performance**: use `EXPLAIN` via `db_query` on common queries. Check index coverage with `SHOW INDEX FROM table_name`. Look for missing indexes on FK columns discovered in Phase 5.

## Scripts

**`scripts/workspace-status.sh`** — Check the current database workspace state (connection, database, relations count, query history, favorites, and configured connections) without making a tool call. Run when:

- Unsure which connection/database is currently selected and want a quick overview before calling `db_discover`
- Debugging tool call failures by confirming the underlying state
- Need a summary of all configured connections at a glance
