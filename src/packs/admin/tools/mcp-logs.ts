import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { getRecentLogs } from "@/core/logging";

export const mcpLogsSchema = {
  count: z.number().optional().describe("Number of recent logs to return (default: 20, max: 100)"),
  filter: z
    .enum(["all", "errors", "success"])
    .optional()
    .describe("Filter logs by status (default: all)"),
};

export async function handleMcpLogs(params: {
  count?: number;
  filter?: "all" | "errors" | "success";
}) {
  let logs = getRecentLogs(params.count || 20);

  if (params.filter === "errors") {
    logs = logs.filter((l) => l.status === "error");
  } else if (params.filter === "success") {
    logs = logs.filter((l) => l.status === "success");
  }

  if (logs.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No logs found. Logs are in-memory and reset on cold start.",
        },
      ],
    };
  }

  const lines = logs.map((l) => {
    const icon = l.status === "success" ? "OK" : "ERR";
    const time = new Date(l.timestamp).toLocaleTimeString(getInstanceConfig().locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: getInstanceConfig().timezone,
    });
    const err = l.error ? ` — ${l.error}` : "";
    return `[${icon}] ${time} ${l.tool} (${l.durationMs}ms)${err}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Recent tool calls (${logs.length}):\n\n${lines.join("\n")}`,
      },
    ],
  };
}
