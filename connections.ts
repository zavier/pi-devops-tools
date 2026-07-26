/**
 * ConnectionManager — thin adapter composing DatabaseConnectionManager + SSHClientManager.
 *
 * Delegates MySQL pool management to DatabaseConnectionManager and SSH to SSHClientManager.
 * This is the single entry point used by tool factories (query-database, query-logs, sync-foreign-keys).
 */

import mysql from "mysql2/promise";
import { Client } from "ssh2";
import { DatabaseConnectionManager } from "./connection/db-manager";
import { SSHClientManager, type SSHServerConfig } from "./ssh/client";
import type { AppConfig } from "./types";
import type { ResolvedConnectionConfig } from "./connection/db-config";

export class ConnectionManager {
  private dbManager: DatabaseConnectionManager;
  private sshManager: SSHClientManager;
  private serverConfigs: Record<string, SSHServerConfig>;

  constructor(config: AppConfig) {
    // Bridge AppConfig → ResolvedConnectionConfig[]
    const connections: ResolvedConnectionConfig[] = Object.entries(config.databases).map(
      ([id, db]) => ({
        id,
        environment: "default",
        type: "mysql" as const,
        host: db.host,
        port: db.port,
        username: db.user,
        password: db.password,
        defaultDatabase: db.dbs[0],
      }),
    );

    this.dbManager = new DatabaseConnectionManager(connections);
    this.sshManager = new SSHClientManager();

    // Convert server configs to SSH format
    this.serverConfigs = {};
    for (const [name, srv] of Object.entries(config.servers)) {
      this.serverConfigs[name] = {
        host: srv.host,
        port: srv.port,
        user: srv.user,
        keyPath: srv.keyPath,
      };
    }
  }

  /** Get or create a MySQL pool for a cluster (delegates to DatabaseConnectionManager). */
  getMySQLPool(cluster: string): mysql.Pool {
    return this.dbManager.getPool(cluster);
  }

  /** Get or create an SSH client for a server (delegates to SSHClientManager). */
  async getSSHClient(serverName: string): Promise<Client> {
    const cfg = this.serverConfigs[serverName];
    if (!cfg) {
      throw new Error(
        `Server '${serverName}' not found in config. ` +
        `Available: ${Object.keys(this.serverConfigs).join(", ")}`,
      );
    }
    return this.sshManager.getClient(serverName, cfg);
  }

  /** Expose the underlying pool manager for tools that need richer query methods. */
  getDatabaseManager(): DatabaseConnectionManager {
    return this.dbManager;
  }

  /** Release all resources. */
  destroy(): void {
    this.dbManager.destroy();
    this.sshManager.destroy();
  }
}
