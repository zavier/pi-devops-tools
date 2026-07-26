/**
 * /db schema — view table structure (columns + indexes).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { pickTable } from "./utils";

export async function handleSchema(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  table?: string,
): Promise<void> {
  if (!ws.isReady()) {
    ctx.ui.notify("未选择数据库，请先执行 /db switch", "warning");
    return;
  }

  if (!table) {
    const picked = await pickTable(ctx, ws, "选择表");
    if (!picked) return;
    table = picked;
  }

  let result: { columns: Record<string, any>[]; indexes: Record<string, any>[] };
  try {
    result = await ws.getTableSchema(table);
  } catch (err: any) {
    ctx.ui.notify(`加载表结构失败：${err.message}`, "error");
    return;
  }

  const colRows = result.columns.map((c) => {
    const nullable = c.IS_NULLABLE === "YES" ? "N" : "";
    const key = c.COLUMN_KEY === "PRI" ? "PK" : c.COLUMN_KEY === "MUL" ? "FK" : c.COLUMN_KEY === "UNI" ? "UQ" : "";
    const def = c.COLUMN_DEFAULT ?? "";
    const extra = c.EXTRA ?? "";
    const comment = c.COLUMN_COMMENT ?? "";
    const name = (c.COLUMN_NAME as string).padEnd(25);
    const type = (c.COLUMN_TYPE as string).padEnd(16);
    return `  ${name}${type}${nullable.padEnd(4)}${key.padEnd(3)}${def.padEnd(12)}${extra.padEnd(10)}${comment}`;
  });

  const idxMap = new Map<string, string[]>();
  for (const idx of result.indexes) {
    const name = idx.INDEX_NAME as string;
    if (!idxMap.has(name)) idxMap.set(name, []);
    idxMap.get(name)!.push(idx.COLUMN_NAME as string);
  }

  const text = [
    `═══ ${table} — ${ws.current!.database} ═══`,
    "",
    "列：",
    `  ${"Name".padEnd(25)}${"Type".padEnd(16)}Null Key Default     Extra     Comment`,
    `  ${"".padEnd(25)}${"".padEnd(16)}---- --- ---------- ---------- -------`,
    ...colRows,
    "",
    `索引（${idxMap.size}）：`,
    ...([...idxMap.entries()].map(([name, cols]) => {
      const unique = result.indexes.find((i) => i.INDEX_NAME === name)?.NON_UNIQUE === 0 ? " [UNIQUE]" : "";
      return `  ${name}${unique}: ${cols.join(", ")}`;
    })),
    "",
  ].join("\n");

  ctx.ui.notify(text, "info");
}
