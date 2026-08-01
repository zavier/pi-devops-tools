# 扩展开关设计：Extension Toggle

> 状态：已实施（`/db on|off` 位于 `commands/db.ts`）
> 目标版本：0.9.0

## 1. 背景与目标

扩展被安装后（全局或项目级），其 LLM 工具、`db-explore` skill、状态栏对**所有**用户
（包括不想用数据库功能的人）生效：常驻 4 个工具 + loader 每轮约消耗 1.1–1.3k tokens，
skill 以 XML 块进系统提示词，状态栏常驻 UI。目前没有任何方式在**不卸载扩展**的前提下
关掉这些开销。

**目标**：提供会话内开关——禁用时完全不占用上下文空间（不注册 tools、不发现 skills）、
不在状态栏展示；启用时恢复全部能力。开关通过命令完成，**自动 reload 生效，无需用户
手动操作**。

**分层定位**（与 pi 原生机制互补，不重复造轮子）：

| 层             | 机制                                     | 用途                                   | 代价                                              |
| -------------- | ---------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| 层 1（原生）   | `pi config` / settings.json `-path` 过滤 | "彻底不用"——扩展完全不加载，真零上下文 | 需在 pi config TUI 操作 + `/reload`               |
| 层 2（本设计） | `/db off` \| `/db on`                    | "临时收起"——会话内一键开关             | 扩展仍被加载（工厂执行），但注册表/skills/UI 全空 |

层 2 的独立价值：不用离开会话、不动 settings 文件、不重载其他无关扩展状态（见 4.5 说明
——`ctx.reload()` 会重载全部扩展，这是其固有代价，但比手动 `/reload` 少一步且可编程）。

## 2. 机制确认（pi 0.80 源码 + 文档）

- **`ctx.reload()` 是 `/reload` 的编程等价物**（`docs/extensions.md` → ctx.reload()）：
  触发当前扩展运行时 `session_shutdown` → 重新加载资源 → 以 `reason: "reload"` 重新触发
  `session_start` 与 `resources_discover`。命令 handler 中调用后，旧 `ctx`/`pi` 对象失效，
  reload 之后的代码仍在旧调用帧运行，不得再触碰扩展内存状态。
- **工厂在 reload 时重新执行**：`dist/core/extensions/loader.js` —— `invalidateCache()`
  清空 `extensionCache` 并 `extensionCacheGeneration++`，缓存命中失效 → 扩展模块重新
  jiti 加载、工厂重新运行。因此**工厂时读取开关标志决定注册什么**是可靠的分支点。
- **`resources_discover` 在 reload 时重新触发**（reason: "reload"）→ 禁用时返回空
  `skillPaths`，`db-explore` 自动从系统提示词的 skills XML 块消失，**无需运行时注销 API**
  （pi 无 `unregisterTool` / `unregisterSkill`）。
- **`setActiveTools` 对未注册名静默忽略**（`loader.js`）→ 禁用时不注册 `db_tools` 时，
  即便 session_start 误调 `applyInitialToolSet` 也无害（`db_tools` 被忽略）。
- **会话历史保留**：reload 只重建扩展运行时与系统提示词，不丢 JSONL 会话；历史中旧的
  工具调用记录原样保留（参数未变，无 schema 兼容问题），但工具定义已不在激活集。

## 3. 设计总览

```
┌─ 工厂执行（每次 pi 启动 / /reload）
│    读 ~/.pi/database/extension.json（同步 fs，缺省视为 enabled）
│    ├─ enabled（默认）：现状不变
│    │    注册 renderers / /db 全功能 / 7 工具 + loader / skills 发现
│    └─ disabled：
│          不注册 tools（registerDbTools 不调用）
│          不注册 renderers
│          resources_discover → { skillPaths: [] }
│          注册精简版 /db（仅响应 on）
│          session_start → 空操作（不初始化 workspace、不恢复状态栏、不发消息）
│
└─ /db off：写 { enabled: false } → notify → await ctx.reload()
   /db on ：写 { enabled: true }  → notify → await ctx.reload()
```

原则：

1. **工厂是唯一分支点**——开关状态在工厂时一次性决定注册什么；运行时不做任何
   "补注册/补注销" hack（pi 无注销 API，运行时增删工具会重建提示词且 skills 无法移除）。
2. **reload 是唯一生效通道**——`ctx.reload()` 后一切由工厂重跑自然收敛，用户零操作。
3. **状态读写是纯函数**——路径注入，可单测；工厂读用同步 `node:fs`（毫秒级、无副作用，
   不违反"工厂不启动后台资源"约定）。
4. **默认启用**——不改变现状行为；现有用户升级无感，`pi config`（层 1）负责"彻底不要"。

## 4. 详细设计

