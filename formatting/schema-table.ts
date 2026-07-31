/**
 * Schema markdown formatting — pure function shared by the /db schema
 * command and the db_tables LLM tool.
 */

import type { SqlRow } from "../types";

/** Escape pipes so column comments can't break the markdown table. */
function esc(val: unknown): string {
  const s = String(val ?? "");
  return s.replace(/\|/g, "\\|");
}

function keyLabel(key: unknown): string {
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
  columns: SqlRow[],
  indexes: SqlRow[],
): string {
  const lines: string[] = [`### ${table} — ${database}`, ""];

  lines.push("| 列 | 类型 | Null | Key | 默认 | Extra | 注释 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of columns) {
    const nullable = c.IS_NULLABLE === "YES" ? "YES" : "";
    lines.push(
      `| ${esc(c.COLUMN_NAME)} | ${esc(c.COLUMN_TYPE)} | ${nullable} | ${keyLabel(c.COLUMN_KEY)} | ${esc(c.COLUMN_DEFAULT)} | ${esc(c.EXTRA)} | ${esc(c.COLUMN_COMMENT)} |`,
    );
  }

  const idxMap = new Map<string, { cols: string[]; unique: boolean }>();
  for (const idx of indexes) {
    const name = idx.INDEX_NAME as string;
    if (!idxMap.has(name)) idxMap.set(name, { cols: [], unique: idx.NON_UNIQUE === 0 });
    idxMap.get(name)!.cols.push(idx.COLUMN_NAME as string);
  }

  lines.push("", `**索引（${idxMap.size}）**`, "");
  for (const [name, { cols, unique }] of idxMap) {
    lines.push(`- \`${name}\`${unique ? " [UNIQUE]" : ""}: ${cols.join(", ")}`);
  }

  return lines.join("\n");
}
