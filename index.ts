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

  // Register LLM tools (db_query, db_list_tables, db_table_schema, db_register_relation)
  registerDbTools(pi, getWorkspace);

  // Restore status bar on session start
  pi.on("session_start", (_event, ctx) => {
    const ws = getWorkspace();
    restoreStatusBar(ws, ctx);
    // Tell the LLM which database is active when resuming a session,
    // so it doesn't have to discover via a failed tool call.
    if (ws.isReady) {
      pi.sendMessage(
        {
          customType: "db-active-db",
          content: `Current database: ${ws.current!.database} (connection: ${ws.current!.connectionId}, environment: ${ws.current!.environment}).`,
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
