import { authorizationServerMetadata, publicOrigin } from "@/core/oauth";
import { jsonResponse, preflight } from "@/core/oauth-http";

/** OAU-02 — RFC 8414 authorization server metadata. */
export function GET(request: Request): Response {
  return jsonResponse(authorizationServerMetadata(publicOrigin(request)), 200, {
    "Cache-Control": "public, max-age=3600",
  });
}

export function OPTIONS(): Response {
  return preflight();
}
