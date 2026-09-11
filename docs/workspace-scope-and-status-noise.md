# 工作空间隔离与状态静默（Workspace Scope & Status Noise）

> 状态：**已实施**（决策记录见 §2.6 / §3.4，实施记录见 §7）
> 目标版本：0.10.0

## 1. 现状确认（结论先行）

| #   | 问题描述                                | 是否成立     | 结论要点                                                                     |
| --- | --------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| 1   | 选择状态是全局的，跨项目携带            | **成立**     | 持久层完全无 cwd 参与；且存在并发会话互相覆盖问题（非仅"携带"）              |
| 2   | 无连接时注入会话消息 / 占用 UI 与上下文 | **部分成立** | 仅在"已配置连接但未选择"时注入，且文本是让模型去催用户；"完全未配置"时不注入 |

### 1.1 问题 1：选择状态的持久层是全局单例

证据链（全部确认）：

- `state/state-store.ts:13` —— `DEFAULT_BASE = join(homedir(), ".pi", "database")`，**无 cwd 参与**；`baseDir` 只由构造参数覆盖。
- `state/state-store.ts:39` —— `workspaceFile` = `<baseDir>/workspace.json`，单文件，与项目无关。
- `state/workspace.ts:124` —— 构造时 `loadWorkspace(this.store.workspaceFile)` 读一次；`workspace.ts:245` —— `switchTo()` 整体覆写该文件（唯一写入点：`commands/switch.ts:93`）。
- 扩展实例本身是**会话级**的（`index.ts:65` `session_shutdown` → `destroy()`；`/new`、`/resume`、`/fork`、`/reload` 都会重建实例并重跑工厂），所以内存态是会话级、持久态是全局 —— 于是**每个新会话必然继承"上一次任意项目/任意会话"的选择**。

实证（临时 vitest，跑完已删）：项目 A 目录下 `switchTo("test","qa","qa_db")` 后，切到项目 B 目录新建实例：

```
A cwd: /private/var/.../scratch-projA-x9mkDm -> current: null
B cwd: /private/var/.../scratch-projB-4qdEh0 -> current: { environment: 'test', connectionId: 'qa', database: 'qa_db' }
state file: /var/folders/.../scratch-home-cuRADw/.pi/database/workspace.json
```

两个不同项目目录读同一份 `workspace.json`，且项目 A 目录下无任何状态文件。**泄漏成立。**

附带确认的两个次生问题（同一根因，改造时一并处理）：

- **并发会话无实时同步**：实例化时读一次、切换时整体覆写 → 同项目两个会话各自持有内存选择，后写者覆盖前者；先写的那个会话在下一次会话启动前看不到变化。
- **整体覆写无原子性**：`saveWorkspace` 直接 `writeFileSync` 覆盖，中断可能留下半截 JSON（`loadWorkspace` 会回退为 null → 选择丢失）。

### 1.2 问题 2：噪音的真实来源与边界

先给完整矩阵（代码确认 + 实证）：

| 状态                        | `session_start` 注入                              | TUI 展示                                               | 模型行为                            |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| 未配置连接（文件缺失/为空） | **无**（`llm-context.ts:46-48` 两个分支都不命中） | 仅 `/db` 面板内 `⚠️ 尚未配置数据库连接`（`db.ts:265`） | 无影响                              |
| 已配置但未选择              | **注入 `db-hint`**                                | 无（`display: false`，且未注册 message renderer）      | **模型会主动催用户去 `/db switch`** |
| 已选择                      | 注入 `db-active-db`                               | 状态栏 + widget（`db.ts:391`，仅 `isReady` 时设置）    | 合理，模型需要知道当前目标          |

实证（临时 vitest）——case A 的实际注入内容：

```json
{
  "customType": "db-hint",
  "content": "Database connections are configured but no database is selected. Tell the user to run /db switch to connect. Config file: .../connections.yaml.",
  "display": false
}
```

case B（无任何连接配置）实证注入为空数组 —— **所以"完全没配连接"时并没有消息注入**。

因此"用户页面看到无数据库连接信息"的真实路径是：**`db-hint` 明确指示模型 `Tell the user to run /db switch`，模型照做，在对话里输出一句中文催办**。扩展本身没有渲染这句话（`display: false` + 无 message renderer），你在页面上看到的是模型的回复。这一点在改造时要对齐预期：删掉注入＝模型不再催办。

