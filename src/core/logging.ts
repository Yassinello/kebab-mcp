export interface ToolLog {
  tool: string;
  durationMs: number;
  status: "success" | "error";
  error?: string;
  timestamp: string;
}

// In-memory ring buffer for recent logs (survives across requests in same serverless instance)
const LOG_BUFFER_SIZE = 100;
const recentLogs: ToolLog[] = [];

export function logToolCall(log: ToolLog) {
  recentLogs.push(log);
  if (recentLogs.length > LOG_BUFFER_SIZE) {
    recentLogs.shift();
  }

  const emoji = log.status === "success" ? "✓" : "✗";
  const errorSuffix = log.error ? ` — ${log.error}` : "";
  console.log(
    `[MyMCP] ${emoji} ${log.tool} (${log.durationMs}ms)${errorSuffix}`
  );
}

export function getRecentLogs(count?: number): ToolLog[] {
  const n = Math.min(count || 20, LOG_BUFFER_SIZE);
  return recentLogs.slice(-n);
}

export function withLogging<TParams, TResult>(
  toolName: string,
  handler: (params: TParams) => Promise<TResult>
): (params: TParams) => Promise<TResult> {
  return async (params: TParams) => {
    const start = Date.now();
    try {
      const result = await handler(params);
      logToolCall({
        tool: toolName,
        durationMs: Date.now() - start,
        status: "success",
        timestamp: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logToolCall({
        tool: toolName,
        durationMs: Date.now() - start,
        status: "error",
        error: message,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  };
}
