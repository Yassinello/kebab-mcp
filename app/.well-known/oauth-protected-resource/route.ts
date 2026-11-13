import { protectedResourceMetadata, publicOrigin } from "@/core/oauth";
import { jsonResponse, preflight } from "@/core/oauth-http";

/** OAU-01 — RFC 9728 protected resource metadata for /api/mcp. */
export function GET(request: Request): Response {
  return jsonResponse(protectedResourceMetadata(publicOrigin(request)), 200, {
    "Cache-Control": "public, max-age=3600",
  });
}

export function OPTIONS(): Response {
  return preflight();
}
