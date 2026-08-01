/**
 * 共享命令工具 —— pickTableFuzzy、withLoader。
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
 * 单步模糊表选择器：输入过滤，方向键选择。
 *
 * 取代两步式 pickTable（关键词输入 → 选择）。使用
 * SelectList.setFilter() 做原生模糊匹配——一步到位，无
 * 中间对话框。
 *
 * @param extraItems —— 前置在表项之前（如 "✏️ 输入 SQL…"）
 *   用于合并的查询入口）。
 *
 * 由 schema、query、relations-add 处理器共享。
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

    // 上边框
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    // 标题
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold(`📋 ${prompt}`)) +
          theme.fg("dim", `　${tables.length} 个表 · 输入关键字过滤 · Esc 取消`),
        1,
        0,
      ),
    );

    // 过滤提示行——随用户输入更新
    const filterLine = new Text(theme.fg("muted", "> "), 1, 0);
    container.addChild(filterLine);

    // 带内置模糊过滤的 SelectList
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

    // 下边框
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

        // navigate / none → 委托给 SelectList 处理 Enter/Esc/方向键
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result;
}

/**
 * 用 BorderedLoader 包裹异步操作（spinner + Esc 取消）。
 * 用户按 Esc 取消时返回 undefined。
 *
 * @param onError —— 操作失败时调用；用它显示错误通知，
 *   在 loader 消失之前。
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
            /* 空操作 */
          }
        }
        done(void 0);
      });

    return loader;
  });

  return result;
}
