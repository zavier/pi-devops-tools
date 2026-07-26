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

### Layer stack (top → bottom)

```
commands/          ← /db subcommand handlers (switch, query, schema, tables, history, favorite, relations, refresh-schema)
  ↓
state/workspace.ts ← DatabaseWorkspaceService (facade composing all modules)
state/context.ts   ← WorkspaceContext (current DB selection, persistence, schema cache proxy)
state/query-runner.ts ← QueryRunner (SQL execution + history recording + lastSql tracking)
  ↓
connection/        ← DatabaseConnectionManager (lazy mysql2 pools keyed by connection ID)
schema/            ← Schema cache read/write/refresh (JSON files on disk)
history/           ← QueryHistoryStore + FavoriteStore (SQLite)
relation/          ← RelationStore (SQLite, shares history.db)
relation-graph.ts  ← RelationGraph (in-memory bidirectional graph + BFS traversal for auto-join)
formatting/        ← formatTableResult — auto layout: horizontal (≤8 cols) / transposed / vertical key-value
```

### Key design patterns

- **Cache-first schema**: `getTables()` and `getTableSchema()` check local JSON cache first, fall back to live DB query. Refresh via `/db refresh-schema`.
- **BFS auto-join**: `RelationGraph.bfsQuery()` traverses the in-memory forward graph to follow registered table relations, building `SELECT * FROM related_table WHERE col IN (...)` queries at each hop. Depth-limited (default 2, max 5).
- **Read-only enforcement**: SQL is validated against `/^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i` (`READONLY_SQL_RE` in `commands/query.ts`) before execution.
- **Lazy connections**: MySQL pools are created on first use and cached by connection ID. `destroy()` cleans up all pools.
- **Facade bypass**: command handlers mix facade calls with direct access to `ws.relationGraph` / `ws.favorites` / `ws.manager` / `ws.history` — the facade is not a hard seam; follow existing usage when adding commands.

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
