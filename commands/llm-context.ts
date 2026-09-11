/**
 * 发给 LLM 的静默上下文消息 —— 唯一构建点。
 *
 * 两条原则（见 docs/workspace-scope-and-status-noise.md §3）：
 *
 * 1. **只有已有活动数据库时才注入**。未配置连接、或已配置但未选择，都一律
 *    零注入——"没有数据库"是用户的 UI 状态，不是模型需要知道的事实。模型
 *    真要用库时会撞到 resolveTarget 的报错，那里已给出两条出路（/db switch
 *    或显式 connection/database 参数）；主动发现路径是 db_discover。
 * 2. **同一状态每会话只注入一次**：会话内状态不变就不重复占用上下文。
 *    UI 展示（面板状态行、状态栏）不受此约束，那是给人看的。
 *
 * AGENTS.md 要求这些字符串保持英文且稳定；本模块是它们的单一归属。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";

/** 注入入口：面板、switch、session_start 三处共用同一实例。 */
export interface DbStatusNotifier {
  /** 状态变化时把当前目标静默告知模型；未变化或未选择时什么都不做。 */
  notifyIfChanged(): void;
}

/** 待注入的消息 + 用于去重的状态键。 */
interface DbStatusMessage {
  key: string;
  content: string;
}

/**
 * 构建当前状态消息；未选择数据库时返回 null（不注入）。
 *
 * 导出供测试（本模块此前无测试，而"未选择时不许有注入"正是回归点）。
 */
export function buildDbStatusMessage(ws: DatabaseWorkspaceService): DbStatusMessage | null {
  if (!ws.isReady) return null;
  const { environment, connectionId, database } = ws.current!;
  return {
    key: `${environment}/${connectionId}/${database}`,
    content:
      `Current database: ${database} (connection: ${connectionId}, ` +
      `environment: ${environment}). Config file: ${ws.configPath}. ` +
      `Use db_query and db_tables to query this database.`,
  };
}

/**
 * 创建会话级注入器。持有 `lastSent`，随扩展实例（≈会话）生命周期存在：
 * `/reload` 后工厂重跑，最多重新注入一次当前状态，可接受。
 */
export function createDbStatusNotifier(
  pi: ExtensionAPI,
  getWs: () => DatabaseWorkspaceService,
): DbStatusNotifier {
  let lastSent: string | null = null;

  return {
    notifyIfChanged(): void {
      const message = buildDbStatusMessage(getWs());
      if (!message) {
        // 回到"未选择"：复位，使重新选中同一库时能再告知一次。
        lastSent = null;
        return;
      }
      if (message.key === lastSent) return;
      lastSent = message.key;

      pi.sendMessage(
        {
          customType: "db-active-db",
          content: message.content,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    },
  };
}
