/**
 * Result-table formatting for /db query output.
 *
 * Exports:
 * - analyzeColumns / ColumnStats — classify columns (visible / all-null / all-same)
 * - layoutColumns — adaptive column-width packing function
 * - formatTableDisplay — padded markdown table, adaptive to terminal width (TUI)
 * - formatTableCompact — token-efficient unpadded table with …[+N] markers (LLM)
 * - formatTableResult — alias of formatTableDisplay(120), backward compat
 */

import type { SqlRow } from "../types";

// ====== Types ======

export interface ColumnStats {
  visible: string[];
  allNull: string[];
  allSame: { col: string; value: string }[];
}

export interface TableResult {
  columns: string[];
  rows: SqlRow[];
}

// ====== Column analysis ======

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

// ====== Hidden-column note ======

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

// ====== Adaptive column-width packing ======

/**
 * Distribute a horizontal pixel budget across column ideal widths.
 *
 * Works water-filling style: when total ideal widths exceed the budget,
 * repeatedly shrinks the widest column until the total fits or every column
 * hits the minimum (6 chars). If the budget is too tight for even minimum
 * widths the columns are squeezed proportionally from min.
 */
export function layoutColumns(idealWidths: number[], budget: number): number[] {
  const n = idealWidths.length;
  if (n === 0) return [];

  const MIN = 6;
  // Overhead per horizontal markdown row: "| " + … + " | " + … + "|"
  const overhead = 3 * n + 1;
  const available = budget - overhead;

  const current = [...idealWidths];

  // Even minimum widths don't fit — squeeze proportionally
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

// ====== Cell helpers ======

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

// ====== Horizontal table (adaptive widths) ======

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

  // Header
  lines.push("| " + cols.map((c, i) => pad(c, widths[i])).join(" | ") + " |");
  // Separator
  lines.push("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  // Data
  for (const row of displayRows) {
    lines.push("| " + cols.map((c, i) => pad(cellString(row[c]), widths[i])).join(" | ") + " |");
  }

  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ====== Transposed (columns→rows, rows→columns; for wide but few rows) ======

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

  // Adaptive column-name width (capped at 24)
  const colNameWidth = Math.min(24, Math.max(...cols.map((c) => c.length)));
  // Cell widths: account for all " │ " separators between row headers
  const LEFT_OVERHEAD = 5; // "  " + " │ " before the first cell
  const BETWEEN_OVERHEAD = 3 * (rowHeaders.length - 1); // " │ " between cells
  const cellsBudget = Math.max(0, width - colNameWidth - LEFT_OVERHEAD - BETWEEN_OVERHEAD);
  const cellWidth =
    rowHeaders.length > 0
      ? Math.min(40, Math.max(4, Math.floor(cellsBudget / rowHeaders.length)))
      : 40;

  const lines: string[] = [];

  // Header row: "  ColName │ Header1 Header2 …"
  lines.push(
    "  " + "".padEnd(colNameWidth) + " │ " + rowHeaders.map((h) => pad(h, cellWidth)).join(" │ "),
  );
  // Separator
  lines.push(
    "  " +
      "─".repeat(colNameWidth) +
      "─┼─" +
      rowHeaders.map(() => "─".repeat(cellWidth)).join("─┼─"),
  );

  // One row per column
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

// ====== Vertical key-value per row (compressed, for wide + many rows) ======

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
  // Cap cell values to what fits after the label and separator
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

// ====== Vertical full (expanded mode — no truncation, all rows) ======

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

// ====== Public entry points ======

/**
 * Format a query result for TUI display. Adapts to the given terminal width:
 * - Tries a horizontal markdown table with adaptive column widths first.
 * - Falls back to a transposed layout when horizontal won't fit at min widths.
 * - Uses a vertical (key-value per row) layout for wide + many-row results.
 *
 * Cell content is capped at 60 chars to avoid one outlier blowing up a column.
 */
export function formatTableDisplay(result: TableResult, width: number): string {
  if (result.rows.length === 0) return "（空结果）";

  const stats = analyzeColumns(result.columns, result.rows);
  const allHidden = stats.visible.length === 0;
  const note = allHidden ? "" : hiddenNote(stats, Math.max(40, width - 2));
  const cols = allHidden ? result.columns : stats.visible;
  const totalRows = result.rows.length;

  // Compute per-column ideal content widths (header + first-page rows)
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

  // Try horizontal — only if terminal is wide enough to be meaningful
  if (width >= 40) {
    const widths = layoutColumns(ideal, width);
    const minW = Math.min(...widths);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + 3 * cols.length + 1;
    // Allow narrow columns — 2 chars wide is enough for "id" or "1."
    if (minW >= 2 && totalWidth <= width) {
      return formatHorizontal(cols, result.rows, totalRows, widths, note);
    }
  }

  // Fall back to transposed (when few rows) or vertical
  if (result.rows.length <= 10) {
    return formatTransposed(cols, result.rows, totalRows, note, width);
  }
  return formatVertical(cols, result.rows, totalRows, note, width);
}

/**
 * Format a query result for LLM context — token-efficient and information-rich:
 * - No alignment padding (bare markdown).
 * - Cell cap 200 chars with explicit truncation marker …[+N] so the AI knows
 *   how much data was cut and can re-query for full values.
 * - All rows included (truncateHead at the tool level is the final guard).
 */
export function formatTableCompact(result: TableResult): string {
  if (result.rows.length === 0) return "（空结果）";

  const stats = analyzeColumns(result.columns, result.rows);
  const allHidden = stats.visible.length === 0;
  const note = allHidden ? "" : hiddenNote(stats, 200);
  const cols = allHidden ? result.columns : stats.visible;

  const CELL_CAP = 200;
  const lines: string[] = [];

  // Header
  lines.push("| " + cols.join(" | ") + " |");
  // Separator
  lines.push("| " + cols.map(() => "---").join(" | ") + " |");
  // Data — no padding, all rows
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

/**
 * Backward-compat alias — formats with a fixed 120-char budget for existing
 * callers that don't have a terminal width available.  New code should prefer
 * formatTableDisplay (TUI) or formatTableCompact (LLM).
 */
export function formatTableResult(result: TableResult): string {
  return formatTableDisplay(result, 120);
}
