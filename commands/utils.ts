/**
 * Shared command utilities — pickTable, pickTableFuzzy, withLoader.
 */

import {
  type ExtensionCommandContext,
  DynamicBorder,
  BorderedLoader,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { createFilterReducer } from "./filter-input";

/**
 * Single-step fuzzy table picker: type to filter, arrow keys to select.
 *
 * Replaces the two-step pickTable (keyword input → select). Uses
 * SelectList.setFilter() for native fuzzy matching — one step, no
 * intermediate dialog.
 *
 * @param extraItems — prepended before table items (e.g. "✏️ 输入 SQL…"
 *   for merged query entry).
 *
 * Shared by schema, query, relations-add, and relations-er-diagram handlers.
 */
export async function pickTableFuzzy(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  prompt: string,
  extraItems?: SelectItem[],
): Promise<string | undefined> {
  let tables: string[];
  try {
    tables = await ws.getTables();
  } catch (err: any) {
    ctx.ui.notify(`加载表列表失败：${err.message}`, "error");
    return undefined;
  }
  if (tables.length === 0) {
    ctx.ui.notify(`${ws.current!.database} 中没有表`, "warning");
    return undefined;
  }

  const tableItems: SelectItem[] = tables.map((t) => ({ value: t, label: t }));
  const items = extraItems ? [...extraItems, ...tableItems] : tableItems;

  const result = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    const reducer = createFilterReducer();

    // Top border
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    // Title
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold(`📋 ${prompt}`)) +
          theme.fg("dim", `　${tables.length} 个表 · 输入关键字过滤 · Esc 取消`),
        1,
        0,
      ),
    );

    // Filter hint line — updates as the user types
    const filterLine = new Text(theme.fg("muted", "> "), 1, 0);
    container.addChild(filterLine);

    // SelectList with built-in fuzzy filtering
    const selectList = new SelectList(items, Math.min(items.length, 14), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", theme.bold(t)),
      description: (_t) => "",
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(void 0);
    container.addChild(selectList);

    // Bottom border
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const keyResult = reducer.handleKey(data);

        if (keyResult.action === "filter") {
          selectList.setFilter(keyResult.filterText);
          filterLine.setText(
            keyResult.filterText.length > 0
              ? theme.fg("muted", `> ${keyResult.filterText}`)
              : theme.fg("muted", "> "),
          );
          tui.requestRender();
          return;
        }

        // navigate / none → delegate to SelectList for Enter/Esc/arrows
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result;
}

/**
 * Wrap an async operation with BorderedLoader (spinner + Esc cancel).
 * Returns undefined when the user cancels via Esc.
 *
 * @param onError — called when the operation fails; use it to show
 *   an error notification before the loader disappears.
 */
export async function withLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  fn: (signal: AbortSignal) => Promise<T>,
  onError?: (err: Error) => void,
): Promise<T | undefined> {
  const result = await ctx.ui.custom<T | undefined>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
    loader.onAbort = () => done(void 0);

    fn(loader.signal)
      .then((value) => done(value))
      .catch((err) => {
        if (onError) {
          try {
            onError(err instanceof Error ? err : new Error(String(err)));
          } catch {
            /* nop */
          }
        }
        done(void 0);
      });

    return loader;
  });

  return result;
}

/**
 * @deprecated Use pickTableFuzzy for single-step fuzzy selection instead.
 *
 * Interactive table picker: keyword input → filtered select.
 */
export async function pickTable(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  prompt: string,
): Promise<string | undefined> {
  let tables: string[];
  try {
    tables = await ws.getTables();
  } catch (err: any) {
    ctx.ui.notify(`加载表列表失败：${err.message}`, "error");
    return undefined;
  }
  if (tables.length === 0) {
    ctx.ui.notify(`${ws.current!.database} 中没有表`, "warning");
    return undefined;
  }

  const keyword = await ctx.ui.input(`筛选表名（回车显示全部）`, "");
  if (keyword === undefined) return undefined;

  const filtered = keyword?.trim()
    ? tables.filter((t) => t.toLowerCase().includes(keyword.toLowerCase()))
    : tables;

  if (filtered.length === 0) {
    ctx.ui.notify(`未找到匹配 "${keyword}" 的表`, "warning");
    return undefined;
  }

  return await ctx.ui.select(prompt, filtered);
}