另有两处**重复注入**（同一内容反复进上下文）：

- `index.ts:61` —— 每次 `session_start`（含 `/db on|off` 触发的 `reload`、`/new`、`/resume`）注入一次；
- `db.ts:101` —— 每次打开 `/db` 面板再注入一次（面板先调 `sendDbStatus` 再渲染）。

### 1.3 机制确认（改造依赖的 pi 侧事实）

- `ctx.cwd: string` 存在于 `ExtensionContext`（`dist/core/extensions/types.d.ts:217`），`ExtensionCommandContext` 继承之；工具 `execute` 的第 5 参、命令 handler、事件 handler 都能拿到。
- 扩展工厂在 `/new`、`/resume`、`/fork`、`/reload` 时**重新执行**（pi 先发 `session_shutdown` 拆旧运行时，重建后再发 `session_start`，见 `docs/extensions.md` → Session replacement lifecycle）→ 闭包内状态天然按会话隔离。
- `sessionManager` 记录会话 cwd（`dist/core/session-cwd.d.ts` 有 `getCwd()`），`/resume` 可进入与当前进程 cwd 不同的目录 —— **`ctx.cwd` 是权威来源，`process.cwd()` 只能当兜底**。
- `state-store.ts:13` 的 `DEFAULT_BASE` 是**模块顶层求值一次**的常量（`homedir()` 读取时机在 import 时）。测试若要用 `HOME` 覆盖基目录，必须在 import 之前设置 `process.env.HOME`；生产代码不受影响。

## 2. Part A：选择状态按项目隔离

### 2.1 粒度候选与推荐

| 方案 | 存储键       | 跨项目泄漏 | 同项目新会话 | 会话内一致性（`/resume` 后）                   | 代价                           |
| ---- | ------------ | ---------- | ------------ | ---------------------------------------------- | ------------------------------ |
| S1   | 无（纯内存） | 消除       | 需重选       | **不一致**（JSONL 里有旧状态消息，扩展无选择） | 每次会话重选；最安全           |
| S2   | 项目 cwd     | 消除       | 自动继承     | 一致                                           | 同项目并发会话仍"后写者胜"     |
| S3   | 会话 id/文件 | 消除       | 需重选       | 一致（按会话恢复）                             | 每次新会话重选；条目需清理策略 |

**推荐 S2（项目 cwd 键控）**。理由：

1. 直接消除你报告的症状（跨项目携带），保留"同项目下次进来还是那个库"的便利；
2. 选择本质上是**项目→数据库的映射**，与 cwd 同生命周期，语义自然；
3. S1 会引入**状态与 JSONL 上下文漂移**（会话文件里存着 `Current database: qa_db`，而扩展已无选择），需要额外机制去修，得不偿失；
4. S3 需要按会话清理过期条目，复杂度换来的只是"新会话必须重选"。

> 如果你更看重"每次会话都必须显式选择"的安全性（例如同项目里可能连生产库做排查），选 S3 —— 存储层设计（§2.2）对 S1/S2/S3 都兼容，只换 scopeKey 的取值来源。**这是开放问题 A1，需要你拍板。**

### 2.2 存储设计（推荐 S2）

新文件 `state/workspace-store.ts`（纯函数 + 注入路径，与 `state/extension-toggle.ts` 同风格，可单测）：

```ts
/** 一条工作空间选择记录（与现有 WorkspaceState 一致，增加 updatedAt 便于排查）。 */
export interface WorkspaceRecord {
  environment: string;
  connectionId: string;
  database: string;
  updatedAt: string; // ISO-8601
}

/** 文件格式（v1）：cwd → 选择。 */
interface WorkspaceFileV1 {
  version: 1;
  workspaces: Record<string, WorkspaceRecord>;
}

export function loadWorkspaceRecord(filePath: string, scopeKey: string): WorkspaceRecord | null;
export function saveWorkspaceRecord(filePath: string, scopeKey: string, rec: WorkspaceRecord): void;
/** 规范化 scope 键：ctx.cwd → realpath（存在时），否则 path.resolve。 */
export function normalizeScopeKey(cwd: string): string;
```

落盘形态（`~/.pi/database/workspaces.json`）：

