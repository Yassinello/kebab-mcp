import { composeRequestPipeline, rehydrateStep, rateLimitStep } from "@/core/pipeline";
import type { PipelineContext } from "@/core/pipeline";
import { OAuthError, exchangeCode, refreshTokens } from "@/core/oauth";
import { jsonResponse, oauthErrorResponse, preflight, readForm } from "@/core/oauth-http";

/** OAU-07 — token endpoint (authorization_code with PKCE, refresh_token). */
async function postHandler(ctx: PipelineContext): Promise<Response> {
  try {
    const form = await readForm(ctx.request);
    const grant = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
    if (grant === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      const verifier = form.get("code_verifier");
      if (!code || !redirectUri || !verifier) {
        throw new OAuthError(
          "invalid_request",
          "code, redirect_uri and code_verifier are required"
        );
      }
      return jsonResponse(
        await exchangeCode({
          code,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: form.get("resource") ?? undefined,
        })
      );
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token");
      if (!rt) throw new OAuthError("invalid_request", "refresh_token is required");
      return jsonResponse(await refreshTokens({ refresh_token: rt, client_id: clientId }));
    }
    return jsonResponse(
      { error: "unsupported_grant_type", error_description: "unsupported grant_type" },
      400
    );
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const POST = composeRequestPipeline(
  [rehydrateStep, rateLimitStep({ scope: "oauth-token", keyFrom: "ip", limit: 60 })],
  postHandler
);

export function OPTIONS(): Response {
  return preflight();
}
