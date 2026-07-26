import { Type } from "@sinclair/typebox";
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AppConfig, LogQueryResult } from "../types";
import type { ConnectionManager } from "../connections";

export function createQueryLogsTool(
  config: AppConfig,
  connections: ConnectionManager
) {
  return defineTool({
    name: "query_logs",
    label: "Query Logs",
    description:
      "SSH into a server and tail/grep log files. " +
      "Use this to check application logs, error logs, or access logs for a microservice.",
    parameters: Type.Object({
      service: Type.String({ description: "Service name from config.json services" }),
      logType: Type.Optional(Type.String({
        description: "Log type: 'app' (default), 'error', or 'access'",
        default: "app",
      })),
      keyword: Type.Optional(Type.String({
        description: "Grep keyword to filter log lines (optional)",
      })),
      tail: Type.Optional(Type.Number({
        description: "Number of lines to tail (default: 200, max: 1000)",
        default: 200,
      })),
    }),
    async execute(
      _toolCallId: string,
      params: { service: string; logType?: string; keyword?: string; tail?: number },
      _signal?: AbortSignal,
      _onUpdate?: any,
      _ctx?: any,
    ) {
      try {
        const svc = config.services[params.service];
        if (!svc) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: service '${params.service}' not found in config. Available: ${Object.keys(config.services).join(", ")}`,
            }],
            details: undefined,
          };
        }

        // Determine log file path
        let logPath: string;
        const logType = params.logType ?? "app";
        if (logType === "error" && svc.errorLogPath) {
          logPath = svc.errorLogPath;
        } else if (logType === "access" && svc.accessLogPath) {
          logPath = svc.accessLogPath;
        } else {
          logPath = svc.logPath;
        }

        const tail = Math.min(params.tail ?? 200, 1000);

        const sshClient = await connections.getSSHClient(svc.server);
        const serverCfg = config.servers[svc.server];

        const start = Date.now();

        const result = await new Promise<string>((resolve, reject) => {
          let cmd = `tail -n ${tail} ${logPath}`;
          if (params.keyword) {
            cmd += ` | grep -i '${params.keyword.replace(/'/g, "'\\''")}'`;
          }

          sshClient.exec(cmd, (err, stream) => {
            if (err) {
              reject(new Error(`SSH exec failed: ${err.message}`));
              return;
            }

            let stdout = "";
            let stderr = "";

            stream.on("data", (data: Buffer) => { stdout += data.toString(); });
            stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

            stream.on("close", (code: number) => {
              if (code !== 0 && stderr) {
                reject(new Error(`Remote command failed (code ${code}): ${stderr.trim()}`));
              } else {
                resolve(stdout);
              }
            });
          });
        });

        const elapsed = `${((Date.now() - start) / 1000).toFixed(2)}s`;
        const lines = result.trim().split("\n").filter(l => l.length > 0);

        const logResult: LogQueryResult = {
          service: params.service,
          server: serverCfg.host,
          logFile: logPath,
          lines,
          lineCount: lines.length,
          elapsed,
        };

        return {
          content: [{
            type: "text" as const,
            text: [
              `## ${params.service} (${serverCfg.host})`,
              `Log: ${logPath}`,
              `Lines: ${lines.length} (${elapsed})`,
              params.keyword ? `Filter: "${params.keyword}"` : "",
              "",
              "```",
              lines.length > 50
                ? lines.slice(0, 50).join("\n") + `\n... and ${lines.length - 50} more lines`
                : lines.join("\n"),
              "```",
            ].filter(l => l !== "").join("\n"),
          }],
          details: logResult,
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Log query error: ${err.message}`,
          }],
          details: undefined,
        };
      }
    },
  });
}
