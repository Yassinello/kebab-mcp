import { createMcpHandler } from "mcp-handler";
import { withLogging } from "@/core/logging";
import { checkMcpAuth } from "@/core/auth";
import { getEnabledPacks, logRegistryState } from "@/core/registry";

const mcpHandler = createMcpHandler(
  (server) => {
    const enabledPacks = getEnabledPacks();
    logRegistryState();

    for (const pack of enabledPacks) {
      for (const tool of pack.manifest.tools) {
        server.tool(
          tool.name,
          tool.description,
          tool.schema,
          withLogging(tool.name, async (params) => tool.handler(params))
        );
      }
    }
  },
  {
    serverInfo: {
      name: "MyMCP",
      version: "1.0.0",
    },
  },
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

async function handler(request: Request): Promise<Response> {
  const authError = checkMcpAuth(request);
  if (authError) return authError;
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