```json
{
  "version": 1,
  "workspaces": {
    "/Users/zheng/code/pi-db-query": {
      "environment": "test",
      "connectionId": "qa",
      "database": "qa_db",
      "updatedAt": "2025-09-11T13:31:00.000Z"
    }
  }
}
```

设计选择与理由：

- **单文件 + cwd 为键**（而不是"每项目一个文件"）：可读、可手工修、备份语义与 `~/.pi/database` 一致；文件名不必做路径哈希。
- **写入用原子写**（临时文件 + `rename`，复用 `extension-toggle.ts:31` 的既有写法）：修掉 §1.1 的"半截 JSON"隐患；放弃"后写者胜"以外的成本为零。
- **容错**：文件缺失/损坏/版本不认识 → 返回 `null`（等价"未选择"），不抛错（与 `readToggle` 的容错策略一致）。
- **不清理旧条目**：每个 cwd 一条、数百字节；cwd 不存在时可选择性惰性清理，但无实测需求不做（AGENTS.md：没有实测需求就不要引入缓存层）。

**迁移**：启动时若发现旧 `workspace.json` 存在，将其重命名为 `workspace.json.legacy`（保留可查），**不把旧值播种到任何项目**。理由：旧值是全局的，播种到"第一个打开的项目"是魔法行为，播种到所有项目等于复现已修复的泄漏。代价：升级后每个项目需重选一次。

### 2.3 接线：谁提供 cwd

改动集中在三处，命令与工具层零改动（它们只在拿到 `ws` 之后使用 `ws.current`）：

```ts
// index.ts
const getWorkspace = (scopeKey?: string): DatabaseWorkspaceService => {
  // 首次创建时定键。兜底用进程 cwd —— 生产路径下 scopeKey 恒有值，
  // 不会出现"无键 → 整场会话静默不持久化"的隐式降级。
  workspace ??= new DatabaseWorkspaceService(undefined, undefined, {
    scopeKey: scopeKey ?? normalizeScopeKey(process.cwd()),
  });
  return workspace;
};

pi.on("session_start", (_event, ctx) => {
  if (!enabled) return;
  applyInitialToolSet(pi);
  const ws = getWorkspace(normalizeScopeKey(ctx.cwd)); // ← 首次创建即带上项目键
  restoreStatusBar(ws, ctx);
  statusNotifier.notifyIfChanged(); // 见 Part B
});
```

```ts
// state/workspace.ts —— 第三参为可选，保持既有测试与调用点不变
constructor(
  state?: StateStore,
  manager?: DatabaseConnectionManager,
  opts?: { scopeKey?: string },
) {
  this.store = state ?? new StateStore();
  this.scopeKey = opts?.scopeKey ?? null; // 省略 = 不持久化（S1 语义 / 既有测试）
  ...
  this.currentState = this.scopeKey
    ? loadWorkspaceRecord(this.store.workspaceFile, this.scopeKey)
    : null;
}

switchTo(environment: string, connectionId: string, database: string): void {
  this.currentState = { environment, connectionId, database };
  if (this.scopeKey) {
    saveWorkspaceRecord(this.store.workspaceFile, this.scopeKey, { ...this.currentState, updatedAt: new Date().toISOString() });
  }
}
```

- `StateStore.workspaceFile` 改名指向 `workspaces.json`（旧 `workspace.json` 仅用于迁移检测）；保留该 getter 名以减少 diff，新增 `legacyWorkspaceFile`。
- `DatabaseWorkspaceService` 保持 facade 完整性：命令层不感知 scopeKey，也不感知文件格式。
- 切换后 `switch.ts` 的行为不变（仍是 `switchTo` + 状态栏 + 注入），但注入走 Part B 的去重入口。

### 2.4 影响范围（确认无隐性耦合）

| 受影响面                           | 是否需改 | 说明                                                    |
| ---------------------------------- | -------- | ------------------------------------------------------- |
| `restoreStatusBar` / `statusLabel` | 否       | 只读 `current`                                          |
| `resolveTarget` → 全部读写路径     | 否       | 只读 `current`                                          |
| `getDatabases()` 默认连接          | 否       | 只读 `current`                                          |
| 历史/收藏/关系（`state.db`）       | 否       | 全局库；历史行带 `database` 字段，天然按库过滤（见 §5） |
| `connections.yaml`                 | 否       | 用户级凭据清单，跨项目共享是**特性**（见 §5）           |
| `extension.json`（`/db on\|off`）  | 否       | 现状全局；见开放问题 A2                                 |