### 4.1 开关状态文件（新文件 `state/extension-toggle.ts`，纯函数）

路径：`~/.pi/database/extension.json`（与 StateStore 默认基目录一致，`state-store.ts` 的
`DEFAULT_BASE = ~/.pi/database`）。内容：

```json
{ "enabled": false }
```

```ts
// state/extension-toggle.ts（伪签名，无 pi 依赖、无 I/O 之外副作用）
export function readToggle(baseDir: string): boolean; // 缺失/损坏 → true（默认启用）
export function writeToggle(baseDir: string, enabled: boolean): void; // 原子写（tmp + rename）
export function togglePath(baseDir: string): string;
```

- 缺失文件、JSON 损坏、字段非法 → 一律回退 `enabled: true`（默认启用，容错优先）。
- 原子写（写临时文件后 rename），避免中断留下半截 JSON 导致回退默认。
- 与 StateStore 同目录的好处：备份/清理语义一致，用户只认一个数据目录。

### 4.2 命令：`/db on` / `/db off`（`commands/db.ts` 改造）

- `registerDbCommand(pi, getWorkspace, enabled)` 增加 `enabled` 参数：
  - `enabled === true`：现状不变，SUBCOMMANDS 增加 `on` / `off`；
  - `enabled === false`：注册精简版 `/db`——description 改为
    "Database extension is disabled. Run /db on to enable."，handler 只响应 `on`
    （写标志 → notify → reload），其余子命令提示"扩展已禁用，运行 /db on 启用"；
    `getArgumentCompletions` 只补全 `on`。**不初始化 workspace**（`on` 分支不需要）。
- `on` / `off` handler 共同流程：

```ts
async function handleToggle(enabled: boolean, ctx: ExtensionCommandContext): Promise<void> {
  writeToggle(BASE_DIR, enabled);
  ctx.ui.notify(`数据库扩展已${enabled ? "启用" : "禁用"}，正在重载…`, "info");
  await ctx.reload(); // 必须是 handler 最后一步——旧 ctx 此后失效
}
```

- 禁用时 `/db` 是唯一保留的注册项（命令不进模型上下文，零成本），也是重新启用的入口。

### 4.3 工厂分支（`index.ts` 改造）

```ts
const enabled = readToggle(DB_BASE_DIR); // DB_BASE_DIR = ~/.pi/database

if (enabled) {
  registerRenderers(pi);
  registerDbCommand(pi, getWorkspace, true);
  registerDbTools(pi, getWorkspace);
} else {
  registerDbCommand(pi, getWorkspace, false);
}

pi.on("resources_discover", () => {
  return { skillPaths: enabled ? [join(baseDir, "skills")] : [] };
});

pi.on("session_start", (_event, ctx) => {
  if (!enabled) return; // 禁用：不初始化 workspace、不恢复状态栏、不发消息
  applyInitialToolSet(pi);
  const ws = getWorkspace();
  restoreStatusBar(ws, ctx);
  // …db-active-db / db-hint 消息（现状不变）
});

pi.on("session_shutdown", () => {
  /* 现状不变（destroy 对未初始化 workspace 无害） */
});
```

- `enabled` 是工厂闭包内的常量，reload 后新工厂重新读取——不需要任何响应式更新机制。
- 禁用分支 `session_start` 直接 return：连 `getWorkspace()`（打开 SQLite、读
  connections.yaml）都不执行——用户可能根本没有数据库配置。

### 4.4 启用/禁用效果对照

| 资源                                           | 启用                                         | 禁用                                           |
| ---------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| LLM 工具（db_query 等 7 个 + db_tools loader） | 注册，session_start 收窄为常驻 4 个 + loader | **不注册**（`getAllTools()` 中也不存在）       |
| `db-explore` skill                             | 发现，进系统提示词 XML 块                    | `resources_discover` 返回空                    |
| 状态栏 / widget                                | session_start 恢复                           | 不设置（且 reload 时旧状态栏随运行时销毁清除） |
| `/db` 命令                                     | 全功能                                       | 精简版（仅 `on`）                              |
| renderers                                      | 注册                                         | 不注册                                         |
| `db-active-db` / `db-hint` 消息                | 会话开始发送                                 | 不发送                                         |
| workspace（SQLite/connections.yaml）           | 首次使用时初始化                             | 从不初始化（数据文件保留不动）                 |

### 4.5 reload 的固有代价（接受并在 README 说明）

| 代价               | 说明                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| 所有扩展被重载     | `ctx.reload()` 等价 `/reload`：其他扩展也经历 shutdown + 重跑。开关是低频操作，可接受         |
| 系统提示词重建一次 | 工具集变化必然重建，前缀缓存失效一轮（开关操作本身无法避免）                                  |
| 懒工具激活集复位   | reload → session_start → `applyInitialToolSet` 回到最小集，与"重进会话回到最小集"现有设计一致 |
| 旧 ctx 失效        | handler 中 reload 必须是最后一步（文档明确）                                                  |

