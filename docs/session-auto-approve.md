# 会话级变更免确认（Session Auto-Approve）

> 状态：**已实施**。`/db auto-approve [on|off]` 位于 `commands/auto-approve.ts`。
>
> 定位：`db_mutate` 默认每次写操作弹人工确认（见 [mutation-tool-design.md](./mutation-tool-design.md)）；
> 本机制为自动化/批量场景提供**会话级**的临时免确认，默认关闭、纯内存、随会话结束复位。

## 1. 背景与目标

`db_mutate` 的确认门（`executeMutationWithApproval` 注入的 confirm 回调）在无人值守场景下无法工作：

- `-p` / `--mode json`：pi 的 UI 是 no-op，`ctx.ui.confirm` 返回 `false`，写操作实际总是被拒；
- RPC：confirm 会转成 `extension_ui_request` 协议，客户端可以程序化应答（这是 RPC 自动化的正路，无需本机制）；
- TUI 里由自动化（tmux 按键、脚本驱动）自己跑：需要一个**会话内可显式打开的开关**。

目标：提供会话级"变更免确认"，满足三个约束——**默认关闭**、**显式授权**、**状态可见**。

## 2. 设计决策

| 决策     | 结论                               | 理由                                                                                                                                                                                                                                  |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 作用域   | **会话级**（纯内存，不落盘）       | 扩展实例即会话：`/new`、`/resume`、`/fork`、`/reload` 都重建实例并重跑工厂（见 [workspace-scope-and-status-noise.md](./workspace-scope-and-status-noise.md) §1.1）。内存态自动获得"默认关闭 + 新会话复位"，不会出现"忘了关"的持久状态 |
| 默认值   | 关闭                               | fail-safe；缺失/异常一律视为关闭                                                                                                                                                                                                      |
| 唯一入口 | `/db auto-approve on`（命令面）    | 命令通道是人的意图；**绝不注册为 LLM 工具**——否则模型（或被 prompt injection 触发的模型）能自我提权，确认门失效                                                                                                                       |
| 开启确认 | 需要二次确认（`ctx.ui.confirm`）   | 开启即提权；关闭不需要确认                                                                                                                                                                                                            |
| 作用范围 | 本会话内全部连接                   | 用户当前一般不会连接线上库；需要更细粒度（连接白名单）时再演进                                                                                                                                                                        |
| 审计     | 状态栏 + 面板状态行 + 工具结果标注 | 免确认是"静默执行"的高风险形态，必须在 UI 与工具结果两处留痕                                                                                                                                                                          |

**与 pi `--approve` 的区别**：那是项目信任开关（是否加载项目级资源），与本机制语义无关，不要混用。

## 3. 生命周期

```
工厂执行（每次 pi 启动 / /reload）
  └─ createSessionAutoApprove()        ← 内存态，enabled = false
       ├─ 注入 registerDbCommand       → /db auto-approve on|off 读写
       └─ 注入 registerDbTools         → db_mutate 的 confirm 回调读取

session_start（新会话 / resume / fork / reload）
  ├─ autoApprove.reset()               ← 双保险：复位为关闭
  └─ applyWorkspaceStatus(ctx, ws, …)  ← 重建状态栏/widget（复位后无免确认后缀，零噪音）

db_mutate 执行
  ├─ enabled = false → showMutationConfirm(ctx, req)   ← 现状不变
  └─ enabled = true  → 直接放行；结果文本标注「免人工确认」，
                       details 带 autoApproved: true / approvalSource: "session"
```

**边界（明确不做）**：

- `-p` / `--mode json` 下 `/db` handler 因 `!ctx.hasUI` 直接返回——headless 通道**用不了**本开关。若将来需要，应加**进程级**显式授权（如 `--db-auto-approve=connId` 白名单），而不是把本开关做成持久配置。
- 不提供"单次绕过"参数（`--force` 式）；免确认只能来自显式打开的会话。
- 模型不可自行开启：不给 LLM 任何写入该状态的工具。

## 4. 交互与展示

```bash
/db auto-approve        # 查看当前状态（默认：关闭）
/db auto-approve on     # 开启（弹确认框二次确认）
/db auto-approve off    # 关闭
```

