import { composeRequestPipeline, rehydrateStep, rateLimitStep } from "@/core/pipeline";
import type { PipelineContext } from "@/core/pipeline";
import { OAuthError, registerClient } from "@/core/oauth";
import { jsonResponse, oauthErrorResponse, preflight } from "@/core/oauth-http";

/** OAU-04 — RFC 7591 Dynamic Client Registration (public clients). */
async function postHandler(ctx: PipelineContext): Promise<Response> {
  try {
    const text = await ctx.request.text();
    if (text.length > 16 * 1024) throw new OAuthError("invalid_client_metadata", "body too large");
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new OAuthError("invalid_client_metadata", "body must be a JSON object");
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new OAuthError("invalid_client_metadata", "body must be a JSON object");
    }
    const client = await registerClient(meta);
    return jsonResponse(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201
    );
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const POST = composeRequestPipeline(
  [rehydrateStep, rateLimitStep({ scope: "oauth-register", keyFrom: "ip", limit: 10 })],
  postHandler
);

export function OPTIONS(): Response {
  return preflight();
}
