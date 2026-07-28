/**
 * /db command — Database Workspace entry point.
 *
 * Thin router: delegates to per-subcommand handler modules.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { STATUS_KEY, showWorkspacePanel, handleSwitch } from "./switch";
import { handleAdd } from "./add";
import { handleTables } from "./tables";
import { handleSchema } from "./schema";
import { handleQuery } from "./query";
import { handleHistory } from "./history";
import { handleFavorite } from "./favorites";
import { handleRelations } from "./relations";
import { handleRefreshSchema } from "./refresh-schema";

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
  "refresh-schema",
] as const;

export function registerDbCommand(
  pi: ExtensionAPI,
  getWorkspace: () => DatabaseWorkspaceService,
): void {
  pi.registerCommand("db", {
    description:
      "Database workspace: /db (panel) | switch | add | tables | schema <table> | query [table] | history [kw] | favorite | relations | refresh-schema",

    getArgumentCompletions: async (prefix) => {
      return getCompletions(prefix, getWorkspace());
    },

    handler: async (args, ctx) => {
      // Dialogs are no-ops without a UI (print/json modes) — bail out early.
      if (!ctx.hasUI) return;

      const ws = getWorkspace();
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      switch (sub) {
        case undefined:
          await showWorkspacePanel(ctx, ws, pi);
          break;
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
          await handleHistory(ctx, ws, rest[0]);
          break;
        case "favorite":
          await handleFavorite(ctx, ws, pi, rest);
          break;
        case "relations":
          await handleRelations(ctx, ws, pi, rest);
          break;
        case "refresh-schema":
          await handleRefreshSchema(ctx, ws);
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

// ====== Status bar helpers ======

/** Restore status bar on session start. */
export function restoreStatusBar(ws: DatabaseWorkspaceService, ctx: ExtensionContext): void {
  if (ws.isReady) {
    ctx.ui.setStatus(STATUS_KEY, ws.statusLabel);
    ctx.ui.setWidget(STATUS_KEY, [
      `🗄 DB：${ws.current!.environment}/${ws.current!.database}`,
      `连接：${ws.current!.connectionId}`,
    ]);
  }
}
