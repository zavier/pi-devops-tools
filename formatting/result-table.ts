/**
 * /db 查询输出的结果表格式化。
 *
 * 导出：
 * - analyzeColumns / ColumnStats —— 列分类（可见 / 全空 / 全同）
 * - layoutColumns —— 自适应列宽打包函数
 * - formatTableDisplay —— 补空格 markdown 表，自适应终端宽度（TUI）
 * - formatTableCompact —— 省 token 的无填充表，带 …[+N] 标记（LLM）
 */

import type { SqlRow } from "../types";

// ====== 类型 ======

export interface ColumnStats {
  visible: string[];
  allNull: string[];
  allSame: { col: string; value: string }[];
}

export interface TableResult {
  columns: string[];
  rows: SqlRow[];
}

// ====== 列分析 ======

export function analyzeColumns(columns: string[], rows: SqlRow[]): ColumnStats {
  const visible: string[] = [];
  const allNull: string[] = [];
  const allSame: { col: string; value: string }[] = [];

  for (const col of columns) {
    let firstVal: any = undefined;
    let firstSet = false;
    let isAllNull = true;
    let isAllSame = true;

    for (const row of rows) {
      const val = row[col];
      if (val !== null && val !== undefined) {
        isAllNull = false;
        if (!firstSet) {
          firstVal = val;
          firstSet = true;
        } else if (String(val) !== String(firstVal)) {
          isAllSame = false;
          break;
        }
      }
    }

    if (isAllNull) allNull.push(col);
    else if (isAllSame) allSame.push({ col, value: String(firstVal) });
    else visible.push(col);
  }

  return { visible, allNull, allSame };
}

// ====== 隐藏列提示 ======

function hiddenNote(stats: ColumnStats, maxWidth = 160): string {
  const NAME_CAP = 30;
  const VAL_CAP = 40;

  const parts: string[] = [];
  if (stats.allNull.length > 0) {
    const sample = stats.allNull
      .slice(0, 3)
      .map((c) => (c.length > NAME_CAP ? c.slice(0, NAME_CAP - 1) + "…" : c))
      .join(", ");
    const trail = stats.allNull.length > 3 ? "，…" : "";
    parts.push(`已隐藏 ${stats.allNull.length} 列（全为 NULL）：${sample}${trail}`);
  }
  if (stats.allSame.length > 0) {
    const sample = stats.allSame
      .slice(0, 2)
      .map((s) => {
        const v = s.value.length > VAL_CAP ? s.value.slice(0, VAL_CAP - 1) + "…" : s.value;
        return `${s.col}=${v}`;
      })
      .join(", ");
    const trail = stats.allSame.length > 2 ? "，…" : "";
    parts.push(`已隐藏 ${stats.allSame.length} 列（所有行取值相同）：${sample}${trail}`);
  }
  return parts.length > 0 ? trimToWidth(`  ⓘ ${parts.join("  |  ")}`, maxWidth) : "";
}

