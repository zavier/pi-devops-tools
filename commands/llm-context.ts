/**
 * 发给 LLM 的静默上下文消息 —— 唯一构建点。
 *
 * AGENTS.md 要求这些字符串保持英文且稳定；本模块是它们的单一归属。
 * index.ts（session_start）、db.ts（仪表盘）、switch.ts（切换后）共用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

/** 已选择数据库：告知当前目标、配置文件与可用工具。 */
export function sendActiveDb(pi: ExtensionAPI, ws: DatabaseWorkspaceService): void {
  const db = ws.current!;
  pi.sendMessage(
    {
      customType: "db-active-db",
      content:
        `Current database: ${db.database} (connection: ${db.connectionId}, ` +
        `environment: ${db.environment}). Config file: ${ws.configPath}. ` +
        `Use db_query and db_tables to query this database.`,
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}

/** 已配置但未选择数据库：引导用户运行 /db switch。 */
export function sendConfiguredHint(pi: ExtensionAPI, ws: DatabaseWorkspaceService): void {
  pi.sendMessage(
    {
      customType: "db-hint",
      content:
        `Database connections are configured but no database is selected. ` +
        `Tell the user to run /db switch to connect. Config file: ${ws.configPath}.`,
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}

/**
 * 按工作空间状态发送对应消息（active 或 hint）；两者皆无时不发。
 * 会话启动与仪表盘入口共用。
 */
export function sendDbStatus(pi: ExtensionAPI, ws: DatabaseWorkspaceService): void {
  if (ws.isReady) {
    sendActiveDb(pi, ws);
  } else if (ws.isConfigured) {
    sendConfiguredHint(pi, ws);
  }
}

/** 未配置任何连接：triggerTurn 让 AI 主动提议建立第一个连接。 */
export function sendUnconfiguredHint(pi: ExtensionAPI, configPath: string): void {
  pi.sendMessage(
    {
      customType: "db-hint",
      content:
        `No database connections are configured yet. Help the user create their first ` +
        `connection in ${configPath}. Ask for host, port, username, password, and default ` +
        `database name. After the config file is written, tell the user to run /db switch to connect.`,
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
}
