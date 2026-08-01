/**
 * /db history —— 浏览、重跑、编辑、收藏或删除查询历史。
 *
 * 交互流程：
 *   /db history [keyword]
 *     → 条目 SelectList（输入过滤，↑↓ 导航）
 *     → 选中条目 → 操作菜单
 *       ▶ 重跑：立即重新执行
 *       ✏️ 编辑后跑：打开编辑器，然后执行
 *       ⭐ 收藏：保存为收藏
 *       🗑 删除：确认并移除
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { DatabaseWorkspaceService } from "../state/workspace";
import type { HistoryEntry } from "../history/store";
import { withLoader } from "./utils";
import { executeAndDisplay } from "./query";

// ── 格式化 ───────────────────────────────────────────────────

export function formatEntry(entry: HistoryEntry, index: number): string {
  const time = entry.createdTime.replace("T", " ").slice(5, 19); // "MM-DD HH:MM:SS"
  const sql = entry.sql.length > 52 ? entry.sql.slice(0, 49) + "…" : entry.sql;
  return [
    String(index + 1).padStart(2),
    time,
    sql.padEnd(52),
    `${entry.rowCount}行`.padStart(5),
    entry.elapsed,
  ].join("  ");
}

export function entryToItem(entry: HistoryEntry, index: number): SelectItem {
  return {
    value: String(entry.id),
    label: formatEntry(entry, index),
    description: entry.sql,
  };
}

// ── 入口 ───────────────────────────────────────────────────

export async function handleHistory(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  keyword?: string,
): Promise<void> {
  // 1. 加载历史记录
  const entries = await withLoader(
    ctx,
    keyword ? `搜索历史：${keyword}` : "加载查询历史…",
    (_signal) => Promise.resolve(ws.listHistory(keyword)),
  );
  if (!entries) return;

  if (entries.length === 0) {
    ctx.ui.notify(keyword ? `未找到包含 "${keyword}" 的查询历史` : "暂无查询历史", "info");
    return;
  }

  // 2. 显示交互式选择器
  const selected = await showHistorySelector(ctx, entries);
  if (!selected) return;

  // 3. 操作菜单
  const action = await ctx.ui.select(
    `#${selected.id}  ${formatEntry(selected, entries.indexOf(selected))}`,
    ["▶ 重跑", "✏️ 编辑后跑", "⭐ 收藏", "🗑 删除"],
  );
  if (!action) return;

  switch (action) {
    case "▶ 重跑":
      await executeAndDisplay(ctx, ws, pi, selected.sql);
      break;

    case "✏️ 编辑后跑": {
      const edited = await ctx.ui.editor("编辑 SQL", selected.sql);
      if (!edited?.trim()) return;
      await executeAndDisplay(ctx, ws, pi, edited.trim());
      break;
    }

    case "⭐ 收藏": {
      const name = await ctx.ui.input("收藏名称", "");
      if (!name?.trim()) return;
      const desc = await ctx.ui.input("描述（可选，回车跳过）", "");
      if (desc === undefined) return;
      const entry = ws.saveFavorite(name.trim(), selected.sql, desc?.trim() || undefined);
      ctx.ui.notify(`已收藏 #${entry.id} "${entry.name}"`, "info");
      break;
    }

    case "🗑 删除": {
      const ok = await ctx.ui.confirm(
        "确认删除",
        `SQL: ${selected.sql.length > 60 ? selected.sql.slice(0, 57) + "…" : selected.sql}`,
      );
      if (ok) {
        ws.deleteHistory(selected.id);
        ctx.ui.notify(`已删除历史 #${selected.id}`, "info");
      }
      break;
    }
  }
}

// ── 选择器组件 ────────────────────────────────────────────

async function showHistorySelector(
  ctx: ExtensionCommandContext,
  entries: HistoryEntry[],
): Promise<HistoryEntry | undefined> {
  const items = entries.map((e, i) => entryToItem(e, i));

  const selectedId = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container();

    // 上边框
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    // 标题
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold(`📜 查询历史 — ${entries.length} 条`)) +
          theme.fg("dim", ` · ↑↓ 选择  Enter 选中  Esc 取消`),
        1,
        0,
      ),
    );

    // SelectList 组件
    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", theme.bold(t)),
      description: (t) => theme.fg("dim", t.slice(0, 80)),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => {
      const entry = entries.find((e) => String(e.id) === item.value);
      done(entry ? String(entry.id) : void 0);
    };
    selectList.onCancel = () => done(void 0);
    container.addChild(selectList);

    // 下边框
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!selectedId) return undefined;
  return entries.find((e) => String(e.id) === selectedId);
}
