/**
 * 会话级"变更免确认"开关 —— 纯内存状态，不落盘。
 *
 * 扩展实例即会话：/new、/resume、/fork、/reload 都会重建实例并重跑工厂
 * （见 docs/workspace-scope-and-status-noise.md §1.1），因此开关默认关闭、
 * 不跨会话携带——这正是安全默认值。开启入口只有 /db auto-approve on
 * （用户或驱动 UI 的自动化），绝不注册为 LLM 工具：命令通道是人的意图，
 * 工具通道是模型输出，给模型自我提权的工具会让确认门失效。
 *
 * 设计记录见 docs/session-auto-approve.md。
 */

/** 会话级开关句柄（工厂创建，命令面与工具层共享同一实例）。 */
export interface SessionAutoApprove {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  /** 会话边界复位为关闭（session_start 显式调用，双保险）。 */
  reset(): void;
}

export function createSessionAutoApprove(): SessionAutoApprove {
  let enabled = false;
  return {
    get enabled(): boolean {
      return enabled;
    },
    setEnabled(next: boolean): void {
      enabled = next;
    },
    reset(): void {
      enabled = false;
    },
  };
}
