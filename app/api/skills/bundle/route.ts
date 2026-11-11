import {
  composeRequestPipeline,
  rehydrateStep,
  authStep,
  rateLimitStep,
  type PipelineContext,
} from "@/core/pipeline";
import { primeSkillsCache } from "@/connectors/skills/store";
import { exportLibraryZip, zipResponse } from "@/connectors/skills/lib/exporter";
import {
  resolveTokenConnectorScope,
  resolveTokenSkillScope,
  isConnectorAllowed,
} from "@/core/token-scope";

/**
 * Skills v2 §7 / channel C — the whole skills library (scoped to the
 * caller's MCP token tags) as an Agent Skills zip, for native installs:
 *
 *   curl -fsS -H "Authorization: Bearer $KEBAB_TOKEN" https://<host>/api/skills/bundle -o skills.zip
 *
 * MCP-token auth (Authorization header only — a query-string token would
 * leak into access logs). Rate-limited like the MCP endpoint.
 */
async function handler(ctx: PipelineContext): Promise<Response> {
  const connectorScope = await resolveTokenConnectorScope(ctx.tokenId);
  if (!isConnectorAllowed(connectorScope, "skills")) {
    return new Response("Forbidden", { status: 403 });
  }
  await primeSkillsCache();
  const scope = await resolveTokenSkillScope(ctx.tokenId);
  const { zip, count } = await exportLibraryZip(scope);
  return zipResponse(zip, "kebab-skills.zip", { "X-Kebab-Skill-Count": String(count) });
}

export const GET = composeRequestPipeline(
  [rehydrateStep, authStep("mcp"), rateLimitStep({ scope: "mcp", keyFrom: "token" })],
  handler
);
