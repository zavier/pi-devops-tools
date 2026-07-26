/**
 * SSH client — lazy connection management for remote server access.
 *
 * Used by query-logs to tail/grep log files on remote servers.
 * Each SSH connection is lazily created and cached by server name.
 */

import { Client } from "ssh2";
import { readFileSync } from "node:fs";

export interface SSHServerConfig {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

export class SSHClientManager {
  private clients = new Map<string, Client>();

  async getClient(serverName: string, config: SSHServerConfig): Promise<Client> {
    const existing = this.clients.get(serverName);
    if (existing) return existing;

    const client = new Client();
    const keyPath = config.keyPath.replace(/^~/, process.env.HOME || "/root");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error(`SSH connection to ${serverName} timed out after 10s`));
      }, 10000);

      client.on("ready", () => {
        clearTimeout(timeout);
        resolve();
      });

      client.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`SSH connection to ${serverName} failed: ${err.message}`));
      });

      client.connect({
        host: config.host,
        port: config.port,
        username: config.user,
        privateKey: readFileSync(keyPath, "utf-8"),
        readyTimeout: 10000,
      });
    });

    this.clients.set(serverName, client);
    return client;
  }

  destroy(): void {
    for (const [, client] of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}
