import { composeRequestPipeline, rehydrateStep, rateLimitStep } from "@/core/pipeline";
import type { PipelineContext } from "@/core/pipeline";
import { revokeToken } from "@/core/oauth";
import { oauthErrorResponse, preflight, readForm, CORS_HEADERS } from "@/core/oauth-http";

/** OAU-09 — RFC 7009 token revocation (always 200 for unknown tokens). */
async function postHandler(ctx: PipelineContext): Promise<Response> {
  try {
    const form = await readForm(ctx.request);
    const token = form.get("token");
    if (token) await revokeToken(token);
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const POST = composeRequestPipeline(
  [rehydrateStep, rateLimitStep({ scope: "oauth-revoke", keyFrom: "ip", limit: 30 })],
  postHandler
);

export function OPTIONS(): Response {
  return preflight();
}
