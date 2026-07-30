---
name: db-explore
description: >
  Systematic database exploration workflow. Use this skill whenever the user
  wants to explore a new or unfamiliar MySQL database, understand its schema,
  discover table relationships, or get oriented before writing queries. Also
  use when the user asks "what tables are here", "show me the database
  structure", "how is this database organized", "find relationships between
  tables", or any open-ended database inspection task. This skill turns
  ad-hoc exploration into a repeatable, efficient process.
---

# Database Exploration

Systematic workflow for exploring a MySQL database through the `db_*` tools.

## Philosophy

Don't dump every table at once. Start broad, narrow by relevance, and build up a mental model incrementally. The goal is understanding, not enumeration.

## Core workflow

### Phase 1 — Orient

**Goal**: confirm which connection and database you're targeting.

1. Call `db_discover` without parameters to see current connection + available databases.
2. If the target isn't the current workspace selection, note the `connection` and `database` values for override params.

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
   - Are there soft-delete columns (`deleted_at`, `is_active`)?

### Phase 5 — Connect

**Goal**: discover and register table relationships.

1. Call `db_list_relations` for the database to see already-registered relationships.
2. For each core table, look at column names ending in `_id`:
   - `user_id` → likely references `users.id`
   - `order_id` → likely references `orders.id`
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

Present a structured summary:

```
## Database: <name> (@<connection>)

### Core tables (N of M total)
| Table | Rows (est) | Key columns | FK to |
|-------|-----------|-------------|-------|
| users | ? | id, email, name | — |
| orders | ? | id, user_id, total | users.id |

### Discovered relationships
| From | To | Type |
|------|----|------|
| orders.user_id | users.id | MANY_TO_ONE |

### Next steps
- Run `/db relations discover` to find system-declared FKs
- Query <table> for <specific analysis>
```

## Anti-patterns to avoid

- **Schema dump**: don't call `db_table_schema` on every table — focus on core entities.
- **Blind queries**: don't write complex JOINs before checking column types and FK existence.
- **Relation spam**: don't register every `*_id` column as a relation — verify the referenced table and column exist first.
- **Single-table tunnel vision**: after inspecting one table, check what it connects to.

## When to go deeper

After the core workflow, branch out based on the user's goal:

- **Analytics/reporting**: focus on fact tables (high row count, many FKs) → dimension tables
- **CRUD/application**: focus on entity tables → their FK dependencies
- **Migration/audit**: inspect all tables, note deprecated columns, find missing indexes
- **Performance**: use `EXPLAIN` via `db_query` on common queries, check index coverage from phase 3

## Scripts

Helper scripts for supplementary inspection outside the tool workflow.

### Check workspace state

```bash
cat ~/.pi/database/workspace.json 2>/dev/null | python3 -m json.tool
```

Shows current connection and database selection without a tool call.

### Check relations count

```bash
sqlite3 ~/.pi/database/state.db "SELECT COUNT(*) AS relation_count FROM table_relations;"
```

Quick check of how many relations are registered. For detailed listing, use `db_list_relations`.
