/**
 * /db command — Database Workspace entry point.
 *
 * Thin router: delegates to per-subcommand handler modules.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { STATUS_KEY, handleSwitch } from "./switch";
import { handleAdd } from "./add";
import { handleTables } from "./tables";
import { handleSchema } from "./schema";
import { handleQuery } from "./query";
import { handleHistory } from "./history";
import { handleFavorite } from "./favorites";
import { handleRelations } from "./relations";

// ====== Autocomplete item type (structurally matches pi-tui AutocompleteItem) ======

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

// ====== Command registration ======

const SUBCOMMANDS = [
  "switch",
  "add",
  "tables",
  "schema",
  "query",
  "history",
  "favorite",
  "relations",
] as const;

export function registerDbCommand(
  pi: ExtensionAPI,
  getWorkspace: () => DatabaseWorkspaceService,
): void {
  pi.registerCommand("db", {
    description:
      "Database workspace: /db (panel) | switch | add | tables | schema <table> | query [table] | history [kw] | favorite | relations",

    getArgumentCompletions: async (prefix) => {
      return getCompletions(prefix, getWorkspace());
    },

    handler: async (args, ctx) => {
      // Dialogs are no-ops without a UI (print/json modes) — bail out early.
      if (!ctx.hasUI) return;

      const ws = getWorkspace();
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      switch (sub) {
        case undefined: {
          // Send silent LLM context before showing interactive dashboard
          sendLLMContext(ws, pi);
          const action = await showDashboard(ctx, ws);
          if (!action) return;
          await dispatchAction(action, ctx, ws, pi, rest);
          break;
        }
        case "switch":
          await handleSwitch(ctx, ws, pi);
          break;
        case "add":
          await handleAdd(ctx, ws);
          break;
        case "tables":
          await handleTables(ctx, ws, pi);
          break;
        case "schema":
          await handleSchema(ctx, ws, pi, rest[0]);
          break;
        case "query":
          await handleQuery(ctx, ws, pi, rest.join(" ") || undefined);
          break;
        case "history":
          await handleHistory(ctx, ws, pi, rest[0]);
          break;
        case "favorite":
          await handleFavorite(ctx, ws, pi, rest);
          break;
        case "relations":
          await handleRelations(ctx, ws, pi, rest);
          break;
        default:
          ctx.ui.notify(`未知命令: ${sub}。可用：${SUBCOMMANDS.join(", ")}`, "warning");
      }
    },
  });
}

// ====== Argument completions ======

async function getCompletions(
  prefix: string,
  ws: DatabaseWorkspaceService,
): Promise<AutocompleteItem[] | null> {
  const parts = prefix.trim().split(/\s+/);
  const hasTrailingSpace = prefix.endsWith(" ");

  const sub = parts[0];
  const partial = hasTrailingSpace ? "" : (parts[1] ?? "");

  const subSubs: Record<string, string[]> = {
    favorite: ["add"],
    relations: ["add", "remove", "discover", "er-diagram"],
  };

  // When the first word is an EXACT match for a subcommand that owns
  // sub-subcommands, show the second level immediately. This covers both
  // "relations" (partial typing) and "relations " (Tab-completed with
  // trailing space that pi may have stripped).
  if (parts.length === 1 && SUBCOMMANDS.includes(sub as any) && sub in subSubs) {
    return subSubs[sub]
      .filter((s) => s.startsWith(partial))
      .map((s) => ({ value: `${sub} ${s} `, label: s }));
  }

  // Table-name arguments (schema, query) — fire BEFORE the first-level
  // partial match so exact subcommand matches don't self-reference.
  const takesTable =
    sub === "schema" || sub === "query" || (sub === "relations" && parts[1] === "er-diagram");
  if (takesTable && ws.isReady) {
    try {
      const tables = await ws.getTables();
      const tablePartial =
        sub === "relations" ? (hasTrailingSpace ? "" : (parts[2] ?? "")) : partial;
      const valuePrefix = sub === "relations" ? "relations er-diagram " : `${sub} `;
      return tables
        .filter((t) => t.toLowerCase().startsWith(tablePartial.toLowerCase()))
        .map((t) => ({ value: `${valuePrefix}${t}`, label: t }));
    } catch {
      return null;
    }
  }

  // First argument: subcommand names (partial match).
  if (parts.length === 1 && !hasTrailingSpace) {
    return SUBCOMMANDS.filter((s) => s.startsWith(sub)).map((s) => ({
      value: s + " ",
      label: s,
    }));
  }

  // Mid-typing sub-subcommand filtering (e.g. "relations a" → "add").
  if (subSubs[sub] && parts.length === 2 && !hasTrailingSpace) {
    const filtered = subSubs[sub].filter((s) => s.startsWith(partial));
    if (filtered.length > 0) {
      return filtered.map((s) => ({ value: `${sub} ${s} `, label: s }));
    }
  }

  return null;
}

// ====== Dashboard ================================================

interface DashboardAction {
  value: string;
  label: string;
  /** Whether this action requires a connected DB */
  needsConnection?: boolean;
}

