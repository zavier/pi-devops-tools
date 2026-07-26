import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseWorkspaceService } from "./state/workspace";
import { registerDbCommand, restoreStatusBar } from "./commands/db";

export default function (pi: ExtensionAPI) {
  // ---- Database Workspace ----
  const workspace = new DatabaseWorkspaceService();

  // Register the /db command
  registerDbCommand(pi, workspace);

  // Restore status bar on session start
  pi.on("session_start", (_event, ctx) => {
    restoreStatusBar(workspace, ctx);
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    workspace.destroy();
  });
}
