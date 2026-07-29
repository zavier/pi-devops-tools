import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseWorkspaceService } from "./state/workspace";
import { registerDbCommand, restoreStatusBar } from "./commands/db";
import { registerRenderers } from "./commands/renderers";
import { registerDbTools } from "./tools/db-tools";

export default function (pi: ExtensionAPI) {
  // Lazy init: extension factories may run in invocations that never start a
  // session (print mode, --list-models, ...). Defer opening SQLite and reading
  // connections.yaml until the first command/tool call or session_start.
  let workspace: DatabaseWorkspaceService | null = null;
  const getWorkspace = (): DatabaseWorkspaceService => {
    workspace ??= new DatabaseWorkspaceService();
    return workspace;
  };

  // Custom message renderers (compact query results, raw-text panel)
  registerRenderers(pi);

  // Register the /db command
  registerDbCommand(pi, getWorkspace);

  // Register LLM tools (db_query, db_list_databases, db_list_tables, db_table_schema, db_list_relations, db_register_relation)
  registerDbTools(pi, getWorkspace);

  // Restore status bar on session start
  pi.on("session_start", (_event, ctx) => {
    const ws = getWorkspace();
    restoreStatusBar(ws, ctx);
    // Tell the LLM which database is active when resuming a session,
    // so it doesn't have to discover via a failed tool call.
    if (ws.isReady) {
      const db = ws.current!;
      pi.sendMessage(
        {
          customType: "db-active-db",
          content: `Current database: ${db.database} (connection: ${db.connectionId}, environment: ${db.environment}). Config file: ${ws.configPath}.`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    } else if (ws.isConfigured) {
      // Configured but not yet switched — let the AI know so it can
      // help the user pick a database.
      pi.sendMessage(
        {
          customType: "db-hint",
          content: `Database connections are configured but no database is selected. Tell the user to run /db switch to connect. Config file: ${ws.configPath}.`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    }
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    workspace?.destroy();
    workspace = null;
  });
}