## 5. 改动清单

| 文件                                 | 状态 | 内容                                                                         |
| ------------------------------------ | ---- | ---------------------------------------------------------------------------- |
| `state/extension-toggle.ts`          | 新增 | `readToggle` / `writeToggle` / `togglePath` 纯函数（路径注入）               |
| `__tests__/extension-toggle.test.ts` | 新增 | 见 8.1                                                                       |
| `commands/db.ts`                     | 修改 | `registerDbCommand` 增加 `enabled` 参数；`on`/`off` 子命令；禁用分支精简注册 |
| `index.ts`                           | 修改 | 工厂读标志分支注册；`resources_discover` / `session_start` 条件化            |
| `README.md`                          | 修改 | 新增"启用/禁用"小节：`/db on` `/db off`、`pi config` 分层说明、reload 代价   |
| `docs/extension-toggle.md`           | 新增 | 本文档                                                                       |

## 6. 边界情况与决策

| 场景                                     | 行为                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 标志文件缺失 / JSON 损坏                 | 回退 `enabled: true`（默认启用，容错优先）                                         |
| 工厂跑在无会话调用（`--list-models` 等） | `readToggle` 是同步小文件读，无副作用，不违反懒初始化约定                          |
| 禁用时 `/db on` 被调用                   | 只写标志 + reload，不初始化 workspace（无需数据库配置）                            |
| 禁用时用户误调其他子命令                 | 提示"扩展已禁用，运行 /db on 启用"                                                 |
| 会话中途 /db off                         | 历史保留；旧工具调用记录留在历史中（工具定义已移除，模型不会重放调用，无兼容问题） |
| 已配置/已连接数据库时禁用                | 连接选择与数据保留在 connections.yaml / state.db，**不删数据**；重新启用后一切恢复 |
| 其他扩展被 reload                        | 接受（4.5），README 说明                                                           |
| 并发写标志                               | 单用户 CLI 命令串行，不处理                                                        |
| 用户想"彻底不用"                         | 层 1：`pi config` 禁用（扩展不加载，连工厂都不跑）                                 |
| `enabled` 与 `pi config` 同时存在        | 层 2 是层 1 的子集：被 pi config 禁用时本扩展根本不加载，层 2 不生效               |

## 7. 不做的事（范围保护）

- **不**做运行时 `unregisterTool` / skill 注销 hack——pi 无此 API，reload 统一解决。
- **不**做"部分禁用"（只禁工具留命令等）——开关是整体语义：tools + skills + 状态栏 +
  renderers 连带。
- **不**改 `sql-policy.ts` / `DatabaseWorkspaceService` / 工具 execute——禁用只是"不注册"，
  已注册路径零改动。
- **不**引入新依赖；标志读写用 `node:fs`。
- **不**把开关状态放进 connections.yaml（那是用户连接配置）或 StateStore（工厂时读要开
  SQLite，过重）。

## 8. 验收清单

1. `npx tsc --noEmit`、`npx vitest run`、`npm run lint`、`npm run fmt:check` 全绿。
2. `__tests__/extension-toggle.test.ts`：临时目录注入——缺失回退 true、`{enabled:false}`
   读 false、损坏 JSON 回退 true、`writeToggle` 往返。
3. 手动冒烟（pi 交互会话，启用态基线不变）：
   - `/db off` → 自动 reload → 状态栏消失；`/tools` 中无任何 db 工具；`/skill` 中无
     db-explore；`/db` 补全只剩 `on`；`/db tables` 提示已禁用。
   - `/db on` → 自动 reload → 状态栏恢复；常驻工具 + loader 回归；db-explore 可发现。
   - 开关往返后会话历史保留，懒工具激活集回到最小集。
   - 禁用状态下 `~/.pi/database/` 的 connections.yaml / state.db 文件未被触碰。
4. 升级兼容：已有用户（无标志文件）升级后行为与现状完全一致。

## 9. 任务拆分（依赖顺序）

1. `state/extension-toggle.ts` 纯函数 + `__tests__/extension-toggle.test.ts`
2. `commands/db.ts`：`enabled` 参数 + `on`/`off` 子命令 + 禁用分支精简注册
3. `index.ts`：工厂分支 + `resources_discover` / `session_start` 条件化
4. README 更新（启用/禁用小节 + 分层说明 + reload 代价）
5. 全量校验（check/test/lint/fmt + 手动冒烟 + 升级兼容确认）

> 上下文收益：禁用态每轮省 ~1.1–1.3k tokens（常驻工具）+ skills XML 块 + 状态栏/消息
> 噪声；启用态与现状完全一致，零回归。