const DASHBOARD_ACTIONS: DashboardAction[] = [
  { value: "switch", label: "🔄 切换环境/数据库", needsConnection: false },
  { value: "add", label: "➕ 添加新连接", needsConnection: false },
  { value: "tables", label: "📋 浏览数据表", needsConnection: true },
  { value: "schema", label: "🔍 查看表结构", needsConnection: true },
  { value: "query", label: "💬 SQL 查询", needsConnection: true },
  { value: "history", label: "📜 查询历史", needsConnection: true },
  { value: "favorite", label: "⭐ 收藏查询", needsConnection: true },
  { value: "relations", label: "🔗 表关联关系", needsConnection: true },
];

/** Send a silent context message so the LLM knows the DB state. */
function sendLLMContext(ws: DatabaseWorkspaceService, pi: ExtensionAPI): void {
  if (ws.isReady) {
    pi.sendMessage(
      {
        customType: "db-active-db",
        content: `Current database: ${ws.current!.database} (connection: ${ws.current!.connectionId}, environment: ${ws.current!.environment}). Config file: ${ws.configPath}.`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
  } else if (ws.isConfigured) {
    pi.sendMessage(
      {
        customType: "db-hint",
        content: `Database connections are configured but no database is selected. Tell the user to run /db switch to connect. Config file: ${ws.configPath}.`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
  }
}

/** Build the interactive dashboard component. */
async function showDashboard(
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
): Promise<string | undefined> {
  // Build status lines
  let statusLines: string[] = [];
  if (ws.current) {
    const conn = ws.getCurrentConnection();
    statusLines = [
      `📡 环境：${ws.current.environment}`,
      `⚡ 连接：${ws.current.connectionId}（${conn?.host ?? "?"}）`,
      `🗃️  数据库：${ws.current.database}`,
    ];
  } else if (ws.isConfigured) {
    const envs = ws.getEnvironments();
    statusLines = [`⚡ 可用环境：${envs.join(", ")}`];
  } else {
    statusLines = ["⚠️  尚未配置数据库连接", `配置文件：${ws.configPath}`];
  }

  // Build action items — disable connection-required actions when not connected
  const items: SelectItem[] = DASHBOARD_ACTIONS.map((a) => ({
    value: a.value,
    label: a.label,
    description: a.needsConnection && !ws.isReady ? "（需要先连接数据库）" : undefined,
  }));

  // Warnings
  const warnings = ws.getConfigWarnings();
  const showWarnings = warnings.length > 0;

  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container();

    // Top border
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    // Header
    container.addChild(new Text(theme.fg("accent", theme.bold("🗄 数据库工作区")), 1, 0));

    // Status
    for (const line of statusLines) {
      container.addChild(new Text(theme.fg("dim", `  ${line}`), 1, 0));
    }

    // Warnings
    if (showWarnings) {
      for (const w of warnings) {
        container.addChild(new Text(theme.fg("warning", `  ⚠ ${w}`), 1, 0));
      }
    }

    // Separator
    container.addChild(new Text(theme.fg("dim", "  ─── 操作 ─────────────────"), 1, 0));

    // Action list
    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => {
      const action = DASHBOARD_ACTIONS.find((a) => a.value === item.value);
      if (action?.needsConnection && !ws.isReady) {
        return;
      }
      done(item.value);
    };
    selectList.onCancel = () => done(void 0);
    container.addChild(selectList);

    // Bottom border
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
}

/** Route a dashboard action to the correct handler. */
async function dispatchAction(
  action: string,
  ctx: ExtensionCommandContext,
  ws: DatabaseWorkspaceService,
  pi: ExtensionAPI,
  rest: string[],
): Promise<void> {
  switch (action) {
    case "switch":
      await handleSwitch(ctx, ws, pi);
      break;
    case "add":
      await handleAdd(ctx, ws);
      break;
    case "tables":
      await handleTables(ctx, ws, pi);
      break;
    case "schema":
      await handleSchema(ctx, ws, pi, rest[0]);
      break;
    case "query":
      await handleQuery(ctx, ws, pi, rest.join(" ") || undefined);
      break;
    case "history":
      await handleHistory(ctx, ws, pi, rest[0]);
      break;
    case "favorite":
      await handleFavorite(ctx, ws, pi, rest);
      break;
    case "relations":
      await handleRelations(ctx, ws, pi, rest);
      break;
  }
}

// ====== Status bar helpers ======

/** Restore status bar on session start. */
export function restoreStatusBar(ws: DatabaseWorkspaceService, ctx: ExtensionContext): void {
  if (ws.isReady) {
    ctx.ui.setStatus(STATUS_KEY, ws.statusLabel);
    ctx.ui.setWidget(STATUS_KEY, [
      `🗄 ${ws.current!.environment}/${ws.current!.database}  @${ws.current!.connectionId}`,
    ]);
  }
}
