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

| Path | Format | Owned by |
|---|---|---|
| `workspace.json` | JSON | `WorkspaceContext` — current env/connection/database selection |
| `history.db` | SQLite | `QueryHistoryStore` + `FavoriteStore` + `RelationStore` (3 tables, 1 DB, shared handle via `history.getDb()`) |
| `schema/<connId>/<db>.json` | JSON | Schema cache — table/column/index snapshots |

### Layer stack (flat)

```
commands/          ← /db subcommand handlers — only see the DatabaseWorkspaceService interface
state/workspace.ts ← DatabaseWorkspaceService — the single deep module behind /db
                     (absorbs context state, query execution, history, schema cache proxy)
connection/        ← DatabaseConnectionManager (lazy mysql2 pools) + sql-policy (guard + LIMIT)
schema/            ← Schema cache read/write/refresh (JSON on disk)
history/           ← QueryHistoryStore + FavoriteStore (SQLite)
relation/          ← RelationStore (SQLite, shares history.db)
relation-graph.ts  ← RelationGraph (in-memory bidirectional graph + BFS)
formatting/        ← formatTableResult — auto layout: horizontal / transposed / vertical
```

### Key design patterns

- **Deep workspace module**: `DatabaseWorkspaceService` absorbs WorkspaceContext + QueryRunner into one class. All delegates (`manager`, `history`, `favorites`, `relationGraph`) are private — commands cross the external seam through ~23 purpose-built methods. No command reaches past the facade.
- **Single execution point**: all queries go through `DatabaseConnectionManager.executeQuery`, which applies the read-only guard and LIMIT policy (`connection/sql-policy.ts` — pure functions, single home of `READONLY_SQL_RE`), then runs on a dedicated checked-out connection (`getConnection → USE → query → release`) so USE and the query can't be split across pool connections. Unbounded SELECTs get `LIMIT n` appended (default 100, per-connection `queryLimit` in connections.yaml); the final SQL is returned as `result.sql` so auto-appended limits are visible to the user. Command handlers import `READONLY_SQL_RE` only for dispatch (table-name vs SQL), never for enforcement.
- **Cache-first schema**: `getTables()` and `getTableSchema()` check local JSON cache first, fall back to live DB query. Refresh via `/db refresh-schema`.
- **BFS auto-join**: `RelationGraph.bfsQuery()` traverses the in-memory forward graph, issuing parameterized (`IN (?)`), schema-qualified queries at each hop. Depth-limited (default 2, max 5). It receives a `QueryFn` from its caller rather than a mysql2 pool — the graph stays DB-agnostic and is tested with a stub.
- **Lazy connections**: MySQL pools are created on first use and cached by connection ID. `destroy()` cleans up all pools.

### Relation graph data flow

1. User registers a relation via `/db relations add`: `source_table.column → target_table.column`
2. `RelationStore` persists to SQLite `table_relations` table
3. `RelationGraph` rebuilds its in-memory bidirectional `forward` Map
4. On query with auto-join, `bfsQuery()` starts from the queried table, follows registered edges, and returns related rows as separate `RelatedResult` objects
5. Relations export/import via `.pi/table-relations.json` in the project root

### Type system

All shared types are in `types.ts`: `ColumnRef`, `ColumnRelation`, `RelatedResult`. Each module may define additional internal types (e.g., `HistoryEntry` in `history/store.ts`, `CachedTable` in `schema/cache.ts`).

### Tests

Tests use `vitest` and live in `__tests__/` (schema-cache, history, relation-graph). They test individual modules in isolation. Note: `__tests__/schema-cache.test.ts` writes into the real `~/.pi/database/schema/` directory — paths are pinned to `homedir()` at module scope with no injection seam.