### 2.5 测试计划

- 新增 `__tests__/workspace-store.test.ts`（纯函数）：
  - 两个 scopeKey 互不干扰（隔离）；
  - 同 key 覆盖写、原子写后文件为合法 JSON；
  - 文件缺失 / JSON 损坏 / 版本不认识 → `null`；
  - 迁移：存在 `workspace.json` 时被改为 `workspace.json.legacy`，且不产出任何项目条目；
  - `normalizeScopeKey`：符号链接与真实路径归一到同一键。
- 扩展 `__tests__/workspace-target.test.ts`：
  - `new DatabaseWorkspaceService(new StateStore(dir), undefined, { scopeKey: "/proj-A" })` 与 `{ scopeKey: "/proj-B" }` 各自独立；
  - 无 `scopeKey` 时 `switchTo` 不落盘（S1 语义可测）。
- 端到端（手工，验收用）：项目 A `/db switch` → 项目 B 开会话 → 状态栏无库；回项目 A → 自动恢复。

### 2.6 决策记录（原开放问题）

- **A1 隔离粒度 = S2（项目 cwd 键控）**——已确认。理由见 §2.1；S1 / S3 保留为备选（存储层对三者都兼容，只需更换 scopeKey 的来源）。
- **A2 `/db off` 开关保持全局**：本次不改，避免一次改动横跨两个语义（`docs/extension-toggle.md` 明确其对所有项目生效）。
- **A3 只做原子写**：不引入多会话文件监听；同项目并发切换仍是"后写者胜"，丢的是一次切换而非文件。

## 3. Part B：无连接时静默

### 3.1 改动点

1. **删除 `sendConfiguredHint` 分支**（`commands/llm-context.ts:27-43` 及其在 `sendDbStatus` 的 `else if` 分支）。

   净效果：未选择数据库时**零注入**，与"完全未配置"行为一致。信息不丢：模型真正需要用库时会撞到 `resolveTarget` 的错误（`No database selected. Run /db switch first, or pass connection + database explicitly.`），该文案已给出两条出路；主动发现路径是 `db_discover`（懒加载工具）+ 显式 `connection`/`database` 参数，不需要预先告知。

   代价（需你确认可接受）：模型不再主动催用户连库。若你后续希望保留"温和提醒"，正确做法是**只在用户明确问数据库时**才提示 —— 那属于 skill/prompt 文本，不属于会话注入。

2. **注入去重：仅在状态变化时注入**。新增注入入口对象，替换散落的直接调用：

```ts
// commands/llm-context.ts（保持纯模块：不持有状态）
export function buildDbStatusMessage(
  ws: DatabaseWorkspaceService,
): { key: string; content: string } | null {
  if (!ws.isReady) return null; // ← 未选择 = 无消息
  const { environment, connectionId, database } = ws.current!;
  return {
    key: `${environment}/${connectionId}/${database}`,
    content: `Current database: ... Config file: ${ws.configPath}. ...`,
  };
}
```

```ts
// index.ts —— 会话级持有者（工厂随会话重建，天然按会话复位）
export interface DbStatusNotifier {
  notifyIfChanged(): void;
}
const createStatusNotifier = (pi: ExtensionAPI, getWs: () => DatabaseWorkspaceService) => {
  let lastSent: string | null = null;
  return {
    notifyIfChanged() {
      const msg = buildDbStatusMessage(getWs());
      if (!msg || msg.key === lastSent) return;
      lastSent = msg.key;
      pi.sendMessage(
        { customType: "db-active-db", content: msg.content, display: false },
        { deliverAs: "followUp", triggerTurn: false },
      );
    },
  };
};
```

注入点收敛为：`session_start`（`index.ts:61`）、`/db` 面板（`db.ts:101`）、`switch` 成功后（`switch.ts:100`）—— 后两者改为调用注入的 `notifier`，三者共用同一 `lastSent`。效果：

- 反复打开 `/db` 面板不再重复注入；
- `/db on|off` 触发的 reload 因工厂重建而复位，最多再注入一次（可接受）；
- 切换数据库时 key 变化 → 正常注入（维持现状语义）。

