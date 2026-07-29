# pi-devops-tools UX 改造方案

> 基于 [pi TUI 文档](https://docs.pi.dev/tui)、[extensions.md](https://docs.pi.dev/extensions) 和原始设计文档
> （[design.md](../docs/superpowers/specs/2026-07-26-pi-devops-tools-design.md)），
> 对 `/db` 命令的人工交互 surface 做系统优化。

## 目录

1. [架构约束与改动范围](#1-架构约束与改动范围)
2. [新共享组件](#2-新共享组件)
3. [P0 改造（核心可用性）](#3-p0-改造核心可用性)
4. [P1 改造（体验断点）](#4-p1-改造体验断点)
5. [P2 改造（一致性与打磨）](#5-p2-改造一致性与打磨)
6. [实施顺序与依赖](#6-实施顺序与依赖)

---

## 1. 架构约束与改动范围

### 1.1 改动边界

```
仅改 commands/ + formatting/ ← 门面（state/workspace.ts）微增方法
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
不动：connection/  schema/  history/  relation/  types.ts
不动：LLM tools（db-tools.ts）— 无需改，渲染器自动升级
```

**原则**：

- 所有 UI 改良通过在 `commands/` 层引入 `ctx.ui.custom()`、`BorderedLoader`、`SelectList` 等 pi 积木实现
- 不破坏 facade 的单一入口结构；如需新方法（如 `ws.getHistoryById()`、`ws.deleteHistory()`），只向 facade **追加**方法，不改现有方法签名
- 现有 custom renderer 保留但增强（query 结果 renderer 增加 expand 提示）
- LLM 工具路径（自然语言 → db_query → 同一 renderer）不受影响

### 1.2 涉及文件

| 文件                          | 改动类型              | 说明                                                       |
| ----------------------------- | --------------------- | ---------------------------------------------------------- |
| `commands/utils.ts`           | 新增 `pickTableFuzzy` | 单步模糊搜索表选择器，替换 `pickTable`                     |
| `commands/renderers.ts`       | 增强                  | query renderer 加 expand 快捷键提示；history renderer 新增 |
| `commands/query.ts`           | 小幅改动              | queryByTable 用 BorderedLoader + 新 picker                 |
| `commands/history.ts`         | 重写                  | transient notify → 可交互 SelectList + 持久消息            |
| `commands/tables.ts`          | 重写                  | 被动列表 → 可操作 table picker                             |
| `commands/db.ts`              | 改写 `/db` 面板       | 纯文本 → 交互式 dashboard menu                             |
| `commands/switch.ts`          | 改动                  | defaultDb 预选确认；加载中 BorderedLoader                  |
| `commands/add.ts`             | 改动                  | 密码掩码 + 测试连接 + 即时校验                             |
| `commands/refresh-schema.ts`  | 改动                  | notify → BorderedLoader                                    |
| `commands/relations.ts`       | 小改                  | pickTable → pickTableFuzzy                                 |
| `commands/schema.ts`          | 小改                  | pickTable → pickTableFuzzy                                 |
| `state/workspace.ts`          | 追加方法              | deleteHistory、getHistoryById（P0-1 需要）                 |
| `docs/ux-refactoring-plan.md` | 新增                  | 本文档                                                     |

### 1.3 依赖的 pi API

| API                                | 来源                              | 用途                                        |
| ---------------------------------- | --------------------------------- | ------------------------------------------- |
| `BorderedLoader`                   | `@earendil-works/pi-coding-agent` | 异步 spinner + Esc 取消                     |
| `DynamicBorder`                    | `@earendil-works/pi-coding-agent` | 自定义组件边框                              |
| `keyHint`                          | `@earendil-works/pi-coding-agent` | expand 快捷键提示                           |
| `SelectList`                       | `@earendil-works/pi-tui`          | 列表选择器（原生 `setFilter` 支持模糊搜索） |
| `SelectItem`                       | `@earendil-works/pi-tui`          | 选择项类型                                  |
| `Container, Text, Spacer`          | `@earendil-works/pi-tui`          | 组合布局                                    |
| `matchesKey, Key`                  | `@earendil-works/pi-tui`          | 键盘事件检测                                |
| `ctx.ui.custom()`                  | `ExtensionCommandContext`         | 自定义 TUI 组件容器                         |
| `ctx.ui.custom({ overlay: true })` | `ExtensionCommandContext`         | 覆盖层（结果翻页）                          |
| `registerMessageRenderer`          | `ExtensionAPI`                    | 自定义消息渲染                              |

---

## 2. 新共享组件

### 2.1 `FuzzyTablePicker` — 单步模糊搜索表选择器

**替换 `pickTable()`（两步：input → select），改为一步完成。**

```typescript
// 文件：commands/utils.ts（新增导出）
// 使用方式：
//   const table = await pickTableFuzzy(ctx, ws, "选择数据表");
//   // → 返回 string | undefined

import { Container, type SelectItem, SelectList, Text, Spacer } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

export async function pickTableFuzzy(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  prompt: string,
): Promise<string | undefined> {
  // 1. 预加载表列表（用缓存，极快）
  let tables: string[];
  try {
    tables = await ws.getTables();
  } catch (err: any) {
    ctx.ui.notify(`加载表列表失败：${err.message}`, "error");
    return undefined;
  }
  if (tables.length === 0) {
    ctx.ui.notify(`${ws.current!.database} 中没有表`, "warning");
    return undefined;
  }

  // 2. 构造 SelectItem[]
  const items: SelectItem[] = tables.map((t) => ({ value: t, label: t }));

  // 3. 自定义组件：Input（过滤） + SelectList（模糊选择）
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();

    // 顶边框
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    // 标题行
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold(`📋 ${prompt}`)) +
          theme.fg("dim", `　${tables.length} 个表 · 输入关键字过滤 · Esc 取消`),
        1,
        0,
      ),
    );

    // 过滤输入行（使用内联 Input 提示）
    let filterText = "";
    const filterLine = new Text(theme.fg("muted", "> "), 1, 0);
    container.addChild(filterLine);

    container.addChild(new Spacer(0));

    // SelectList — 原生支持 setFilter
    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", theme.bold(t)),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    // 底边框
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    // 键盘处理：可打印字符 → 追加过滤文字 → setFilter；Backspace → 删除；Esc → 取消
    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // 可打印 ASCII + 中文 — 追加到过滤文字
        if (data.length === 1 && data >= " ") {
          filterText += data;
          selectList.setFilter(filterText);
          tui.requestRender();
          return;
        }
        // Backspace / Delete — 删除最后一个字符
        if (data === "\x7f" || data === "\x1b[3~") {
          filterText = filterText.slice(0, -1);
          selectList.setFilter(filterText);
          tui.requestRender();
          return;
        }
        // 其余交给 SelectList（上下键 / Enter / Esc）
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result;
}
```

**关键设计点**：

- `SelectList.setFilter()` 是 O(n) 字符串包含匹配（忽略大小写），自动高亮过滤结果
- 过滤输入用 `handleInput` 直接拦截可打印字符，不需要独立的 Input 组件（避免焦点管理复杂度）
- 标题行直接告知操作方式（英文/中文自适应），减少记忆负担
- `noMatch` 主题位：无匹配时显示提示

**影响命令**：`schema.ts`、`query.ts`、`relations.ts`（add + er-diagram），共 4 处。

---

### 2.2 `withLoader` — 统一异步加载态

**通用高阶包装器，复用 BorderedLoader pattern。**

```typescript
// 文件：commands/utils.ts（新增导出）
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * 用 BorderedLoader 包装异步操作，提供 spinner + Esc 取消。
 * 返回 null 表示用户取消。
 */
export async function withLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const result = await ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
    loader.onAbort = () => done(null);

    fn(loader.signal)
      .then((value) => done(value))
      .catch((err) => {
        // 区分用户取消 vs 错误
        if (err.name === "AbortError" || loader.signal.aborted) {
          done(null);
        } else {
          done(null); // 错误由调用方处理
        }
      });

    return loader;
  });

  return result;
}
```

**使用示例**：

```typescript
// query.ts：替换 executeAndDisplay 的裸 await
const result = await withLoader(ctx, "执行查询…", (signal) => ws.executeQuery(sql));
if (!result) return; // 用户取消

// refresh-schema.ts：
const snapshot = await withLoader(ctx, "刷新表结构缓存…", (signal) => ws.refreshSchema());
if (!snapshot) return;
```

---

### 2.3 `HistoryRenderer` — 历史记录持久消息渲染器

**历史条目从 transient notify 升级为持久聊天消息，自带展开/收缩。**

```typescript
// 新增于 commands/renderers.ts

export interface HistoryResultDetails {
  entries: Array<{
    id: number;
    time: string;
    sql: string;
    rows: number;
    elapsed: string;
  }>;
  highlightId?: number; // 刚执行的条目高亮
}

// 注册
pi.registerMessageRenderer<HistoryResultDetails>(
  "db-history-result",
  (message, _options, theme) => {
    const d = message.details;
    if (!d) return undefined;

    const lines: string[] = [];
    lines.push(theme.fg("accent", theme.bold(`📜 查询历史 — ${d.entries.length} 条`)));
    lines.push("");

    for (const e of d.entries) {
      const sql = e.sql.length > 60 ? e.sql.slice(0, 57) + "..." : e.sql;
      const prefix = e.id === d.highlightId ? "→" : " ";
      lines.push(
        theme.fg("muted", `${prefix} ${e.time}`) +
          `  ${theme.fg("dim", sql)}` +
          theme.fg("muted", `  [${e.rows}行 ${e.elapsed}]`),
      );
    }

    return new Text(lines.join("\n"), 1, 0);
  },
);
```

---

## 3. P0 改造（核心可用性）

### 3.1 P0-1：History — 可交互选择 + 重跑动作

**状态**：`commands/history.ts` 当前用 `ctx.ui.notify()` 展示纯文本表格。

**目标**：选择列表 → 选中后可重跑/编辑重跑/收藏/删除。

**交互流程**：

```
/db history [keyword]
  → 加载历史（withLoader）
  → SelectList 展示条目（格式: #ID 时间 SQL摘要 行数 耗时）
     ↑↓ 选择  Enter 选中  Esc 取消
  → 选中后：▶ 重跑 / ✏️ 编辑后跑 / ⭐ 收藏 / 🗑 删除
     • 重跑 → withLoader → displayQueryResult
     • 编辑后跑 → editor(sql) → withLoader → displayQueryResult
     • 收藏 → 调 ws.saveFavorite(name, sql)
     • 删除 → confirm → ws.deleteHistory(id)
```

**需要的 facade 方法追加**：

```typescript
// state/workspace.ts 追加
getHistoryById(id: number): HistoryEntry | undefined {
  return this.history.getById(id);
}

deleteHistory(id: number): boolean {
  return this.history.delete(id);
}
```

**实现要点**：

- `handleHistory` 改为 async，第一步用 `withLoader` 包装 `ws.listHistory(keyword)`
- 构造 `SelectItem[]`：每条 value = `String(entry.id)`，label = 格式化摘要
- SelectList 选择后弹出二级菜单（3-4 项 select）
- 重跑结果用现有 `displayQueryResult`（已有 renderer + 历史保存）
- 完成后可选发送 `db-history-result` 持久消息展示历史列表（LLM 可见、用户可回看）

**代码量**：约 80 行（重写 `handleHistory` + 新增 `historyPicker` 内联逻辑）

---

### 3.2 P0-2：统一异步加载 BorderedLoader

**影响范围**：

| 位置                                   | 当前做法                                | 改后                                      |
| -------------------------------------- | --------------------------------------- | ----------------------------------------- |
| `query.ts` — `executeAndDisplay`       | 裸 await `ws.executeQuery`              | `withLoader(ctx, "执行查询…", ...)`       |
| `switch.ts` — `getDatabases()`         | `ctx.ui.notify("加载...")` 然后裸 await | `withLoader(ctx, "加载数据库列表…", ...)` |
| `refresh-schema.ts`                    | `ctx.ui.notify("正在刷新...")`          | `withLoader(ctx, "刷新表结构缓存…", ...)` |
| `relations.ts` — `discoverForeignKeys` | 裸 await                                | `withLoader(ctx, "同步外键…", ...)`       |

**注意事项**：

- `executeQuery` 的 `AbortSignal` 需传递到 `DatabaseConnectionManager`：MySQL2 支持 `connection.destroy()` 中断超时查询？当前 facade 不传递 signal → **不做深度中断**（改动太大），只做 UI 层取消（用户按 Esc 后不展示结果，但 MySQL 查询在后台继续）
- `getDatabases`：同样不做深层中断，仅 UI 取消
- 如果未来需要真正的 Abort，可在 facade 的 `executeQuery` 加 `signal?: AbortSignal` 参数——本阶段不做

---

### 3.3 P0-3：单步模糊表选择器

**改动**：

1. `commands/utils.ts`：新增 `pickTableFuzzy`（见 §2.1），保留 `pickTable` 为 deprecated 别名（渐进替换）
2. 以下文件将 `pickTable` 替换为 `pickTableFuzzy`：
   - `commands/schema.ts` — `handleSchema` 的 tableArg 分发
   - `commands/query.ts` — `queryByTable` 的预选表 / 裸调
   - `commands/relations.ts` — `handleRelationsAdd` 源表/目标表选择、`handleRelationsERDiagram` 表选择

**兼容**：`pickTable` 保留 exported（向后兼容），内部加 `@deprecated` 注释。

---

## 4. P1 改造（体验断点）

### 4.1 P1-1：`/db` 面板 → 交互式 Dashboard

**当前**：`/db` 无参数 → `showWorkspacePanel` 发送 `db-workspace-panel` 消息（纯文本）。

**目标**：保持 LLM context（`display: false` 发送静默消息），人看交互式面板。

**组件设计** — `WorkspaceDashboard`：

```
┌──────────────────────────────┐
│  🗄 数据库工作区              │  ← DynamicBorder(accent)
│                              │
│  📡 环境：test               │  ← 状态区（theme.fg("dim")）
│     ⚡ 连接：qa (10.0.x.x)   │
│     🗃️  数据库：mysql        │
│     📦 缓存：48 个表         │
│                              │
│  ─── 操作 ────────────────  │
│  > 🔄 切换环境/数据库        │  ← SelectList（↑↓ 选择 Enter 执行）
│    📋 浏览数据表              │     选中后执行对应 handler
│    🔍 查看表结构              │
│    💬 SQL 查询               │
│    📜 查询历史               │
│    ⭐ 收藏查询               │
│    🔗 表关联关系             │
│    🏗️ ER 图                  │
│    🔄 刷新表结构缓存         │
│                              │
│  Esc 退出                     │
└──────────────────────────────┘
```

**实现**：

- 调用 `ctx.ui.custom` 构建组件
- `SelectList` 的 `onSelect` 回调：
  ```typescript
  const actions: SelectItem[] = [
    { value: "switch", label: "🔄 切换环境/数据库" },
    { value: "tables", label: "📋 浏览数据表" },
    // ...
  ];
  selectList.onSelect = (item) => done(item.value);
  ```
- `db.ts` 的 handler 里：`const action = await showDashboard(ctx, ws)` → 根据 action dispatch 到对应 handler（`handleSwitch` / `handleTables` 等）
- 同时发送静默消息给 LLM（现有文本面板内容，`display: false`）

**代码量**：约 100 行（新组件）+ 30 行（`db.ts` handler 改动）

---

### 4.2 P1-2：查询结果浏览增强

**问题**：TUI 内 20 行截断后无法看到剩余行；关联表折叠后不知如何展开。

**方案 A（轻量）** — 增强现有 renderer：

- 截断行提示改为：`… 还有 80 行（未显示，可追加 LIMIT n OFFSET m 翻页，或使用 AI 分析）`
- 关联表折叠行改为：`… 3 个关联表（` + keyHint("app.tools.expand") + ` 展开查看）`

**方案 B（完整）** — 附加滚动 overlay：

- query 结果 renderer 里放一个 `📖 在独立窗口中查看` 入口
- 点击（/command 触发）打开 overlay 的滚动查看器：
  ```
  ┌────────────────────────────────┐
  │  SQL: SELECT * FROM ...        │  ← 固定头
  │  共 100 行 × 8 列 (0.023s)    │
  ├────────────────────────────────┤
  │  (可滚动内容区)                 │  ← 完整结果表
  │  | id | name | ...             │
  │  ...                           │
  ├────────────────────────────────┤
  │  ↑↓ 滚动  PgUp/PgDn 翻页  Esc 关闭 │
  └────────────────────────────────┘
  ```

**推荐**：先做方案 A（10 行改动，立即生效），方案 B 作为 P1 的可选增强（需额外 80 行）。

**实现（方案 A）**：

```typescript
// commands/renderers.ts — db-query-result renderer 改动
// 截断行提示
if (d.totalRows > 20) {
  const hint = keyHint("app.tools.expand", "展开") + " 查看关联表";
  lines.push(
    theme.fg(
      "dim",
      `… 还有 ${d.totalRows - 20} 行（TUI 未展示，LLM 可读；手动加 LIMIT/OFFSET 翻页）`,
    ),
  );
}
// 关联表折叠
if (d.relatedCount > 0 && !expanded) {
  const hint = keyHint("app.tools.expand", "展开查看");
  lines.push("", theme.fg("muted", `… ${d.relatedCount} 个关联表（${hint}）`));
}
```

---

### 4.3 P1-3：`/db add` 三处安全/体验补强

#### a. 密码掩码输入

pi 没有内置的 masked input，需自定义。简易方案：在 `handleInput` 里拦截可打印字符，用 `*` 累加存储真实值。

```typescript
// 内联于 commands/add.ts
async function maskedInput(
  ctx: ExtensionCommandContext,
  prompt: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let password = "";
    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    // ...提示行和遮罩显示...
    // handleInput 拦截可打印字符 → password += data; tui.requestRender()
    // render: 显示 theme.fg("muted", "> " + "*".repeat(password.length))
    // Enter → done(password)
    // Esc → done(null)

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "\r" || data === "\n") {
          done(password);
          return;
        }
        if (data === "\x1b") {
          done(null);
          return;
        }
        if (data === "\x7f") {
          password = password.slice(0, -1);
        } else if (data.length === 1 && data >= " ") {
          password += data;
        }
        tui.requestRender();
      },
    };
  });
}
```

#### b. 测试连接

添加完成后、确认写入前插入一步：`withLoader(ctx, "测试连接…", () => ws.getDatabases(newConnectionId))`

注意：需要先临时写入 config 并 reload 才能测试。流程：

1. 收集完所有字段
2. `ws.createConnection(env, name, cfg)` → 写入 + reload
3. `withLoader(ctx, "🔗 测试连接…", () => ws.manager.getDatabases(name))`
4. 成功 → "✅ 连接成功，发现 N 个数据库" → confirm 最终确认
5. 失败 → "❌ 连接失败：msg" → 确认是否仍保存（或返回修改？→ P1 阶段简单处理：提示失败但仍写入，让用户自己 /db switch 调试）

#### c. 逐字段即时校验

- host：输入后校验格式（非空，不含空格）
- port：`parseInt` + 范围 1-65535，非法时 notify 并重新输入
- username：非空

**改动量**：`add.ts` 约 +50 行。

---

## 5. P2 改造（一致性与打磨）

### 5.1 switch defaultDb 预选确认

```typescript
// commands/switch.ts — Step 3 逻辑改动
if (defaultDb) {
  const useDefault = await ctx.ui.confirm(
    "默认数据库",
    `使用 ${defaultDb}？\n\n选"是"直接连接（推荐），选"否"手动选择。`
  );
  if (useDefault === undefined) return; // Esc 退出
  if (useDefault) {
    database = defaultDb;
  } else {
    // 进入手动选择流程（现有逻辑）
    databases = await ws.getDatabases(connectionId); // 用 withLoader
    const choice = await ctx.ui.select("选择数据库", databases);
    if (!choice) return;
    database = choice;
  }
} else {
  // 没有默认库，直接手动选择
  ...
}
```

### 5.2 widget 合并单行

```typescript
// commands/db.ts — restoreStatusBar
ctx.ui.setWidget(STATUS_KEY, [
  `🗄 ${env}/${database}  @${connectionId}  ⚡ ${cache.tables.length}表`,
]);
```

### 5.3 语言统一

| 位置                        | 当前              | 改为               |
| --------------------------- | ----------------- | ------------------ |
| `history.ts` header         | `═══ History ═══` | `═══ 查询历史 ═══` |
| `renderers.ts` query header | `🗄 查询 — ${db}` | 保持               |
| 其余 notify                 | 已经是中文        | 不变               |

### 5.4 query 入口合并

```typescript
// commands/query.ts — handleQuery 无参数分支
// 当前：select("查询方式", ["📋 选择数据表", "✏️ 输入 SQL"])
// 改后：pickTableFuzzy 的 SelectList 首项插入：
//   { value: "__raw_sql__", label: "✏️ 直接输入 SQL…" }
// 选中 → 进 queryRaw；选中表 → 进 queryByTable(table)
```

注意：`pickTableFuzzy` 需要支持 topItem 选项（或 query 自己构建 SelectList 内联，不走 pickTableFuzzy）。

---

## 6. 实施顺序与依赖

```
Phase 1: 基础设施（无依赖，可并行）
├── task-1f6dfd: P0-3 pickTableFuzzy 组件
└── task-5194c7: 本文档（完成）

Phase 2: P0 核心（依赖 Phase 1）
├── task-f9800b: P0-2 withLoader + BorderedLoader 接入 ← 不依赖 Phase 1
├── task-c953f0: P0-1 History 交互化 ← 依赖 withLoader (P0-2)
└── 将 pickTableFuzzy 接入 schema/query/relations ← 依赖 P0-3

Phase 3: P1 升级（依赖 Phase 2）
└── task-981b26: 全部 P1 改进
    ├── 4.1 Dashboard 面板
    ├── 4.2 查询结果增强（方案 A）
    └── 4.3 /db add 安全增强

Phase 4: P2 抛光（依赖 Phase 3）
└── task-4af34d: 全部 P2 修整
    ├── 5.1 defaultDb 一致性
    ├── 5.2 widget 合并
    ├── 5.3 语言统一
    └── 5.4 query 入口合并
```

**每次改动后验证**：

```bash
cd .pi/extensions/devops-tools
npx tsc --noEmit && npx vitest run
```

**原则**：每完成一个 P0 task 即可交付，不绑定到全部完成。各 task 独立可测。
