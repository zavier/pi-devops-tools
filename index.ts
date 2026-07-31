import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseWorkspaceService } from "./state/workspace";
import { registerDbCommand, restoreStatusBar } from "./commands/db";
import { registerRenderers } from "./commands/renderers";
import { registerDbTools, applyInitialToolSet } from "./tools/db-tools";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  // 懒初始化：扩展工厂可能运行在从不启动会话的调用中
  // （print 模式、--list-models 等）。将打开 SQLite 和读取
  // connections.yaml 推迟到第一次命令/工具调用或 session_start。
  let workspace: DatabaseWorkspaceService | null = null;
  const getWorkspace = (): DatabaseWorkspaceService => {
    workspace ??= new DatabaseWorkspaceService();
    return workspace;
  };

  // 自定义消息渲染器（紧凑查询结果、纯文本面板）
  registerRenderers(pi);

  // 注册 /db 命令
  registerDbCommand(pi, getWorkspace);

  // 注册 LLM 工具：常驻（db_query, db_tables, db_mutate）+ db_tools
  // loader（按需启用 db_discover, db_list_relations, db_relation——
  // 见 tools/db-tool-catalog.ts）。
  registerDbTools(pi, getWorkspace);

  // 注册内置 skills，使其随扩展被发现。
  // skills/ 位于扩展目录内，包含在 npm 包中。
  pi.on("resources_discover", () => {
    return { skillPaths: [join(baseDir, "skills")] };
  });

  // 会话开始时恢复状态栏
  pi.on("session_start", (_event, ctx) => {
    // 将工具集收窄为常驻工具 + loader。懒工具
    // （db_discover, db_list_relations, db_relation）经 db_tools loader
    // 按需启用，保持 system prompt 精简。
    applyInitialToolSet(pi);
    const ws = getWorkspace();
    restoreStatusBar(ws, ctx);
    // 恢复会话时告知 LLM 当前激活的数据库，
    // 避免它通过一次失败的调用去发现。
    if (ws.isReady) {
      const db = ws.current!;
      pi.sendMessage(
        {
          customType: "db-active-db",
          content: `Current database: ${db.database} (connection: ${db.connectionId}, environment: ${db.environment}). Config file: ${ws.configPath}.`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    } else if (ws.isConfigured) {
      // 已配置但未切换——让 AI 知道，以便协助用户选择数据库。
      pi.sendMessage(
        {
          customType: "db-hint",
          content: `Database connections are configured but no database is selected. Tell the user to run /db switch to connect. Config file: ${ws.configPath}.`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    }
  });

  // 关闭时清理
  pi.on("session_shutdown", () => {
    workspace?.destroy();
    workspace = null;
  });
}
