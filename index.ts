import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseWorkspaceService } from "./state/workspace";
import { DEFAULT_BASE } from "./state/state-store";
import { readToggle } from "./state/extension-toggle";
import { registerDbCommand, restoreStatusBar } from "./commands/db";
import { registerRenderers } from "./commands/renderers";
import { registerDbTools, applyInitialToolSet } from "./tools/db-tools";
import { sendDbStatus } from "./commands/llm-context";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  // 开关：工厂执行时同步读取（/db on|off 触发 ctx.reload() 后工厂重跑会重新
  // 读取）。禁用时不注册任何 LLM 资源（tools / skills / renderers），只保留
  // 精简版 /db 命令作为重新启用入口——见 docs/extension-toggle.md。
  const enabled = readToggle(DEFAULT_BASE);

  // 懒初始化：扩展工厂可能运行在从不启动会话的调用中
  // （print 模式、--list-models 等）。将打开 SQLite 和读取
  // connections.yaml 推迟到第一次命令/工具调用或 session_start。
  let workspace: DatabaseWorkspaceService | null = null;
  const getWorkspace = (): DatabaseWorkspaceService => {
    workspace ??= new DatabaseWorkspaceService();
    return workspace;
  };

  if (enabled) {
    // 自定义消息渲染器（紧凑查询结果、纯文本面板）
    registerRenderers(pi);

    // 注册 LLM 工具：常驻（db_query, db_tables, db_mutate）+ db_tools
    // loader（按需启用 db_discover, db_list_relations, db_relation——
    // 见 tools/db-tool-catalog.ts）。
    registerDbTools(pi, getWorkspace);
  }

  // 注册 /db 命令（禁用态为精简版，仅响应 on）
  registerDbCommand(pi, getWorkspace, enabled, DEFAULT_BASE);

  // 注册内置 skills，使其随扩展被发现。禁用时返回空——skill 以 XML 块进
  // 系统提示词，连带禁用以保持零上下文。
  // skills/ 位于扩展目录内，包含在 npm 包中。
  pi.on("resources_discover", () => {
    return { skillPaths: enabled ? [join(baseDir, "skills")] : [] };
  });

  // 会话开始时恢复状态栏
  pi.on("session_start", (_event, ctx) => {
    // 禁用：不初始化 workspace、不恢复状态栏、不发消息。
    if (!enabled) return;
    // 将工具集收窄为常驻工具 + loader。懒工具
    // （db_discover, db_list_relations, db_relation）经 db_tools loader
    // 按需启用，保持 system prompt 精简。
    applyInitialToolSet(pi);
    const ws = getWorkspace();
    restoreStatusBar(ws, ctx);
    // 恢复会话时告知 LLM 当前激活的数据库，
    // 避免它通过一次失败的调用去发现。
    sendDbStatus(pi, ws);
  });

  // 关闭时清理
  pi.on("session_shutdown", () => {
    workspace?.destroy();
    workspace = null;
  });
}
