/**
 * /db 查询结果文档的统一装配（纯函数，无 pi 依赖）。
 *
 * "查询结果展示哪些元数据、如何排版"只有一个实现，三个消费方从这里取：
 * - tui-zh —— /db query 的 TUI 条目（commands/renderers.ts 映射颜色）
 * - llm-zh —— /db query 的 LLM 消息与 db_query 工具输出
 *
 * 受众差异（标题风格、表格格式器、宽度钳制）内化在本模块；
 * TUI 的 keyHint 提示是 pi 依赖，留在 renderers 层通过 DocLine.hint 追加。
 */

import type { RelatedResult, SqlRow } from "../types";
import { formatTableCompact, formatTableDisplay, formatVerticalFull } from "./result-table";

// ====== 类型 ======

/** 文档单行。style 供 TUI 渲染器映射颜色；LLM 输出忽略。 */
export interface DocLine {
  text: string;
  /** TUI 颜色提示。 */
  style?: "accent" | "dim" | "muted";
  /** TUI 交互提示标记——文本骨架已含，renderers 追加 keyHint 部分。 */
  hint?: "expand-rows" | "expand-related";
}

/** 查询结果文档的输入数据。rows 为原始 SqlRow（纯函数内文本化）。 */
export interface QueryResultDoc {
  database: string;
  /** 工具输出带连接 ID；/db query 消息不带。 */
  connectionId?: string;
  sql: string;
  rowCount: number;
  elapsed: string;
  columns: string[];
  rows: SqlRow[];
  related?: RelatedResult[];
}

export type DocumentAudience = "tui-zh" | "llm-zh";

export interface RenderOptions {
  audience: DocumentAudience;
  /** 仅 tui-zh 使用：自适应终端宽度。 */
  width?: number;
  /** 仅 tui-zh 使用：展开态渲染完整关联表。 */
  expanded?: boolean;
}

// ====== 入口 ======

/** 组装查询结果文档。 */
export function renderQueryDocument(doc: QueryResultDoc, opts: RenderOptions): DocLine[] {
  if (opts.audience === "tui-zh") {
    return renderTui(doc, opts.width ?? 80, opts.expanded ?? false);
  }
  return renderLlm(doc);
}

// ====== TUI（中文，装饰线 + 颜色提示）======

function renderTui(doc: QueryResultDoc, width: number, expanded: boolean): DocLine[] {
  const w = Math.max(width, 40);
  const lines: DocLine[] = [];

  // 信封
  lines.push({
    text: `🗄 查询 — ${doc.database}  ${doc.rowCount} 行 (${doc.elapsed})`,
    style: "accent",
  });
  lines.push({ text: `SQL: ${doc.sql}`, style: "muted" });
  lines.push({ text: "" });

  // 主表
  if (doc.rowCount === 0) {
    lines.push({ text: "（空结果）" });
  } else if (expanded) {
    lines.push(...formatVerticalFull(doc.columns, doc.rows).map((t) => ({ text: t })));
    lines.push({ text: `全部 ${doc.rowCount} 行 × ${doc.columns.length} 列` });
  } else {
    lines.push(
      ...formatTableDisplay({ columns: doc.columns, rows: doc.rows }, w)
        .split("\n")
        .map((t) => ({ text: t })),
    );
    if (doc.rowCount > 20) {
      lines.push(
        { text: "" },
        { text: "… 更多行在 LLM 上下文中", style: "dim", hint: "expand-rows" },
      );
    }
  }

  // 关联表
  if (doc.related && doc.related.length > 0) {
    if (expanded) {
      lines.push({ text: "" }, { text: `📎 关联表（${doc.related.length} 个）`, style: "accent" });
      for (const r of doc.related) {
        lines.push(...relatedTuiSection(r, w));
      }
    } else {
      lines.push({ text: "" }, { text: relatedSummary(doc.related), style: "dim" });
      lines.push({ text: "", style: "dim", hint: "expand-related" });
    }
  }

  return lines;
}

/** 单张关联表的展开态节：标题行 + 关联路径 + 自适应宽度表格。 */
function relatedTuiSection(r: RelatedResult, width: number): DocLine[] {
  const lines: DocLine[] = [{ text: "" }];
  lines.push({ text: `── 📎 关联表 ${r.schema}.${r.table} — ${r.rowCount} 行（${r.elapsed}）──` });
  if (r.joinPath) lines.push({ text: `   路径：${r.joinPath}` });
  lines.push({ text: "" });
  if (r.rows.length > 0) {
    lines.push(
      ...formatTableDisplay({ columns: r.columns, rows: r.rows }, width)
        .split("\n")
        .map((t) => ({ text: t })),
    );
  } else {
    lines.push({ text: "（空结果）" });
  }
  return lines;
}

/** 关联表折叠态摘要——单行紧凑列出所有表名与行数。 */
function relatedSummary(related: RelatedResult[]): string {
  const parts = related.map((r) => `${r.table}（${r.rowCount} 行）`);
  return `📎 关联表：${parts.join("、")}`;
}

// ====== LLM 上下文（中文 markdown，/db query 消息与 db_query 工具共用）======

function renderLlm(doc: QueryResultDoc): DocLine[] {
  const lines: DocLine[] = [{ text: "## 数据库查询结果" }, { text: "" }];
  if (doc.connectionId) lines.push({ text: `**连接**：${doc.connectionId}` });
  lines.push(
    { text: `**数据库**：${doc.database}` },
    { text: `**SQL**：${doc.sql}` },
    { text: `**行数**：${doc.rowCount}（${doc.elapsed}）` },
    { text: "" },
  );

  if (doc.rowCount === 0) {
    lines.push({ text: "（空结果）" });
  } else {
    lines.push({ text: formatTableCompact({ columns: doc.columns, rows: doc.rows }) });
  }

  if (doc.related && doc.related.length > 0) {
    lines.push({ text: "" }, { text: `### 关联表（${doc.related.length} 个）` }, { text: "" });
    for (const r of doc.related) {
      lines.push(
        { text: `### ${r.schema}.${r.table}` },
        { text: `关联路径：${r.joinPath}` },
        { text: `行数：${r.rowCount}（${r.elapsed}）` },
        { text: "" },
      );
      if (r.rows.length > 0) {
        lines.push({ text: formatTableCompact({ columns: r.columns, rows: r.rows }) });
      } else {
        lines.push({ text: "（空结果）" });
      }
      lines.push({ text: "" });
    }
  }

  return lines;
}
