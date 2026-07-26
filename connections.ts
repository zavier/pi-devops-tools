import mysql from "mysql2/promise";
import { Client } from "ssh2";
import { readFileSync } from "node:fs";
import type { AppConfig } from "./types";

export class ConnectionManager {
  private mysqlPools = new Map<string, mysql.Pool>();
  private sshClients = new Map<string, Client>();

  constructor(private config: AppConfig) {}

  getMySQLPool(cluster: string): mysql.Pool {
    const existing = this.mysqlPools.get(cluster);
    if (existing) return existing;

    const dbConfig = this.config.databases[cluster];
    if (!dbConfig) {
      throw new Error(
        `Database cluster '${cluster}' not found in config. ` +
        `Available: ${Object.keys(this.config.databases).join(", ")}`
      );
    }

    const pool = mysql.createPool({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      connectTimeout: 30000,
      waitForConnections: true,
      connectionLimit: 5,
      // Pi Extension 是长期运行的，不需要 idle 超时回收
      enableKeepAlive: true,
      keepAliveInitialDelay: 60000,
    });

    this.mysqlPools.set(cluster, pool);
    return pool;
  }

  async getSSHClient(serverName: string): Promise<Client> {
    const existing = this.sshClients.get(serverName);
    if (existing) return existing;

    const serverConfig = this.config.servers[serverName];
    if (!serverConfig) {
      throw new Error(
        `Server '${serverName}' not found in config. ` +
        `Available: ${Object.keys(this.config.servers).join(", ")}`
      );
    }

    const client = new Client();
    const keyPath = serverConfig.keyPath.replace(/^~/, process.env.HOME || "/root");

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
        host: serverConfig.host,
        port: serverConfig.port,
        username: serverConfig.user,
        privateKey: readFileSync(keyPath, "utf-8"),
        readyTimeout: 10000,
      });
    });

    this.sshClients.set(serverName, client);
    return client;
  }

  destroy(): void {
    for (const [name, pool] of this.mysqlPools) {
      pool.end();
      this.mysqlPools.delete(name);
    }
    for (const [name, client] of this.sshClients) {
      client.end();
      this.sshClients.delete(name);
    }
  }
}
