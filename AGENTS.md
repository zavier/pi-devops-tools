# AGENTS.md

Working conventions for this repo. The architecture is documented in
[CLAUDE.md](./CLAUDE.md) — read that first.

## Verify before pushing

`npm run check` (typecheck) and `npm test` must both pass. CI enforces this
plus `npm run lint` (0 errors) and `npm run fmt:check`.

```bash
npm run check       # tsc --noEmit
npm test            # vitest run
npm run lint        # oxlint
npm run fmt:check   # oxfmt --check
npm run fmt         # oxfmt (auto-fix)
```

## Branches, commits, PRs

- Never commit directly to `main`; every change lands via a PR.
- Branch names: `<type>/<short-slug>` (`feat/sql-export`, `fix/bfs-cycle`).
- Commits follow Conventional Commits: `type(scope): subject` with types
  `feat` / `fix` / `chore` / `build` / `docs` / `refactor` / `style` / `test`.
  Scope is the area (`db`, `schema`, `relations`, `history`, `query`). Subject
  is imperative, ≤72 chars; body explains what and why.
- PR title = the eventual squash-commit title (same format). PR body: what
  changed and why, then how it was verified.

## Design ground rules

- **Facade integrity**: commands never reach past `DatabaseWorkspaceService`.
  All delegates (`manager`, `history`, `favorites`, `relationGraph`) are
  private fields of the facade. If a command needs new behavior, expose a
  purpose-built method on the facade — don't punch through to internals.
- **Single query path**: every SQL query flows through
  `DatabaseConnectionManager.executeQuery` — the only place that applies the
  read-only guard, LIMIT policy, and USE + query on a dedicated connection.
  Never create new query paths or bypass `sql-policy.ts`.
- **Pure utilities**: `sql-policy.ts` and `formatting/result-table.ts` are
  pure functions with no side effects. Keep them that way — no pi imports, no
  I/O. When logic doesn't need pi APIs, extract it to pure functions so it
  becomes testable with plain values.
- **Seams for testing**: modules accept their dependencies via constructor
  parameters (`StateStore`, `Database` handle, `QueryFn`). Don't introduce
  hardcoded paths (`homedir()`) or singletons — inject the seam instead.
- **Cache-first, not cache-only**: `getTables()` and `getTableSchema()` check
  local JSON cache first, fall back to live DB. The cache is never the source
  of truth — it's a performance optimization.
- **BFS is DB-agnostic**: `RelationGraph.bfsQuery()` receives a `QueryFn` from
  its caller. The graph doesn't know about mysql2 — it only knows "give me a
  function that runs SQL". This is what makes the graph testable with a stub.

## Type discipline

- Shared types go in `types.ts`. Module-internal types stay in their module.
- Use `SqlRow` / `SqlValue` (from `types.ts`) for query result rows — not
  `Record<string, any>`. The narrower type catches mistakes at compile time.
- At the MySQL/SQLite driver boundary, explicit casts (`as string`) are
  acceptable — the drivers return untyped rows and we narrow them at the edge.
- Prefer `SqlRow` over `any` even in internal helper functions — it documents
  intent and catches `.padEnd()`-on-numbers bugs.

## Test conventions

- Tests live in `__tests__/`, one file per module under test.
- Use `vitest` (`describe` / `it` / `expect`).
- Isolate with real substitutes, not mocks:
  - SQLite stores → `new Database(":memory:")`
  - Schema cache → temp directory (`node:os.tmpdir()`)
  - Connection config → temp YAML files
  - Relation graph → stub `QueryFn` that routes by `schema.table` prefix
- No live MySQL in tests. The CI runner has no database — tests that require
  a live connection belong in integration tests (not in this repo).

## Release process

1. Merge PRs into `main`.
2. `npm version minor|patch -m "chore(release): %s"` (bumps, commits, tags `vX.Y.Z`).
3. `git push --follow-tags`
4. `gh release create vX.Y.Z --verify-tag --generate-notes`

The npm tarball is whitelisted by `files` in `package.json`. If you add
runtime files outside the listed directories, update it and verify with
`npm pack --dry-run`.
