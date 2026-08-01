# AGENTS.md

本仓库的工作约定。架构文档见 [CLAUDE.md](./CLAUDE.md) —— 请先阅读。

## 提交前验证清单

**每次提交前必须执行以下检查。** CI 强制执行同样的步骤，任何失败都会被拒绝：

```bash
npm run check       # tsc --noEmit          —— 必须通过
npm test            # vitest run             —— 必须通过
npm run lint        # oxlint                 —— 必须 0 errors
npm run fmt         # oxfmt（会自动修复！）—— 提交前必须执行
npm run fmt:check   # oxfmt --check          —— 必须通过（与 fmt 重复，保险起见）
```

**提交清单 —— `git commit` 之前：**

1. `npx tsc --noEmit` —— 类型检查通过
2. `npx vitest run` —— 所有测试通过
3. `npm run fmt` —— 格式化所有变更文件
4. `git add -A && git commit`

没有例外。CI 已连续两次失败于跳过第 3 步；第三次失败是因为误以为 oxfmt 只格式化 `.ts` 文件——它也会格式化 `.md`（表格对齐、行尾空格等）。**任何**文件变更（包括文档）后都要运行 `npm run fmt`。

## 语言约定

- **代码注释（`//` 与 `/* */`）一律使用中文**（代码标识符、类型名保持英文）。
- **git message 使用中文**（conventional commits 格式，见下）。subject 用中文描述变更；body 用中文说明做了什么、为什么。
- **模型提示语保持英文**：工具 description / promptSnippet / promptGuidelines 是模型提示语，不要翻译（保持稳定、可预期）。工具执行输出与 TUI 文案使用中文（与 /db query 的 LLM 消息保持一致）。
- 用户可见的 TUI 文案（`ctx.ui.notify` 等）使用中文（现状如此，保持一致）。

## 分支、提交、PR

- 永远不直接提交到 `main`；所有变更通过 PR 落地。
- 分支名：`<type>/<short-slug>`（`feat/sql-export`、`fix/bfs-cycle`）。
- 提交遵循 Conventional Commits：`type(scope): subject`，类型为
  `feat` / `fix` / `chore` / `build` / `docs` / `refactor` / `style` / `test`。
  scope 是领域（`db`、`schema`、`relations`、`history`、`query`）。subject 用**中文**，
  祈使句，≤72 字符；body 解释做了什么、为什么。
- PR 标题 = 最终 squash 提交标题（同样格式）。PR 正文：变更内容与原因，然后是验证方式。

## 设计底线

- **Facade 完整性**：命令永远不越过 `DatabaseWorkspaceService`。所有委托（`manager`、`history`、`favorites`、`relationGraph`）都是 facade 的私有字段。命令需要新行为时，在 facade 上暴露专用方法——不要穿透到内部。
- **每种操作单一执行路径**：所有读查询流经 `DatabaseConnectionManager.executeQuery`（只读守卫 + LIMIT）。所有写变更流经 `DatabaseWorkspaceService.executeMutationWithApproval`（facade 内 `prepareMutationQuery` 拒绝 DDL + 注入的人工确认回调）。绝不创建新的查询路径或绕过 `sql-policy.ts`。
- **纯工具函数**：`sql-policy.ts`（只读守卫 + LIMIT 注入 + DML 校验）和 `formatting/result-table.ts` 是纯函数、无副作用。保持这一点——不导入 pi、不做 I/O。当逻辑不需要 pi API 时，抽成纯函数以便用普通值测试。
- **测试接缝**：模块通过构造函数参数接受依赖（`StateStore`、`Database` 句柄、`QueryFn`）。不要引入硬编码路径（如 `homedir()`）或单例——注入接缝。
- **实时 schema，无缓存**：`getTables()` 和 `getTableSchema()` 总是查询实时 DB（`information_schema`）。没有 schema 缓存需要刷新或保持一致——实时查询足够廉价且永不过期。没有实测需求就不要重新引入缓存层。
- **BFS 与数据库无关**：`RelationGraph.bfsQuery()` 从调用方接收 `QueryFn`。图不知道 mysql2——它只知道"给我一个执行 SQL 的函数"。这让图可以用 stub 测试。

## 类型纪律

- 共享类型放 `types.ts`。模块内部类型留在模块内。
- 查询结果行使用 `SqlRow` / `SqlValue`（来自 `types.ts`）——不要用 `Record<string, any>`。更窄的类型在编译期捕获错误。
- 在 MySQL/SQLite 驱动边界，显式类型断言（`as string`）是可接受的——驱动返回无类型行，我们在边界收窄。
- 即使内部辅助函数也优先 `SqlRow` 而非 `any`——它表达意图，并捕获 `.padEnd()` 作用于数字之类的 bug。

## 测试约定

- 测试在 `__tests__/`，每个被测模块一个文件。
- 使用 `vitest`（`describe` / `it` / `expect`）。
- 用真实替身而非 mock 隔离：
  - SQLite 存储 → `new Database(":memory:")`
  - Workspace 服务 → 临时目录 `StateStore` + 临时 `connections.yaml`
  - 关系图 → 按 `schema.table` 前缀路由的 stub `QueryFn`
- 测试中不连真实 MySQL。CI 运行器没有数据库——需要真实连接的测试属于集成测试（不在本仓库）。

## 发布流程

1. 将 PR 合并进 `main`。
2. `npm version minor|patch -m "chore(release): %s"`（版本号提升、提交、打标签 `vX.Y.Z`）。
3. `git push --follow-tags`
4. `npm publish`
5. `gh release create vX.Y.Z --verify-tag --generate-notes`

npm 包内容由 `package.json` 的 `files` 白名单控制。如果在白名单目录之外新增了运行时文件，更新它并用 `npm pack --dry-run` 验证。
