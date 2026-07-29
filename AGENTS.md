# AGENTS.md

Working conventions for this repo. The architecture is documented in
[CLAUDE.md](./CLAUDE.md) — read that first.

## Verify before pushing

**Before every commit, run this checklist.** CI enforces the same steps and
will reject anything that fails:

```bash
npm run check       # tsc --noEmit          — must pass
npm test            # vitest run             — must pass
npm run lint        # oxlint                 — must have 0 errors
npm run fmt         # oxfmt (applies fixes!) — always run before commit
npm run fmt:check   # oxfmt --check          — must pass (redundant after fmt)
```

**Commit checklist — run before `git commit`:**

1. `npx tsc --noEmit` — typecheck passes
2. `npx vitest run` — all tests pass
3. `npm run fmt` — format any changed files
4. `git add -A && git commit`

No exceptions. Two CI failures in a row were caused by skipping step 3.

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
- **Single execution path per operation type**: all read queries flow through
  `DatabaseConnectionManager.executeQuery` (read-only guard + LIMIT). All write
  mutations flow through `DatabaseConnectionManager.executeMutation` (DDL
  rejected by `prepareMutationQuery`, human confirmation gate). Never create
  new query paths or bypass `sql-policy.ts`.
- **Pure utilities**: `sql-policy.ts` (read-only guard + LIMIT injection + DML
  validation) and `formatting/result-table.ts` are pure functions with no side
  effects. Keep them that way — no pi imports, no I/O. When logic doesn't need
  pi APIs, extract it to pure functions so it becomes testable with plain values.
- **Seams for testing**: modules accept their dependencies via constructor
  parameters (`StateStore`, `Database` handle, `QueryFn`). Don't introduce
  hardcoded paths (`homedir()`) or singletons — inject the seam instead.
- **Live schema, no cache**: `getTables()` and `getTableSchema()` always query
  the live DB (`information_schema`). There is no schema cache to refresh or
  keep consistent — live queries are cheap enough and never stale. Don't
  reintroduce a cache layer without a measured need.
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
  - Workspace service → temp-directory `StateStore` + temp `connections.yaml`
  - Relation graph → stub `QueryFn` that routes by `schema.table` prefix
- No live MySQL in tests. The CI runner has no database — tests that require
  a live connection belong in integration tests (not in this repo).

## Release process

1. Merge PRs into `main`.
2. `npm version minor|patch -m "chore(release): %s"` (bumps, commits, tags `vX.Y.Z`).
3. `git push --follow-tags`
4. `npm publish`
5. `gh release create vX.Y.Z --verify-tag --generate-notes`

The npm tarball is whitelisted by `files` in `package.json`. If you add
runtime files outside the listed directories, update it and verify with
`npm pack --dry-run`.