3. **面板文案精简**（`db.ts:261-266`）：未连接时的状态行由两行降为一行引导，去掉裸的文件路径（面板中已有 `➕ 添加新连接` 与 `🔄 切换环境/数据库` 两个入口）：
   - 现状：`⚠️  尚未配置数据库连接` + `配置文件：~/.pi/database/connections.yaml`
   - 建议：`未连接数据库 — 选择「🔄 切换环境/数据库」或「➕ 添加新连接」`

   保留该行的理由：这是用户主动打开的面板，且是唯一告知"还没有库"的位置；删掉会让面板显示成空状态。**开放问题 B1**：如果你希望连这一行也去掉，请明说（我会把未连接状态改为仅靠禁用项表达）。

### 3.2 明确不改动（边界）

- **工具错误文案**：模型主动调用 `db_query`/`db_mutate` 而未有选择时的报错，是必要的反馈，不是噪音。
- **用户显式命令的 `notify`**：`/db tables`、`/db schema`、`/db query`、`/db relations` 在未连接时的提示（`tables.ts:13`、`schema.ts:17`、`query.ts:210`、`relations.ts:106`）—— 用户主动操作，保留。
- **状态栏 / widget**：`restoreStatusBar`（`db.ts:391`）已只在 `isReady` 时设置，会话启动期零 UI 噪音，无需改动。
- **`db-active-db` 的内容与时机**：已选择时告知模型当前目标仍必要；仅由去重收敛频次。

### 3.3 测试计划

- 新增 `__tests__/llm-context.test.ts`（当前该模块**无测试**）：
  - 未配置 / 未选择 → `notifyIfChanged()` 不产生任何 `sendMessage`；
  - 已选择 → 恰好一条 `db-active-db`，`display: false`；
  - 连续调用 3 次 → 仅第一条；
  - 状态变化后调用 → 产生新的一条（key 不同）；
  - `switchTo` 清空/改变选择后行为符合预期。
  - 替身：`pi` 用捕获数组的假对象（模块只调用 `pi.sendMessage`，无需 mock 框架）。

### 3.4 决策记录（原开放问题）

- **B1 面板 UI 展示保留、注入去掉**（用户确认）：缺少数据库时允许在 UI 上展示（面板状态行、状态栏），但**不允许**注入任何消息、不进入模型上下文。因此 §3.1 第 3 项的"面板文案精简"**未实施**——现有两行状态（含配置文件路径）原样保留，仅去掉注入。

## 4. 实施顺序与 PR 拆分

1. **PR 1（Part B，独立可先落）**：删除 hint 分支 + 注入去重 + 面板文案精简 + `llm-context.test.ts`。
   - 收益立即可见：上下文不再有催办注入，`/db` 反复打开不再累积重复消息。
2. **PR 2（Part A）**：`workspace-store.ts` 新模块 + 迁移 + facade 第三参 + 接线 + 测试。
   - 依赖 A1 决策；与 PR 1 只在 `index.ts`/`llm-context.ts` 的 `session_start` 段有轻微重叠，建议串行合并以避免冲突。

每个 PR 按 AGENTS.md 提交清单执行：`npx tsc --noEmit` → `npx vitest run` → `npm run fmt` → commit（中文 message）。

## 5. 本次不做的相关项（记录判断，避免重复讨论）

- `connections.yaml`、`state.db`（历史/收藏/关系）、`extension.json`（开关）**保持全局**：前者是用户级凭据清单（跨项目共享是特性，类似 `~/.my.cnf`），后两者是数据库维度的数据而非项目维度（历史行带 `connection_id`/`database`，列表已按当前库过滤）。
- schema 无缓存（实时 `information_schema`），故不存在"按项目失效"的派生状态。
- 顺带发现的遗留物（不影响本次改造）：`~/.pi/database/schema/` 是旧缓存时代的残留（当前代码不再写入）；`history.db-shm`/`history.db-wal` 是迁移到 `state.db` 前的残留（`state-store.ts:28` 只重命名 `.db`）。

## 6. 附：本次验证用的实证输出

问题 1（跨项目读取同一份状态）：

