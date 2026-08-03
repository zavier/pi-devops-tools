/**
 * 数据库工具结果的自定义 TUI 渲染。
 *
 * 默认（折叠）只显示一行摘要（summarizeDbToolResult），用户按
 * ctrl+o（app.tools.expand）展开后展示 content 全文。渲染器是薄层——
 * 文案生成在 tool-result-summary.ts（纯函数，可测试）。渲染器抛错时
 * pi 的 tool-execution 会自动回退到默认渲染，因此无需兜底逻辑。
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import {
  keyHint,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { summarizeDbToolResult, type SummarizableDbTool } from "./tool-result-summary";

/** 渲染上下文的最小结构类型——只取渲染器用到的字段（ToolRenderContext 未从包顶层导出）。 */
interface RenderContext {
  isError: boolean;
}

/** 取结果的第一段文本内容（这些工具只返回文本）。 */
function firstText(result: AgentToolResult<unknown>): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.type === "text" ? block.text : "";
}

/**
 * renderResult 工厂——每个常驻工具注册时传入自己的名字，
 * 渲染器按该工具的 details 形状生成折叠态摘要。
 */
export function dbToolResultRenderer(toolName: SummarizableDbTool) {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component => {
    if (options.isPartial) {
      return new Text(theme.fg("warning", `${toolName} 处理中…`), 0, 0);
    }
    if (context.isError) {
      return new Text(theme.fg("error", firstText(result) || `${toolName} 执行失败`), 0, 0);
    }
    if (options.expanded) {
      return new Text(theme.fg("toolOutput", firstText(result)), 0, 0);
    }
    const summary = summarizeDbToolResult(toolName, result.details);
    if (summary) {
      return new Text(
        theme.fg("muted", summary) + "  " + keyHint("app.tools.expand", "展开"),
        0,
        0,
      );
    }
    return new Text(theme.fg("toolOutput", firstText(result)), 0, 0);
  };
}
