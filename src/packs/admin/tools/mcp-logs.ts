import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { getRecentLogs, getDurableLogs } from "@/core/logging";

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
  const durableEnabled = process.env.MYMCP_DURABLE_LOGS === "true";
  const filter = params.filter ?? "all";

  let logs;
  let source: "memory" | "durable";

  if (durableEnabled) {
    logs = await getDurableLogs(params.count || 20, filter);
    source = "durable";
  } else {
    let memLogs = getRecentLogs(params.count || 20);
    if (filter === "errors") {
      memLogs = memLogs.filter((l) => l.status === "error");
    } else if (filter === "success") {
      memLogs = memLogs.filter((l) => l.status === "success");
    }
    logs = memLogs;
    source = "memory";
  }

  if (logs.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            source === "durable"
              ? "No logs found in durable store."
              : "No logs found. Logs are in-memory and reset on cold start.",
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
        text: `Recent tool calls (${logs.length}) [source: ${source}]:\n\n${lines.join("\n")}`,
      },
    ],
  };
}