function trimToWidth(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

// ====== 自适应列宽打包 ======

/**
 * 在列的理想宽度之间分配水平像素预算。
 *
 * 采用注水式：当理想宽度总和超过预算时，
 * 反复收缩最宽的列，直到总和合适或每列达到最小值（6 字符）。
 * 若预算连最小宽度都放不下，则从最小值开始按比例压缩。
 *
 */
export function layoutColumns(idealWidths: number[], budget: number): number[] {
  const n = idealWidths.length;
  if (n === 0) return [];

  const MIN = 6;
  // 每行 markdown 的开销：“| ” + … + “ | ” + … + “|”
  const overhead = 3 * n + 1;
  const available = budget - overhead;

  const current = [...idealWidths];

  // 连最小宽度都放不下——按比例压缩
  const minTotal = n * MIN;
  if (available < minTotal) {
    const scale = available / minTotal;
    return idealWidths.map(() => Math.max(1, Math.floor(MIN * scale)));
  }

  let total = current.reduce((a, b) => a + b, 0);

  while (total > available) {
    let maxIdx = 0;
    for (let i = 1; i < n; i++) {
      if (current[i] > current[maxIdx]) maxIdx = i;
    }
    if (current[maxIdx] <= MIN) break;
    current[maxIdx]--;
    total--;
  }

  return current;
}

// ====== 单元格辅助 ======

function pad(s: string, w: number): string {
  if (s.length > w) return s.slice(0, Math.max(0, w - 1)) + "…";
  return s.padEnd(w);
}

function cellString(val: unknown): string {
  return val === null || val === undefined ? "NULL" : String(val);
}

function pickId(row: SqlRow, columns: string[]): string {
  const candidates = ["id", "name", "host", "user", "username", "email", "key", "code"];
  for (const c of candidates) {
    const match = columns.find((col) => col.toLowerCase() === c);
    if (match && row[match] !== null) return String(row[match]);
  }
  return "";
}

// ====== 横向表（自适应宽度）======

function formatHorizontal(
  cols: string[],
  rows: SqlRow[],
  totalRows: number,
  widths: number[],
  note: string,
): string {
  const MAX_DISPLAY = 20;
  const displayRows = rows.slice(0, MAX_DISPLAY);

  const lines: string[] = [];

  // 表头
  lines.push("| " + cols.map((c, i) => pad(c, widths[i])).join(" | ") + " |");
  // 分隔线
  lines.push("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  // 数据
  for (const row of displayRows) {
    lines.push("| " + cols.map((c, i) => pad(cellString(row[c]), widths[i])).join(" | ") + " |");
  }

  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ====== 转置（列→行、行→列；适用于宽但行少的表）======

function formatTransposed(
  cols: string[],
  rows: SqlRow[],
  totalRows: number,
  note: string,
  width: number,
): string {
  const MAX_DISPLAY = 10;
  const displayRows = rows.slice(0, MAX_DISPLAY);

  const rowHeaders = displayRows.map((row, i) => {
    const id = pickId(row, cols);
    const label = id ? `#${i + 1} ${id}` : `#${i + 1}`;
    return label.length > 22 ? label.slice(0, 19) + "…" : label;
  });

  // 自适应列名宽度（上限 24）
  const colNameWidth = Math.min(24, Math.max(...cols.map((c) => c.length)));
  // 单元格宽度：计入行表头之间的所有 “ │ ” 分隔符
  const LEFT_OVERHEAD = 5; // "  " + " │ " before the first cell
  const BETWEEN_OVERHEAD = 3 * (rowHeaders.length - 1); // " │ " between cells
  const cellsBudget = Math.max(0, width - colNameWidth - LEFT_OVERHEAD - BETWEEN_OVERHEAD);
  const cellWidth =
    rowHeaders.length > 0
      ? Math.min(40, Math.max(4, Math.floor(cellsBudget / rowHeaders.length)))
      : 40;

  const lines: string[] = [];

  // 表头行：“  ColName │ Header1 Header2 …”
  lines.push(
    "  " + "".padEnd(colNameWidth) + " │ " + rowHeaders.map((h) => pad(h, cellWidth)).join(" │ "),
  );
  // 分隔线
  lines.push(
    "  " +
      "─".repeat(colNameWidth) +
      "─┼─" +
      rowHeaders.map(() => "─".repeat(cellWidth)).join("─┼─"),
  );

  // 每列一行
  for (const col of cols) {
    const vals = displayRows.map((row) => pad(cellString(row[col]), cellWidth));
    lines.push("  " + col.padEnd(colNameWidth) + " │ " + vals.join(" │ "));
  }

  lines.push("");
  lines.push(`显示 ${totalRows} 行 × ${cols.length} 列`);
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ====== 每行纵向键值（压缩，适用于宽且多行）======

function formatVertical(
  cols: string[],
  rows: SqlRow[],
  totalRows: number,
  note: string,
  width: number,
): string {
  const MAX_DISPLAY = 5;
  const displayRows = rows.slice(0, MAX_DISPLAY);
  const labelWidth = Math.min(28, Math.max(...cols.map((c) => c.length)));
  // 将单元格值截断到标签与分隔符之后能容纳的长度
  const VALUE_OVERHEAD = 7; // "  " + " │ "  (2 leading + 3 separator + 2 padding)
  const valueCap = Math.max(20, Math.min(60, width - labelWidth - VALUE_OVERHEAD));
  const lines: string[] = [];
  for (let i = 0; i < displayRows.length; i++) {
    const row = displayRows[i];
    const id = pickId(row, cols);
    lines.push(`─── Row ${i + 1}${id ? `  [${id}]` : ""} ───`);
    for (const col of cols) {
      const s = cellString(row[col]);
      const display = s.length > valueCap ? s.slice(0, Math.max(0, valueCap - 1)) + "…" : s;
      lines.push(`  ${col.padEnd(labelWidth)} │ ${display}`);
    }
    lines.push("");
  }
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ====== 纵向完整（展开模式——不截断，全部行）======

export function formatVerticalFull(columns: string[], rows: SqlRow[]): string[] {
  const labelWidth = Math.min(28, Math.max(...columns.map((c) => c.length)));
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = pickId(row, columns);
    lines.push(`─── Row ${i + 1}${id ? `  [${id}]` : ""} ───`);
    for (const col of columns) {
      const s = cellString(row[col]);
      lines.push(`  ${col.padEnd(labelWidth)} │ ${s}`);
    }
    lines.push("");
  }

  return lines;
}

// ====== 公共入口 ======

/**
 * 为 TUI 显示格式化查询结果。自适应给定终端宽度：
 * - 优先尝试带自适应列宽的横向 markdown 表。
 * - 横向在最小宽度放不下时回退为转置布局。
 * - 宽且多行的结果用纵向（每行键值）布局。
 *
 * 单元格内容上限 60 字符，避免单个异常值撑爆列宽。
 */
export function formatTableDisplay(result: TableResult, width: number): string {
  if (result.rows.length === 0) return "（空结果）";

  const stats = analyzeColumns(result.columns, result.rows);
  const allHidden = stats.visible.length === 0;
  const note = allHidden ? "" : hiddenNote(stats, Math.max(40, width - 2));
  const cols = allHidden ? result.columns : stats.visible;
  const totalRows = result.rows.length;

  // 计算每列理想内容宽度（表头 + 首页行）
  const CELL_CAP = 60;
  const IDEAL_ROWS = 20;
  const ideal = cols.map((col) => {
    let max = col.length;
    for (let i = 0; i < Math.min(IDEAL_ROWS, result.rows.length); i++) {
      const len = cellString(result.rows[i][col]).length;
      max = Math.max(max, Math.min(len, CELL_CAP));
    }
    return max;
  });

  // 先试横向——仅当终端足够宽、有展示意义时
  if (width >= 40) {
    const widths = layoutColumns(ideal, width);
    const minW = Math.min(...widths);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + 3 * cols.length + 1;
    // 允许窄列——2 字符宽足够放 “id” 或 “1.”
    if (minW >= 2 && totalWidth <= width) {
      return formatHorizontal(cols, result.rows, totalRows, widths, note);
    }
  }

  // 回退为转置（行少时）或纵向
  if (result.rows.length <= 10) {
    return formatTransposed(cols, result.rows, totalRows, note, width);
  }
  return formatVertical(cols, result.rows, totalRows, note, width);
}

/**
 * 为 LLM 上下文格式化查询结果——省 token 且信息丰富：
 * - 不对齐填充（裸 markdown）。
 * - 单元格上限 200 字符，带显式截断标记 …[+N]，让 AI 知道
 *   被截掉多少数据、可以重新查询完整值。
 * - 包含所有行（工具层的 truncateHead 是最后一道防线）。
 */
export function formatTableCompact(result: TableResult): string {
  if (result.rows.length === 0) return "（空结果）";

  const stats = analyzeColumns(result.columns, result.rows);
  const allHidden = stats.visible.length === 0;
  const note = allHidden ? "" : hiddenNote(stats, 200);
  const cols = allHidden ? result.columns : stats.visible;

  const CELL_CAP = 200;
  const lines: string[] = [];

  // 表头
  lines.push("| " + cols.join(" | ") + " |");
  // 分隔线
  lines.push("| " + cols.map(() => "---").join(" | ") + " |");
  // 数据——无填充，全部行
  for (const row of result.rows) {
    const cells = cols.map((col) => {
      const s = cellString(row[col]);
      if (s.length > CELL_CAP) {
        return s.slice(0, CELL_CAP - 5) + `…[+${s.length - CELL_CAP}]`;
      }
      return s;
    });
    lines.push("| " + cells.join(" | ") + " |");
  }

  if (note) lines.push(note);
  return lines.join("\n");
}