| 位置            | 行为                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态栏 + widget | 与连接信息**合并为同一个标签**（`db-workspace`），仅开启时追加 `• 免确认` 后缀：状态栏 `🗄 test/qa_db • 免确认`、widget `🗄 test/qa_db  @local • 免确认`。pi footer 按 key 排序、空格拼接多个 extension status，拆成双 key 会得到错位显示；单一组合标签才能得到 `• ` 分段效果（对标 pi 自带 `8 pkgs • ⏸ auto-update off`）。后缀不带图标：状态行整体被 pi 渲染为 dim，emoji 只增添宽度不提供警示色，`免确认` 三字已足够表意 |
| `/db` 面板      | 状态行始终展示（`🔓 变更免确认：已开启（本会话）` / `🔒 变更免确认：关闭`），开启用 warning 色；面板操作列表提供「🔓 变更免确认」入口（已开启则选择即关闭）                                                                                                                                                                                                                                                                 |
| 工具结果        | 免确认执行的写操作在文本中标注「免人工确认」，`details.autoApproved = true`、`approvalSource = "session"`                                                                                                                                                                                                                                                                                                                   |
| LLM 上下文      | **不注入**。审批是人的策略，模型不需要知道；保持 `db_mutate` 工具描述稳定                                                                                                                                                                                                                                                                                                                                                   |

## 5. 安全边界

| 风险         | 缓解                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| 模型自我提权 | 开关只在命令面；工具层只读                                                                                    |
| 忘记关闭     | 纯内存 + `session_start` 复位；`/reload`、`/new`、`/resume` 后自动关闭                                        |
| 误触开启     | 二次确认弹窗；状态栏常驻警示                                                                                  |
| 静默写无痕迹 | 工具结果标注 + `details` 审计字段；建议给自动化连接配最小权限 DB 账号（真正的硬边界在 `GRANT`，不在扩展开关） |
| 批量连写刷屏 | 不逐条 notify；状态栏常驻 + 结果标注已足够                                                                    |

## 6. 实施清单

| 文件                                   | 内容                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `state/mutation-approval.ts`           | 新增：`createSessionAutoApprove()` 纯内存状态（getter / setEnabled / reset）                                               |
| `commands/auto-approve.ts`             | 新增：面板状态行、`handleAutoApprove`（on 二次确认），切换后刷新合并状态                                                   |
| `commands/switch.ts`                   | `dbStatusLabel` / `dbWidgetLine` / `applyWorkspaceStatus`：连接信息 + 免确认后缀的单一组合标签，状态切换与 /db switch 共用 |
| `index.ts`                             | 工厂创建并注入；`session_start` 复位 + `applyWorkspaceStatus`                                                              |
| `commands/db.ts`                       | `auto-approve` 子命令、补全（on/off）、面板状态行与仪表盘入口                                                              |
| `tools/db-tools.ts`                    | `db_mutate` confirm 回调读取开关；结果标注免确认                                                                           |
| `__tests__/mutation-approval.test.ts`  | 状态默认关闭 / 切换 / reset / 实例隔离                                                                                     |
| `__tests__/auto-approve.test.ts`       | 命令面：裸命令、on 确认/取消、off、非法参数、状态栏同步                                                                    |
| `__tests__/db-mutate-approval.test.ts` | 工具层：关闭走人工确认（拒绝分支）、开启跳过确认并标注                                                                     |

## 7. 验收清单

1. `npx tsc --noEmit`、`npx vitest run`、`npm run lint`、`npm run fmt:check` 全绿。
2. 交互冒烟：`/db` 面板显示免确认状态 → `/db auto-approve on` 弹确认 → Enter 后状态栏连接信息出现 ` • 免确认` 后缀 → AI 写操作不弹窗且结果标注免确认 → `/db auto-approve off` 后后缀消失、恢复弹窗。
3. 会话边界：开启后 `/reload`（或 `/new`）→ 免确认后缀消失、写操作恢复弹窗。
4. RPC：`prompt` 发 `/db auto-approve on` 可行（`hasUI === true`）；`-p` / `json` 下命令 no-op，写操作保持 fail-closed。
