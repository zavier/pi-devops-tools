/**
 * schema markdown 格式化 —— 由 /db schema 命令和 db_tables LLM 工具共享的纯函数。
 */

import type { SchemaColumn, SchemaIndex } from "../types";

/** 转义竖线，避免列注释破坏 markdown 表格。 */
function esc(val: string | null): string {
  const s = String(val ?? "");
  return s.replace(/\|/g, "\\|");
}

function keyLabel(key: string): string {
  switch (key) {
    case "PRI":
      return "PK";
    case "MUL":
      return "FK";
    case "UNI":
      return "UQ";
    default:
      return "";
  }
}

export function formatSchemaMarkdown(
  table: string,
  database: string,
  columns: SchemaColumn[],
  indexes: SchemaIndex[],
): string {
  const lines: string[] = [`### ${table} — ${database}`, ""];

  lines.push("| 列 | 类型 | Null | Key | 默认 | Extra | 注释 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of columns) {
    const nullable = c.nullable ? "YES" : "";
    lines.push(
      `| ${esc(c.name)} | ${esc(c.type)} | ${nullable} | ${keyLabel(c.key)} | ${esc(c.default)} | ${esc(c.extra)} | ${esc(c.comment)} |`,
    );
  }

  lines.push("", `**索引（${indexes.length}）**`, "");
  for (const idx of indexes) {
    lines.push(`- \`${idx.name}\`${idx.unique ? " [UNIQUE]" : ""}: ${idx.columns.join(", ")}`);
  }

  return lines.join("\n");
}
