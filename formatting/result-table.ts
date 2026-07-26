/**
 * Result-table formatting — shared between /db command and query_database tool.
 *
 * Exports one entry point (formatTableResult) plus analyzeColumns for callers
 * that need to inspect column stats separately.
 */

// ====== Types ======

export interface ColumnStats {
  visible: string[];
  allNull: string[];
  allSame: { col: string; value: string }[];
}

export interface TableResult {
  columns: string[];
  rows: Record<string, any>[];
}

// ====== Column analysis ======

export function analyzeColumns(columns: string[], rows: Record<string, any>[]): ColumnStats {
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
        if (!firstSet) { firstVal = val; firstSet = true; }
        else if (String(val) !== String(firstVal)) { isAllSame = false; break; }
      }
    }

    if (isAllNull) allNull.push(col);
    else if (isAllSame) allSame.push({ col, value: String(firstVal) });
    else visible.push(col);
  }

  return { visible, allNull, allSame };
}

// ====== Hidden-column note ======

function hiddenNote(stats: ColumnStats): string {
  const parts: string[] = [];
  if (stats.allNull.length > 0) parts.push(`${stats.allNull.length} 列全为 NULL`);
  if (stats.allSame.length > 0) {
    const sample = stats.allSame.slice(0, 2).map(s => `${s.col}=${s.value}`).join(", ");
    const trail = stats.allSame.length > 2 ? "，…" : "";
    parts.push(`${stats.allSame.length} 列值相同：${sample}${trail}`);
  }
  return parts.length > 0 ? `  ⓘ ${parts.join("  |  ")}` : "";
}

// ====== Row identifier ======

function pickId(row: Record<string, any>, columns: string[]): string {
  const candidates = ["id", "name", "host", "user", "username", "email", "key", "code"];
  for (const c of candidates) {
    const match = columns.find(col => col.toLowerCase() === c);
    if (match && row[match] != null) return String(row[match]);
  }
  return "";
}

// ====== Horizontal table (≤ 8 cols) ======

function formatHorizontal(cols: string[], rows: Record<string, any>[], totalRows: number, note: string): string {
  const MAX_COL = 22;
  const MAX_DISPLAY = 20;
  const displayRows = rows.slice(0, MAX_DISPLAY);

  const widths = cols.map(col => {
    let max = Math.min(col.length, MAX_COL);
    for (const row of displayRows) {
      const len = row[col] === null ? 4 : String(row[col]).length;
      if (len > max) max = len;
    }
    return Math.min(max, MAX_COL);
  });

  const cell = (val: unknown, w: number): string => {
    const s = val === null ? "NULL" : String(val);
    if (s.length > w) return s.slice(0, w - 1) + "…";
    return s.padEnd(w);
  };

  const lines: string[] = [];
  lines.push("| " + cols.map((c, i) => cell(c, widths[i])).join(" | ") + " |");
  lines.push("|" + widths.map(w => "-".repeat(w + 2)).join("|") + "|");
  for (const row of displayRows) {
    lines.push("| " + cols.map((c, i) => cell(row[c], widths[i])).join(" | ") + " |");
  }
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ====== Transposed (columns→rows, rows→columns; > 8 cols & ≤ 10 rows) ======

function formatTransposed(cols: string[], rows: Record<string, any>[], totalRows: number, note: string): string {
  const MAX_COL_NAME = 24;
  const MAX_CELL = 36;
  const MAX_DISPLAY = 10;
  const displayRows = rows.slice(0, MAX_DISPLAY);

  const rowHeaders = displayRows.map((row, i) => {
    const id = pickId(row, cols);
    const label = id ? `#${i + 1} ${id}` : `#${i + 1}`;
    return label.length > 22 ? label.slice(0, 19) + "…" : label;
  });

  const colWidth = Math.min(MAX_COL_NAME, Math.max(...cols.map(c => c.length)));
  const cellWidths = rowHeaders.map(h => Math.min(MAX_CELL, h.length));

  const cell = (val: unknown, w: number): string => {
    const s = val === null ? "NULL" : String(val);
    if (s.length > w) return s.slice(0, w - 1) + "…";
    return s.padEnd(w);
  };

  const lines: string[] = [];

  lines.push("  " + "".padEnd(colWidth) + " │ " + rowHeaders.map((h, i) => cell(h, cellWidths[i])).join(" │ "));
  lines.push("  " + "─".repeat(colWidth) + "─┼─" + cellWidths.map(w => "─".repeat(w)).join("─┼─"));

  for (const col of cols) {
    const vals = displayRows.map((row, i) => cell(row[col], cellWidths[i]));
    lines.push("  " + col.padEnd(colWidth) + " │ " + vals.join(" │ "));
  }

  lines.push("");
  lines.push(`显示 ${totalRows} 行 × ${cols.length} 列`);
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ====== Vertical key-value per row (> 8 cols & > 10 rows) ======

function formatVertical(cols: string[], rows: Record<string, any>[], totalRows: number, note: string): string {
  const MAX_DISPLAY = 5;
  const displayRows = rows.slice(0, MAX_DISPLAY);
  const labelWidth = Math.min(28, Math.max(...cols.map(c => c.length)));

  const lines: string[] = [];
  for (let i = 0; i < displayRows.length; i++) {
    const row = displayRows[i];
    const id = pickId(row, cols);
    lines.push(`─── Row ${i + 1}${id ? `  [${id}]` : ""} ───`);
    for (const col of cols) {
      const val = row[col];
      const s = val === null ? "NULL" : String(val);
      const display = s.length > 60 ? s.slice(0, 57) + "…" : s;
      lines.push(`  ${col.padEnd(labelWidth)} │ ${display}`);
    }
    lines.push("");
  }
  if (totalRows > MAX_DISPLAY) lines.push(`… 还有 ${totalRows - MAX_DISPLAY} 行`);
  if (note) lines.push(note);

  return lines.join("\n");
}

// ====== Main entry point ======

/**
 * Format a query result as a human-readable table string.
 *
 * Chooses the best layout automatically:
 * - ≤ 8 columns → horizontal markdown table
 * - > 8 cols & ≤ 10 rows → transposed (columns become rows)
 * - > 8 cols & > 10 rows → vertical key-value per row
 */
export function formatTableResult(result: TableResult): string {
  if (result.rows.length === 0) return "（空结果）";

  const stats = analyzeColumns(result.columns, result.rows);
  const note = hiddenNote(stats);
  const cols = stats.visible.length > 0 ? stats.visible : result.columns;
  const totalRows = result.rows.length;

  if (cols.length <= 8) {
    return formatHorizontal(cols, result.rows, totalRows, note);
  }
  if (result.rows.length <= 10) {
    return formatTransposed(cols, result.rows, totalRows, note);
  }
  return formatVertical(cols, result.rows, totalRows, note);
}