```
A cwd: /private/var/.../scratch-projA-x9mkDm -> current: null
B cwd: /private/var/.../scratch-projB-4qdEh0 -> current: { environment: 'test', connectionId: 'qa', database: 'qa_db' }
```

问题 2（case A 注入 / case B 不注入）：

```
CASE A: [{ "customType": "db-hint", "content": "Database connections are configured but no database is selected. Tell the user to run /db switch to connect. ...", "display": false }]
CASE B (empty config): []
CASE C: [{ "customType": "db-active-db", "content": "Current database: qa_db (connection: qa, environment: test). ...", "display": false }]
```

## 7. 实施记录（as-built）

### 7.1 改动清单

| 文件                                      | 改动                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/workspace-store.ts`（新）          | `WorkspaceState` / `WorkspaceRecord` / v1 文件格式 / `normalizeScopeKey`（realpath 归一）/ `loadWorkspaceRecord` / `saveWorkspaceRecord`（tmp + rename 原子写）/ `archiveLegacyWorkspace` |
| `state/state-store.ts`                    | `workspaceFile` → `workspaces.json`；新增 `legacyWorkspaceFile`（迁移源）                                                                                                                 |
| `state/workspace.ts`                      | 构造第三参 `opts?: { scopeKey?: string }`；删本地 load/save；`switchTo` 按 key 写入；构造时归档旧文件；新增 `toState()` 收窄记录                                                          |
| `commands/llm-context.ts`                 | 删 `sendActiveDb` / `sendConfiguredHint` / `sendDbStatus`；新增 `buildDbStatusMessage`（未选中 → null）+ `createDbStatusNotifier`（会话内去重）                                           |
| `index.ts`                                | `getWorkspace(scopeKey?)` 首次创建定键；`session_start` 用 `normalizeScopeKey(ctx.cwd)`；创建 `statusNotifier` 并注入命令层                                                               |
| `commands/db.ts`                          | `registerDbCommand` 增加 `statusNotifier` 参数；面板入口与 `dispatchAction` 改用它                                                                                                        |
| `commands/switch.ts`                      | `handleSwitch(ctx, ws, notifier)`（原 `pi` 参数仅用于注入，已移除）                                                                                                                       |
| `__tests__/workspace-store.test.ts`（新） | 隔离 / 覆盖写 / 原子写 / 容错 / 符号链接归一 / 归档幂等                                                                                                                                   |
| `__tests__/workspace-scope.test.ts`（新） | facade 级：两项目互不干扰 / 同项目继承 / 无 key 不落盘 / 旧文件不播种                                                                                                                     |
| `__tests__/llm-context.test.ts`（新）     | 未配置 → 零注入；**已配置未选择 → 零注入**；已选择 → 恰好一条；重复调用去重；切库后重发；回到未选择复位                                                                                   |

### 7.2 与设计的偏差（3 处，均为实施中发现）

1. **去掉 `updatedAt` 泄漏**：`loadWorkspaceRecord` 返回的 `WorkspaceRecord` 直接赋给 `currentState` 会让 `ws.current` 多带一个持久层字段（被 `workspace-scope.test.ts` 的往返断言抓到）。改为在边界用 `toState()` 收窄，`current` 仍是三字段。
2. **注入器落在 `commands/llm-context.ts`**（而非 index.ts 内联），与文档构建同址，便于单测；`lastSent` 随扩展实例（≈会话）生命周期，`/reload` 后最多重发一次。
3. **面板文案未精简**（B1 决策），面板中未连接状态的两行展示保持原样。

### 7.3 实测（真实 pi 0.85.1，隔离 HOME + `--session-dir`，未触碰真实状态目录）

| 场景                                          | 期望          | 实测                                                                            |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| 项目 A：已配置未选择（含旧 `workspace.json`） | 零注入 + 归档 | 会话内 `db-*` 消息 **0 条**；`workspace.json.legacy` 生成，无 `workspaces.json` |
| 项目 A：已预置选择                            | 恰好 1 条     | `db-active-db` **1 条**，内容为 `Current database: qa_db ...`                   |
| 项目 B（同一数据目录，不同 cwd）              | 隔离 → 零注入 | `db-*` 消息 **0 条**                                                            |

校验：`npx tsc --noEmit` 通过；`npx vitest run` 303 通过（21 个文件）；`npm run lint` 0 error；`npm run fmt` 已执行。
