/**
 * /db command — Database Workspace entry point.
 *
 * Thin router: delegates to per-subcommand handler modules.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseWorkspaceService } from "../state/workspace";
import { STATUS_KEY, showWorkspacePanel, handleSwitch } from "./switch";
import { handleTables } from "./tables";
import { handleSchema } from "./schema";
import { handleQuery } from "./query";
import { handleHistory } from "./history";
import { handleFavorite } from "./favorites";
import { handleRelations } from "./relations";
import { handleRefreshSchema } from "./refresh-schema";

// ====== Autocomplete item type ======

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

// ====== Command registration ======

export function registerDbCommand(
  pi: ExtensionAPI,
  ws: DatabaseWorkspaceService,
): void {
  pi.registerCommand("db", {
    description:
      "Database workspace: /db (panel) | /db switch | /db tables | /db schema <table> | /db query [table] | /db history | /db favorite | /db relations | /db refresh-schema",

    getArgumentCompletions: async (prefix) => {
      return getCompletions(prefix, ws);
    },

    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      switch (sub) {
        case undefined:
          await showWorkspacePanel(ctx, ws);
          break;
        case "switch":
          await handleSwitch(ctx, ws, pi);
          break;
        case "tables":
          await handleTables(ctx, ws);
          break;
        case "schema":
          await handleSchema(ctx, ws, rest[0]);
          break;
        case "query":
          await handleQuery(ctx, ws, pi, rest[0]);
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
          ctx.ui.notify(
            `未知命令: ${sub}。可用：switch, tables, schema, query, history, favorite, relations, refresh-schema`,
            "warning",
          );
      }
    },
  });
}

// ====== Argument completions ======

async function getCompletions(
  prefix: string,
  ws: DatabaseWorkspaceService,
): Promise<AutocompleteItem[] | null> {
  const subcommands = ["switch", "tables", "schema", "query", "history", "favorite", "relations", "refresh-schema"];
  const parts = prefix.trim().split(/\s+/);
  const hasTrailingSpace = prefix.endsWith(" ");

  if (parts.length === 1 && !hasTrailingSpace && prefix.length > 1) {
    return subcommands
      .filter((s) => s.startsWith(parts[0]))
      .map((s) => ({ value: s + " ", label: s }));
  }

  if (parts.length >= 1 && (parts[0] === "schema" || parts[0] === "query") && ws.isReady) {
    try {
      const tables = await ws.getTables();
      const partial = hasTrailingSpace ? "" : (parts[1] ?? "");
      const sub = parts[0];
      return tables
        .filter((t) => t.toLowerCase().startsWith(partial.toLowerCase()))
        .map((t) => ({ value: `${sub} ${t}`, label: t }));
    } catch {
      return null;
    }
  }

  return null;
}

// ====== Status bar helpers ======

/** Restore status bar on session start. */
export function restoreStatusBar(
  ws: DatabaseWorkspaceService,
  ctx: {
    ui: {
      setStatus(key: string, text: string | undefined): void;
      setWidget(key: string, lines: string[] | undefined): void;
    };
  },
): void {
  if (ws.isReady) {
    ctx.ui.setStatus(STATUS_KEY, ws.statusLabel);
    ctx.ui.setWidget(STATUS_KEY, [
      `🗄 DB：${ws.current!.environment}/${ws.current!.database}`,
      `连接：${ws.current!.connectionId}`,
    ]);
  }
}
