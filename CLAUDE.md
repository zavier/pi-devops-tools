@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`pi-devops-tools` is a [pi](https://pi.dev) extension that provides a database workspace inside the terminal — query MySQL databases, manage table relationships, and cache schema locally. The single entry point is the interactive `/db` command.

## Commands

```bash
npm test              # Run all tests (vitest)
npx vitest run        # Equivalent
npx vitest path/to/test.test.ts  # Run a single test file
npx tsc --noEmit      # Typecheck (no build step — pi loads TypeScript directly)
```

## Architecture

### Single service entry point

`DatabaseWorkspaceService` (`state/workspace.ts`) is the facade behind the `/db` command, composing all modules. It is registered in `index.ts`, which is the extension's only wiring point.

### Configuration

User-scoped connections live in `~/.pi/database/connections.yaml`, loaded by `connection/db-config.ts` into `ResolvedConnectionConfig[]`. Supports `${ENV_VAR}` substitution in passwords. There is no project-level config file.

### Data storage

All persistent state lives under `~/.pi/database/`:

| Path                        | Format | Owned by                                                                                                      |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `workspace.json`            | JSON   | `WorkspaceContext` — current env/connection/database selection                                                |
| `history.db`                | SQLite | `QueryHistoryStore` + `FavoriteStore` + `RelationStore` (3 tables, 1 DB, shared handle via `history.getDb()`) |
| `schema/<connId>/<db>.json` | JSON   | Schema cache — table/column/index snapshots                                                                   |

### Layer stack (flat)

```
commands/          ← /db subcommand handlers — only see the DatabaseWorkspaceService interface
state/workspace.ts ← DatabaseWorkspaceService — the single deep module behind /db
state/state-store.ts ← StateStore — owns baseDir + SQLite handle + derived paths (injectable seam)
connection/        ← DatabaseConnectionManager (lazy mysql2 pools) + sql-policy (guard + LIMIT)
                     + db-config (connections.yaml loader, accepts optional path)
schema/            ← Schema cache read/write/refresh (JSON on disk, functions accept baseDir?)
history/           ← QueryHistoryStore + FavoriteStore (accept Database in constructor)
relation/          ← RelationStore (accepts Database in constructor)
relation-graph.ts  ← RelationGraph (in-memory bidirectional graph + BFS, accepts Database)
formatting/        ← formatTableResult — auto layout: horizontal / transposed / vertical
```

### Key design patterns

- **Deep workspace module**: `DatabaseWorkspaceService` absorbs WorkspaceContext + QueryRunner into one class. All delegates (`manager`, `history`, `favorites`, `relationGraph`) are private — commands cross the external seam through ~23 purpose-built methods. No command reaches past the facade.
- **Single execution point**: all queries go through `DatabaseConnectionManager.executeQuery`, which applies the read-only guard and LIMIT policy (`connection/sql-policy.ts` — pure functions, single home of `READONLY_SQL_RE`), then runs on a dedicated checked-out connection (`getConnection → USE → query → release`) so USE and the query can't be split across pool connections. Unbounded SELECTs get `LIMIT n` appended (default 100, per-connection `queryLimit` in connections.yaml); the final SQL is returned as `result.sql` so auto-appended limits are visible to the user. Command handlers import `READONLY_SQL_RE` only for dispatch (table-name vs SQL), never for enforcement.
- **Cache-first schema**: `getTables()` and `getTableSchema()` check local JSON cache first, fall back to live DB query. Refresh via `/db refresh-schema`.
- **BFS auto-join**: `RelationGraph.bfsQuery()` traverses the in-memory forward graph, issuing parameterized (`IN (?)`), schema-qualified queries at each hop. Depth-limited (default 2, max 5). It receives a `QueryFn` from its caller rather than a mysql2 pool — the graph stays DB-agnostic and is tested with a stub.
- **Lazy workspace init**: `DatabaseWorkspaceService` is not constructed in the extension factory (which may run in invocations that never start a session such as `--list-models` or print mode). Instead a lazy getter defers opening SQLite / reading config until `session_start`, the first `/db` command, or the first tool call.
- **Lazy connections**: MySQL pools are created on first use and cached by connection ID. `destroy()` cleans up all pools. `reloadConfig()` destroys the old manager before swapping so old pools don't leak.
- **StateStore seam**: `DatabaseWorkspaceService(storage?)` accepts an optional `StateStore` — production defaults to `~/.pi/database`, tests inject a temp directory. `StateStore` owns the SQLite handle (all three stores + RelationGraph share it via constructor injection), plus path helpers for schema cache and connections config.

### LLM tools

The extension registers four read-only tools for the LLM in `tools/db-tools.ts`:

| Tool                   | Description                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `db_query`             | Execute a read-only SQL query; LIMIT appended automatically. Result truncated with `truncateHead` (50KB / 2000 lines). |
| `db_list_tables`       | List tables (cache-first).                                                                                             |
| `db_table_schema`      | Show columns + indexes for a table (cache-first). Uses shared `formatSchemaMarkdown` pure function.                    |
| `db_register_relation` | Persist a discovered table relationship. Closes the loop from `/db relations discover` AI analysis.                    |

All four cross `DatabaseWorkspaceService`, so the read-only guard and LIMIT policy apply identically to the LLM and the user.

### Message rendering

Results that were transient `notify()` calls now use `pi.sendMessage({ display: true })` with custom `registerMessageRenderer` handlers (`commands/renderers.ts`):

| customType           | Renderer                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `db-query-result`    | Header + SQL + main table always; related tables only when expanded. Details carry structured `QueryResultDetails`. |
| `db-workspace-panel` | Raw preformatted text (the panel is not markdown).                                                                  |

Others (`db-tables`, `db-table-schema`, `db-er-diagram`) use the default custom-message rendering (purple box + markdown) — their content is small and markdown-friendly.

### Relation graph data flow

1. User registers a relation via `/db relations add`: `source_table.column → target_table.column`
   - Or: AI discovers relationships and calls `db_register_relation` tool (the `/db relations discover` flow instructs the model to use this tool)
2. `RelationStore` persists to SQLite `table_relations` table
3. `RelationGraph` rebuilds its in-memory bidirectional `forward` Map
4. On query with auto-join, `bfsQuery()` starts from the queried table, follows registered edges, and returns related rows as separate `RelatedResult` objects

### Type system

All shared types are in `types.ts`: `ColumnRef`, `ColumnRelation`, `RelatedResult`. Each module may define additional internal types (e.g., `HistoryEntry` in `history/store.ts`, `CachedTable` in `schema/cache.ts`).

### Tests

Tests use `vitest` and live in `__tests__/` (sql-policy, schema-cache, history, relation-graph). They test individual modules in isolation. `schema-cache.test.ts` uses a temp directory; `history.test.ts` passes `new Database(":memory:")`; `relation-graph.test.ts` uses `:memory:`.
